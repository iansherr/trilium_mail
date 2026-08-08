/*
 * Gmail Ingest backend script.
 *
 * The same source is installed twice by the package manager: once as an hourly
 * backend script and once as a custom request handler. Scheduled executions
 * enter runIngest(); HTTP executions enter handleRequest().
 */

const PACKAGE_ID = "iansherr/gmail-ingest";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const OAUTH_SCOPE = "openid email profile https://www.googleapis.com/auth/gmail.modify";
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/* Access tokens keyed by account email. The script is evaluated per execution, so this cache
 * lives for exactly one run, which is the scope it is meant to cover. */
const accessTokens = new Map();

/*
 * Trilium evaluates this file with an `api` object in scope, so its absence means the file was
 * loaded by the test suite instead. Guarding the entrypoint on it is what lets the pure helpers
 * below be required and tested directly; see the export at the end of the file.
 */
if (typeof api !== "undefined") {
    if (api.req && api.res) {
        handleRequest().catch((error) => {
            if (!api.res.headersSent) api.res.status(500).json({ error: errorMessage(error) });
        });
    } else {
        runIngest().catch((error) => api.log("Gmail Ingest failed:", errorMessage(error)));
    }
}

async function handleRequest() {
    const route = api.pathParams?.[0] || "";

    // Custom endpoints are reachable by anyone who can reach the host, so every route
    // that acts on this instance requires the manual sync endpoint secret. oauth/callback
    // is the exception: Google controls that request and cannot carry the secret, so it is
    // gated by the short-lived state value that only an authorised oauth/start can mint.
    if (route === "oauth/callback") {
        await finishOAuth();
        return;
    }
    if (route === "oauth/start" || route === "process") {
        if (api.req.method !== "POST") {
            api.res.status(405).json({ error: "This Gmail Ingest route requires a POST request." });
            return;
        }
        const settings = readSettings();
        const body = api.req.body && typeof api.req.body === "object" ? api.req.body : {};
        if (!secretMatches(settings.endpointSecret, body.secret)) {
            api.res.status(401).json({ error: "Invalid manual sync endpoint secret." });
            return;
        }
        if (route === "oauth/start") await startOAuth(settings, body);
        else api.res.json(await runIngest());
        return;
    }

    api.res.status(404).json({ error: "Unknown Gmail Ingest route." });
}

async function startOAuth(settings, body) {
    requireOAuthSettings(settings);

    const state = randomState();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    settings.manifest.setLabel("gmailOauthState", state);
    settings.manifest.setLabel("gmailOauthStateExpiresAt", String(expiresAt));

    const redirectUri = getRedirectUri(settings);
    const accountHint = typeof body.account === "string" ? body.account.trim() : "";
    const params = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: OAUTH_SCOPE,
        state
    });
    if (accountHint) params.set("login_hint", accountHint);

    api.res.json({ authorizeUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`, redirectUri });
}

async function finishOAuth() {
    const settings = readSettings();
    requireOAuthSettings(settings);

    const error = typeof api.req.query?.error === "string" ? api.req.query.error : "";
    if (error) throw new Error(`Google OAuth was not completed: ${error}`);

    const state = String(api.req.query?.state || "");
    const expectedState = settings.manifest.getOwnedLabelValue("gmailOauthState") || "";
    const expiresAt = Number(settings.manifest.getOwnedLabelValue("gmailOauthStateExpiresAt") || 0);
    if (!state || !expectedState || state !== expectedState || !expiresAt || Date.now() > expiresAt) {
        throw new Error("The Gmail OAuth state is missing, invalid, or expired. Start the connection again.");
    }

    const code = String(api.req.query?.code || "");
    if (!code) throw new Error("Google did not return an authorization code.");

    const redirectUri = getRedirectUri(settings);
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: settings.clientId,
            client_secret: settings.clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code"
        })
    });
    const tokens = await readJsonResponse(tokenResponse, "Google token exchange");
    if (!tokens.access_token) throw new Error("Google did not return an access token.");

    const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
        headers: { authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await readJsonResponse(profileResponse, "Google account profile");
    const email = String(profile.email || "").trim().toLowerCase();
    if (!email) throw new Error("Google did not return the account email address.");

    const accounts = settings.accounts.filter((account) => account.email !== email);
    const previous = settings.accounts.find((account) => account.email === email);
    const refreshToken = String(tokens.refresh_token || previous?.refreshToken || "");
    if (!refreshToken) {
        throw new Error("Google did not return a refresh token. Reconnect this account with prompt=consent enabled.");
    }
    accounts.push({ email, refreshToken });
    accounts.sort((left, right) => left.email.localeCompare(right.email));
    settings.manifest.setLabel("packageSetting:accounts", JSON.stringify(accounts));
    settings.manifest.removeLabel("gmailOauthState");
    settings.manifest.removeLabel("gmailOauthStateExpiresAt");

    api.res.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Gmail connected</title><p>Connected <strong>${escapeHtml(email)}</strong> to Trilium Gmail Ingest. You can close this window.</p>`);
}

async function runIngest() {
    const settings = readSettings();
    if (!settings.manifest) throw new Error("Gmail Ingest package manifest note was not found.");
    if (!settings.accounts.length) {
        const summary = { imported: 0, skipped: 0, failed: 0, accounts: 0, message: "No Gmail accounts are connected." };
        saveRunSummary(settings.manifest, summary);
        return summary;
    }

    const lockToken = acquireRunLock(settings.manifest);
    if (!lockToken) {
        return { imported: 0, skipped: 0, failed: 0, accounts: settings.accounts.length, locked: true, message: "An import is already running." };
    }

    const summary = { imported: 0, skipped: 0, failed: 0, accounts: settings.accounts.length, errors: [] };
    try {
        for (const account of settings.accounts) {
            try {
                const result = await ingestAccount(settings, account);
                summary.imported += result.imported;
                summary.skipped += result.skipped;
                summary.failed += result.failed;
                summary.errors.push(...result.errors);
            } catch (error) {
                summary.failed += 1;
                summary.errors.push(`${account.email}: ${errorMessage(error)}`);
                api.log(`Gmail account ${account.email} failed:`, errorMessage(error));
            }
        }
        saveRunSummary(settings.manifest, summary);
        return summary;
    } finally {
        releaseRunLock(settings.manifest, lockToken);
    }
}

/*
 * The hourly worker and a dashboard "Sync now" can start in the same window, so the lock is
 * claimed inside a transaction rather than with a separate read and write. Each run stores a
 * unique token and only releases a lock that still carries its own token, so a run that loses
 * the race can never drop the lock the winner is holding.
 */
function acquireRunLock(manifest) {
    const token = `${Date.now()}:${api.randomString(12)}`;
    const acquired = api.transactional(() => {
        const current = String(manifest.getOwnedLabelValue("gmailRunLock") || "");
        const startedAt = Number(current.split(":")[0] || 0);
        if (current && startedAt && Date.now() - startedAt < LOCK_TIMEOUT_MS) return false;
        manifest.setLabel("gmailRunLock", token);
        return true;
    });
    return acquired ? token : "";
}

function releaseRunLock(manifest, token) {
    if (manifest.getOwnedLabelValue("gmailRunLock") === token) manifest.removeLabel("gmailRunLock");
}

async function ingestAccount(settings, account) {
    const result = { imported: 0, skipped: 0, failed: 0, errors: [] };
    const labels = await gmailLabels(settings, account);
    const ingestLabel = String(settings.ingestLabel || "trilium-ingest").trim();
    const doneLabel = String(settings.doneLabel || "trilium-done").trim();
    if (!ingestLabel || !doneLabel || ingestLabel === doneLabel) {
        throw new Error("Gmail ingest and done labels must both be set and must be different.");
    }
    const ingestLabelId = labels.find((label) => label.name === ingestLabel)?.id;
    if (!ingestLabelId) {
        api.log(`Gmail label '${ingestLabel}' was not found for ${account.email}; nothing to import.`);
        return result;
    }
    const doneLabelId = await ensureLabel(settings, account, labels, doneLabel);
    const messageIds = await listMessageIds(settings, account, ingestLabel);

    for (const messageId of messageIds) {
        try {
            const existing = api.getNotesWithLabel("gmailMessageId", messageId).find((note) => !note.isArchived);
            if (existing) {
                await modifyMessage(settings, account, messageId, { removeLabelIds: [ingestLabelId], addLabelIds: [doneLabelId] });
                result.skipped += 1;
                continue;
            }

            const message = await gmailRequest(settings, account, `/messages/${encodeURIComponent(messageId)}?format=full`);
            await importMessage(settings, account, message);
            await modifyMessage(settings, account, messageId, { removeLabelIds: [ingestLabelId], addLabelIds: [doneLabelId] });
            result.imported += 1;
        } catch (error) {
            result.failed += 1;
            result.errors.push(`${account.email}/${messageId}: ${errorMessage(error)}`);
            api.log(`Message ${messageId} for ${account.email} was left labeled ${ingestLabel}:`, errorMessage(error));
        }
    }
    return result;
}

async function listMessageIds(settings, account, ingestLabel) {
    const ids = [];
    let pageToken = "";
    const maxMessages = Math.min(100, Math.max(1, Number(settings.maxMessages) || 25));
    do {
        const params = new URLSearchParams({
            q: `label:${quoteGmailLabel(ingestLabel)}`,
            maxResults: String(Math.min(100, maxMessages - ids.length))
        });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await gmailRequest(settings, account, `/messages?${params.toString()}`);
        for (const message of page.messages || []) ids.push(message.id);
        pageToken = page.nextPageToken || "";
    } while (pageToken && ids.length < maxMessages);
    return ids.slice(0, maxMessages);
}

async function importMessage(settings, account, message) {
    const parsed = await parseMessage(settings, account, message);
    const parentNoteId = String(settings.targetNoteId || "root").trim() || "root";
    if (!api.getNote(parentNoteId)) throw new Error(`Import parent note '${parentNoteId}' was not found.`);

    const title = parsed.subject || "(no subject)";
    const metadata = [
        `<p><strong>From:</strong> ${escapeHtml(parsed.from || "")}</p>`,
        `<p><strong>To:</strong> ${escapeHtml(parsed.to || "")}</p>`,
        parsed.cc ? `<p><strong>Cc:</strong> ${escapeHtml(parsed.cc)}</p>` : "",
        `<p><strong>Date:</strong> ${escapeHtml(parsed.date || "")}</p>`,
        `<p><strong>Account:</strong> ${escapeHtml(account.email)}</p>`,
        `<p><a href="${escapeAttribute(parsed.webUrl)}">Open in Gmail</a></p>`,
        "<hr>"
    ].join("");
    const initialContent = `${metadata}${parsed.html || `<pre>${escapeHtml(parsed.text || "")}</pre>`}`;
    const attributes = [
        { type: "label", name: "gmailIngested" },
        { type: "label", name: "gmailMessageId", value: message.id },
        { type: "label", name: "gmailThreadId", value: message.threadId || "" },
        { type: "label", name: "gmailAccount", value: account.email },
        { type: "label", name: "gmailImportedAt", value: new Date().toISOString() }
    ];

    api.transactional(() => {
        const created = api.createNewNote({
            parentNoteId,
            title,
            type: "text",
            mime: "text/html",
            content: initialContent,
            attributes
        });
        const attachmentLinks = [];
        const cidMap = new Map();

        for (const attachment of parsed.attachments) {
            if (attachment.content.byteLength > settings.maxAttachmentBytes) {
                parsed.warnings.push(`Skipped ${attachment.title}: it is ${formatBytes(attachment.content.byteLength)}, over the configured limit.`);
                continue;
            }
            let saved;
            try {
                saved = created.note.saveAttachment({
                    role: attachment.mime.startsWith("image/") ? "image" : "file",
                    mime: attachment.mime || "application/octet-stream",
                    title: attachment.title || "attachment",
                    content: attachment.content
                });
            } catch (error) {
                parsed.warnings.push(`Could not save ${attachment.title}: ${errorMessage(error)}`);
                continue;
            }
            const attachmentId = saved.attachmentId;
            if (attachment.contentId && attachmentId) cidMap.set(normalizeContentId(attachment.contentId), { attachmentId, title: attachment.title });
            if (attachmentId) {
                const encodedTitle = encodeURIComponent(attachment.title || "attachment");
                const href = `api/attachments/${attachmentId}/download`;
                attachmentLinks.push(attachment.mime.startsWith("image/")
                    ? `<li><img src="api/attachments/${attachmentId}/image/${encodedTitle}" alt="${escapeAttribute(attachment.title)}" style="max-width: 100%;"><br><a href="${href}">${escapeHtml(attachment.title)}</a></li>`
                    : `<li><a href="${href}">${escapeHtml(attachment.title)}</a></li>`);
            }
        }

        let content = initialContent;
        for (const [contentId, saved] of cidMap) {
            const url = `api/attachments/${saved.attachmentId}/image/${encodeURIComponent(saved.title || "image")}`;
            content = content.replaceAll(`cid:${contentId}`, url);
        }
        if (parsed.warnings.length) content += `<hr><p><strong>Import warnings</strong></p><ul>${parsed.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;
        if (attachmentLinks.length) content += `<hr><p><strong>Attachments</strong></p><ul>${attachmentLinks.join("")}</ul>`;
        created.note.setContent(content);
    });
}

async function parseMessage(settings, account, message) {
    const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
    const parts = [];
    walkParts(message.payload || {}, parts);
    let html = parts.find((part) => part.kind === "body" && part.mime === "text/html" && part.data)?.data || "";
    const text = parts.find((part) => part.kind === "body" && part.mime === "text/plain" && part.data)?.data || "";
    if (!html && !text && message.payload?.body?.data) {
        if (message.payload.mimeType === "text/html") html = decodeBase64Url(message.payload.body.data).toString("utf8");
    }
    html = sanitizeHtml(html);

    const attachments = [];
    const warnings = [];
    for (const part of parts.filter((candidate) => candidate.kind === "attachment")) {
        // Gmail reports the part size in the message metadata, so oversized attachments are
        // skipped before they are downloaded rather than after they are already in memory.
        if (part.size && part.size > settings.maxAttachmentBytes) {
            warnings.push(`Skipped ${part.filename || "an attachment"}: it is ${formatBytes(part.size)}, over the configured limit.`);
            continue;
        }
        try {
            const encoded = part.data || (part.attachmentId ? (await gmailRequest(settings, account, `/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.attachmentId)}`)).data : "");
            const content = encoded instanceof Uint8Array ? encoded : decodeBase64Url(encoded || "");
            attachments.push({
                title: part.filename || "attachment",
                mime: part.mime || "application/octet-stream",
                contentId: part.contentId,
                content
            });
        } catch (error) {
            warnings.push(`Could not download ${part.filename || "an attachment"}: ${errorMessage(error)}`);
        }
    }

    return {
        subject: headers.subject || "",
        from: headers.from || "",
        to: headers.to || "",
        cc: headers.cc || "",
        date: headers.date || (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : ""),
        html,
        text,
        attachments,
        warnings,
        webUrl: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.email)}#all/${encodeURIComponent(message.id)}`
    };
}

function walkParts(part, result) {
    const body = part.body || {};
    const filename = String(part.filename || "");
    const headers = Object.fromEntries((part.headers || []).map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
    const isAttachment = Boolean(filename || body.attachmentId);
    // An attached .html or .txt file is still an attachment: it must not become a candidate
    // for the message body, or it would replace the real body of a multipart/mixed message.
    if (!isAttachment && (part.mimeType === "text/html" || part.mimeType === "text/plain")) {
        result.push({ kind: "body", mime: part.mimeType, data: body.data ? decodeBase64Url(body.data).toString("utf8") : "" });
    }
    if (isAttachment) {
        result.push({
            kind: "attachment",
            mime: String(part.mimeType || "application/octet-stream").toLowerCase(),
            filename,
            attachmentId: body.attachmentId,
            size: Number(body.size || 0),
            data: body.data ? decodeBase64Url(body.data) : null,
            contentId: headers["content-id"] || ""
        });
    }
    for (const child of part.parts || []) walkParts(child, result);
}

async function gmailLabels(settings, account) {
    const response = await gmailRequest(settings, account, "/labels");
    return response.labels || [];
}

async function ensureLabel(settings, account, labels, name) {
    const existing = labels.find((label) => label.name === name);
    if (existing) return existing.id;
    const created = await gmailRequest(settings, account, "/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" })
    });
    return created.id;
}

async function modifyMessage(settings, account, messageId, body) {
    await gmailRequest(settings, account, `/messages/${encodeURIComponent(messageId)}/modify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

async function gmailRequest(settings, account, path, init = {}) {
    const accessToken = await getAccessToken(settings, account);
    const headers = { ...(init.headers || {}), authorization: `Bearer ${accessToken}` };
    let response = await fetch(`${GMAIL_API}${path}`, { ...init, headers });
    if (response.status === 401) {
        const retryToken = await getAccessToken(settings, account, true);
        response = await fetch(`${GMAIL_API}${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${retryToken}` } });
    }
    return readJsonResponse(response, "Gmail API request");
}

/*
 * A run issues two Gmail calls per message, and exchanging the refresh token on each of them
 * would mean dozens of token requests per account per hour, which Google rate-limits. The
 * access token is reused for its advertised lifetime; the 401 path above forces a refresh.
 */
async function getAccessToken(settings, account, force = false) {
    const cached = accessTokens.get(account.email);
    if (!force && cached && Date.now() < cached.expiresAt) return cached.token;

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: settings.clientId,
            client_secret: settings.clientSecret,
            refresh_token: account.refreshToken,
            grant_type: "refresh_token"
        })
    });
    const tokens = await readJsonResponse(response, `Refresh token for ${account.email}`);
    if (!tokens.access_token) throw new Error(`Google returned no access token for ${account.email}.`);

    const lifetimeSeconds = Math.max(0, Number(tokens.expires_in) || 0);
    accessTokens.set(account.email, {
        token: tokens.access_token,
        expiresAt: Date.now() + Math.max(0, lifetimeSeconds - 60) * 1000
    });
    return tokens.access_token;
}

async function readJsonResponse(response, operation) {
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) {
        const detail = payload.error?.message || payload.error_description || payload.raw || response.statusText;
        throw new Error(`${operation} failed (${response.status}): ${detail}`);
    }
    return payload;
}

function readSettings() {
    const manifest = api.searchForNotes(`#packageOwner=${PACKAGE_ID}`, { includeArchivedNotes: false }).find((note) => note.getOwnedLabelValue("packageArtifact") === "manifest");
    const value = (key, fallback) => {
        const stored = manifest?.getOwnedLabelValue(`packageSetting:${key}`);
        if (stored === null || stored === undefined || stored === "") return fallback;
        return parseJson(stored, stored);
    };
    const accounts = value("accounts", []);
    return {
        manifest,
        clientId: String(value("clientId", "")).trim(),
        clientSecret: String(value("clientSecret", "")).trim(),
        redirectUri: String(value("redirectUri", "")).trim(),
        targetNoteId: String(value("targetNoteId", "root")).trim() || "root",
        ingestLabel: String(value("ingestLabel", "trilium-ingest")).trim(),
        doneLabel: String(value("doneLabel", "trilium-done")).trim(),
        maxMessages: Math.min(100, Math.max(1, Number(value("maxMessages", 25)) || 25)),
        maxAttachmentBytes: Math.max(1, Number(value("maxAttachmentBytes", 26214400)) || 26214400),
        endpointSecret: String(value("endpointSecret", "")),
        accounts: Array.isArray(accounts) ? accounts.filter((account) => account?.email && account?.refreshToken) : []
    };
}

function requireOAuthSettings(settings) {
    if (!settings.manifest) throw new Error("Gmail Ingest package manifest note was not found.");
    if (!settings.clientId || !settings.clientSecret) throw new Error("Set the Google OAuth client ID and client secret in Plugins settings first.");
}

/*
 * Trilium is commonly served behind a TLS-terminating reverse proxy, where req.protocol reads
 * as http unless Express is configured to trust the proxy. Inferring https from that would send
 * Google a redirect_uri it rejects, so the forwarded headers win where they can be believed.
 *
 * They are only believed when Express trusts the proxy, which is the same control req.protocol
 * honours: on an instance reachable directly, the headers are set by whoever is calling, and
 * reading them anyway would let that caller choose the redirect_uri handed back here. Setting the
 * OAuth redirect URI explicitly avoids the guess entirely, and is the fix when the proxy in front
 * of Trilium sends the headers without Trilium being configured to trust it.
 */
function getRedirectUri(settings) {
    if (settings.redirectUri) return settings.redirectUri;
    const trustsProxy = Boolean(api.req.app?.get?.("trust proxy"));
    const firstValue = (header) => (trustsProxy ? String(api.req.get(header) || "").split(",")[0].trim() : "");
    const protocol = firstValue("x-forwarded-proto") || api.req.protocol || "https";
    const host = firstValue("x-forwarded-host") || api.req.get("host") || "";
    const currentPath = String(api.req.originalUrl || api.req.url || "").split("?")[0];
    return `${protocol}://${host}${currentPath.replace(/\/oauth\/(?:start|callback)$/, "/oauth/callback")}`;
}

function saveRunSummary(manifest, summary) {
    manifest.setLabel("gmailLastRunAt", new Date().toISOString());
    manifest.setLabel("gmailLastRunSummary", JSON.stringify(summary));
}

function quoteGmailLabel(label) {
    return /\s/.test(label) ? `"${label.replaceAll('"', '\\"')}"` : label;
}

function decodeBase64Url(value) {
    const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return Buffer.from(padded, "base64");
}

function normalizeContentId(value) {
    return String(value || "").replace(/^<|>$/g, "").trim();
}

/*
 * Message bodies are untrusted HTML written straight into a note, so the sanitizer rebuilds the
 * markup from an allowlist rather than trying to strip the dangerous parts out of it. Anything
 * not recognised is dropped, which fails closed on the markup a stripping pass tends to miss:
 * unclosed tags, whitespace around attribute "=", entity-encoded URL schemes. This is not a full
 * HTML5 parser, but rebuilding means unrecognised constructs cannot survive into the output.
 */
const ALLOWED_TAGS = new Set([
    "a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup", "dd",
    "div", "dl", "dt", "em", "figcaption", "figure", "font", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul"
]);
const ALLOWED_ATTRIBUTES = new Set([
    "align", "alt", "bgcolor", "border", "cellpadding", "cellspacing", "class", "color",
    "colspan", "dir", "face", "height", "href", "lang", "rowspan", "size", "span", "src",
    "style", "title", "valign", "width"
]);
const URL_ATTRIBUTES = new Set(["href", "src"]);
const VOID_TAGS = new Set(["br", "col", "hr", "img"]);
/* Tags whose text content must go with them, or a dropped <script> would leave its code as
 * visible note text. */
const DROP_CONTENT_TAGS = new Set([
    "head", "iframe", "math", "noscript", "object", "embed", "script", "style", "svg",
    "template", "textarea", "title"
]);
const UNSAFE_STYLE_PATTERN = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import/i;

function sanitizeHtml(html) {
    const input = String(html || "");
    let out = "";
    let index = 0;

    while (index < input.length) {
        const start = input.indexOf("<", index);
        if (start === -1) {
            out += input.slice(index);
            break;
        }
        out += input.slice(index, start);

        if (input.startsWith("<!--", start)) {
            const end = input.indexOf("-->", start + 4);
            index = end === -1 ? input.length : end + 3;
            continue;
        }
        if (input.startsWith("<!", start) || input.startsWith("<?", start)) {
            const end = input.indexOf(">", start);
            index = end === -1 ? input.length : end + 1;
            continue;
        }

        const tag = readTag(input, start);
        if (!tag) {
            out += "&lt;";
            index = start + 1;
            continue;
        }
        index = tag.end;

        if (tag.closing) {
            if (ALLOWED_TAGS.has(tag.name) && !VOID_TAGS.has(tag.name)) out += `</${tag.name}>`;
            continue;
        }
        if (DROP_CONTENT_TAGS.has(tag.name)) {
            if (!tag.selfClosing) index = endOfDroppedContent(input, tag);
            continue;
        }
        if (ALLOWED_TAGS.has(tag.name)) out += renderOpenTag(tag);
    }

    return out.trim();
}

/*
 * Reads one tag, tracking quoted attribute values so that a ">" inside one does not end it.
 * Only a quote that opens a value counts, because an apostrophe in an unquoted value
 * (title=Bob's) is ordinary text, and treating it as a delimiter would run the scan past the
 * real ">". Machine-generated email HTML also leaves values unterminated (width="100>), so a
 * scan that reaches the end of the input falls back to the first ">" rather than reporting a
 * tag that swallows the rest of the message.
 */
function readTag(input, start) {
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(start, start + 64));
    if (!match) return null;

    const bodyStart = start + match[0].length;
    let cursor = bodyStart;
    let quote = "";
    let afterEquals = false;
    let end = -1;
    while (cursor < input.length) {
        const char = input[cursor];
        if (quote) {
            if (char === quote) quote = "";
        } else if (char === ">") {
            end = cursor;
            break;
        } else if (afterEquals && (char === '"' || char === "'")) {
            quote = char;
            afterEquals = false;
        } else if (char === "=") {
            afterEquals = true;
        } else if (!/\s/.test(char)) {
            afterEquals = false;
        }
        cursor += 1;
    }
    if (end === -1) {
        end = input.indexOf(">", bodyStart);
        if (end === -1) end = input.length;
    }

    const body = input.slice(bodyStart, end);
    return {
        name: match[2].toLowerCase(),
        closing: match[1] === "/",
        selfClosing: /\/\s*$/.test(body),
        body,
        end: Math.min(end + 1, input.length)
    };
}

/*
 * Finds where a dropped element's content ends. A missing close tag must not consume the rest of
 * the message, so an unclosed element drops only its own tag and its text is left to the main
 * loop, where it becomes inert note text: the dangerous part is the tag, not the characters.
 */
function endOfDroppedContent(input, tag) {
    const closing = new RegExp(`</${tag.name}(?:[\\s/>]|$)`, "i").exec(input.slice(tag.end));
    if (!closing) return tag.end;
    const close = input.indexOf(">", tag.end + closing.index);
    return close === -1 ? input.length : close + 1;
}

function renderOpenTag(tag) {
    const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
    let rendered = `<${tag.name}`;
    let hasHref = false;
    let match;

    while ((match = pattern.exec(tag.body)) !== null) {
        const name = match[1].toLowerCase();
        if (!ALLOWED_ATTRIBUTES.has(name)) continue;

        const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
        if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) continue;
        if (name === "style" && UNSAFE_STYLE_PATTERN.test(value)) continue;
        if (name === "href") hasHref = true;
        rendered += ` ${name}="${escapeAttribute(value)}"`;
    }

    if (tag.name === "a" && hasHref) rendered += ' rel="noopener noreferrer"';
    return `${rendered}>`;
}

function isSafeUrl(value) {
    // Control characters are stripped first: browsers ignore them, so "java\tscript:" would
    // otherwise slip past a scheme check that a browser still resolves as javascript:.
    const url = value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
    // Backslashes are normalised the way browsers normalise them, so "\\host/path" is recognised
    // as the protocol-relative URL it resolves to rather than as a relative path.
    const relative = url.replaceAll("\\", "/");
    if (relative.startsWith("//")) return !relative.startsWith("///");
    if (relative.startsWith("#")) return true;
    // A relative URL resolves against the note, so email HTML could use one to make the browser
    // issue a request to Trilium's own API carrying the reader's session. Nothing in a message can
    // mean anything by a relative URL anyway, having no base document to resolve against.
    if (!/^[a-z][a-z0-9+.-]*:/.test(url)) return false;
    // cid: is kept because importMessage rewrites those references to saved attachments, which it
    // does after this sanitizer has run.
    if (/^(?:https?|mailto|tel|cid):/.test(url)) return true;
    return /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/.test(url);
}

function decodeEntities(value) {
    return String(value)
        .replace(/&#x([0-9a-f]+);?/gi, (_match, hex) => safeCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_match, digits) => safeCodePoint(parseInt(digits, 10)))
        .replace(/&(quot|apos|lt|gt|nbsp|amp);/gi, (_match, name) => ({
            quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&"
        })[name.toLowerCase()]);
}

function safeCodePoint(code) {
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/* Compares in constant time so a wrong secret cannot be recovered from response timing. */
function secretMatches(expected, provided) {
    const left = String(expected || "");
    const right = typeof provided === "string" ? provided : "";
    if (!left || left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
}

function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
}

function parseJson(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
}

function randomState() {
    return `${Date.now().toString(36)}-${api.randomString(32)}`;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/*
 * Trilium does not evaluate this file as a CommonJS module, so `module` is absent there and this
 * is inert. Under `node --test` it exposes the helpers that are worth testing without a running
 * Trilium: the ones that are pure, or that read only from a mockable `api` global.
 */
if (typeof module !== "undefined" && module.exports) {
    module.exports = { sanitizeHtml, isSafeUrl, readTag, getRedirectUri, secretMatches, escapeHtml, escapeAttribute };
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
