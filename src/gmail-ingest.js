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

if (api.req && api.res) {
    handleRequest().catch((error) => {
        if (!api.res.headersSent) api.res.status(500).json({ error: errorMessage(error) });
    });
} else {
    runIngest().catch((error) => api.log("Gmail Ingest failed:", errorMessage(error)));
}

async function handleRequest() {
    const route = api.pathParams?.[0] || "";

    if (route === "oauth/start") {
        await startOAuth();
        return;
    }
    if (route === "oauth/callback") {
        await finishOAuth();
        return;
    }
    if (route === "process") {
        const settings = readSettings();
        const body = api.req.body && typeof api.req.body === "object" ? api.req.body : {};
        if (!settings.endpointSecret || body.secret !== settings.endpointSecret) {
            api.res.status(401).json({ error: "Invalid manual sync endpoint secret." });
            return;
        }
        api.res.json(await runIngest());
        return;
    }

    api.res.status(404).json({ error: "Unknown Gmail Ingest route." });
}

async function startOAuth() {
    const settings = readSettings();
    requireOAuthSettings(settings);

    const state = randomState();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    settings.manifest.setLabel("gmailOauthState", state);
    settings.manifest.setLabel("gmailOauthStateExpiresAt", String(expiresAt));

    const redirectUri = getRedirectUri(settings);
    const accountHint = typeof api.req.query?.account === "string" ? api.req.query.account.trim() : "";
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

    api.res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
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

    const lock = Number(settings.manifest.getOwnedLabelValue("gmailRunLock") || 0);
    if (lock && Date.now() - lock < LOCK_TIMEOUT_MS) {
        return { imported: 0, skipped: 0, failed: 0, accounts: settings.accounts.length, locked: true, message: "An import is already running." };
    }

    settings.manifest.setLabel("gmailRunLock", String(Date.now()));
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
        settings.manifest.removeLabel("gmailRunLock");
    }
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
    let html = parts.find((part) => part.mime === "text/html" && part.data)?.data || "";
    const text = parts.find((part) => part.mime === "text/plain" && part.data)?.data || "";
    if (!html && !text && message.payload?.body?.data) {
        if (message.payload.mimeType === "text/html") html = decodeBase64Url(message.payload.body.data).toString("utf8");
    }
    html = sanitizeHtml(html);

    const attachments = [];
    const warnings = [];
    for (const part of parts.filter((candidate) => candidate.filename || candidate.attachmentId)) {
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
    if (part.mimeType === "text/html" || part.mimeType === "text/plain") {
        result.push({ mime: part.mimeType, data: body.data ? decodeBase64Url(body.data).toString("utf8") : "" });
    }
    if (filename || body.attachmentId) {
        result.push({
            mime: String(part.mimeType || "application/octet-stream").toLowerCase(),
            filename,
            attachmentId: body.attachmentId,
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
    const accessToken = await refreshAccessToken(settings, account);
    const headers = { ...(init.headers || {}), authorization: `Bearer ${accessToken}` };
    let response = await fetch(`${GMAIL_API}${path}`, { ...init, headers });
    if (response.status === 401) {
        const retryToken = await refreshAccessToken(settings, account);
        response = await fetch(`${GMAIL_API}${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${retryToken}` } });
    }
    return readJsonResponse(response, "Gmail API request");
}

async function refreshAccessToken(settings, account) {
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

function getRedirectUri(settings) {
    if (settings.redirectUri) return settings.redirectUri;
    const origin = `${api.req.protocol}://${api.req.get("host")}`;
    const currentPath = String(api.req.originalUrl || api.req.url || "").split("?")[0];
    return `${origin}${currentPath.replace(/\/oauth\/(?:start|callback)$/, "/oauth/callback")}`;
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

function sanitizeHtml(html) {
    return String(html || "")
        .replace(/<\/?(script|iframe|object|embed|form)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "")
        .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .trim();
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

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
