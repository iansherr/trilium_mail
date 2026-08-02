import { Button, FormGroup, FormTextBox, useEffect, useState } from "trilium:preact";

const PACKAGE_ID = "iansherr/gmail-ingest";
const OAUTH_START = "/custom/gmail-ingest/oauth/start";
const PROCESS_ENDPOINT = "/custom/gmail-ingest/process";

export default function GmailIngest() {
    const [settings, setSettings] = useState({ accounts: [], endpointSecret: "", lastRunAt: "", lastRunSummary: null });
    const [accountHint, setAccountHint] = useState("");
    const [status, setStatus] = useState("Loading…");
    const [busy, setBusy] = useState(false);

    useEffect(() => { void load(); }, []);

    async function load() {
        try {
            const note = await api.searchForNote(`#packageOwner=${PACKAGE_ID}`);
            const accounts = parseJson(note?.getOwnedLabelValue("packageSetting:accounts"), []);
            const endpointSecret = parseJson(note?.getOwnedLabelValue("packageSetting:endpointSecret"), "");
            setSettings({
                accounts: Array.isArray(accounts) ? accounts.map((account) => ({ email: account.email })) : [],
                endpointSecret: String(endpointSecret || ""),
                lastRunAt: note?.getOwnedLabelValue("gmailLastRunAt") || "",
                lastRunSummary: parseJson(note?.getOwnedLabelValue("gmailLastRunSummary"), null)
            });
            setStatus("");
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    }

    function connect() {
        const url = new URL(OAUTH_START, window.location.origin);
        if (accountHint.trim()) url.searchParams.set("account", accountHint.trim());
        window.location.href = url.toString();
    }

    async function processNow() {
        if (!settings.endpointSecret) {
            setStatus("Set a Manual sync endpoint secret in Plugins settings first.");
            return;
        }
        setBusy(true);
        setStatus("Importing…");
        try {
            const response = await fetch(PROCESS_ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ secret: settings.endpointSecret })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || `Sync failed (${response.status})`);
            setStatus(formatSummary(payload));
            await load();
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div style={{ maxWidth: "50em", padding: "1em" }}>
            <h2>Gmail Ingest</h2>
            <p>Messages labeled <code>trilium-ingest</code> are copied into Trilium hourly. After a successful copy, the Gmail label becomes <code>trilium-done</code>.</p>

            <h3>Connected accounts</h3>
            {settings.accounts.length ? <ul>{settings.accounts.map((account) => <li key={account.email}>{account.email}</li>)}</ul> : <p>No Gmail accounts are connected yet.</p>}

            <FormGroup name="gmail-account-hint" label="Account to connect" description="Optional email hint when Google shows the account chooser.">
                <FormTextBox currentValue={accountHint} onChange={setAccountHint} disabled={busy} />
            </FormGroup>
            <Button text="Connect Gmail account" kind="primary" onClick={connect} disabled={busy} />
            <Button text="Sync now" onClick={processNow} disabled={busy || !settings.accounts.length} />

            {settings.lastRunAt && <p style={{ marginTop: "1em" }}><strong>Last run:</strong> {settings.lastRunAt}</p>}
            {settings.lastRunSummary && <pre style={{ whiteSpace: "pre-wrap" }}>{formatSummary(settings.lastRunSummary)}</pre>}
            {status && <p role="status" style={{ marginTop: "1em" }}>{status}</p>}

            <p style={{ marginTop: "1.5em" }}>Before connecting, configure the Google OAuth client ID, client secret, target note ID, and a manual sync endpoint secret in Settings → Plugins. Add the exact callback URL shown by the OAuth error to the Google Cloud OAuth client if Google requires it.</p>
        </div>
    );
}

function parseJson(value, fallback) {
    try { return JSON.parse(value || ""); } catch { return fallback; }
}

function formatSummary(summary) {
    if (!summary || typeof summary !== "object") return String(summary || "");
    const text = `${summary.imported || 0} imported, ${summary.skipped || 0} already present, ${summary.failed || 0} failed`;
    return summary.errors?.length ? `${text}. ${summary.errors.join("; ")}` : text;
}
