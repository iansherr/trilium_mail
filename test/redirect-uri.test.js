/*
 * Tests for the OAuth redirect URI the endpoint hands back. The forwarded headers are attacker
 * input on an instance reachable directly, so what is under test is which source is believed
 * rather than only how the URL is assembled.
 */
const test = require("node:test");
const assert = require("node:assert");

const { getRedirectUri } = require("../src/gmail-ingest.js");

/* The module reads the Trilium `api` global at call time, so a request can be mocked onto it. */
function withRequest({ headers = {}, protocol = "http", originalUrl = "/custom/gmail-ingest/oauth/start", trustProxy = false }, run) {
    const previous = globalThis.api;
    globalThis.api = {
        req: {
            app: { get: (key) => (key === "trust proxy" ? trustProxy : undefined) },
            get: (name) => headers[String(name).toLowerCase()],
            protocol,
            originalUrl
        }
    };
    try {
        return run();
    } finally {
        globalThis.api = previous;
    }
}

test("the explicit setting wins over anything in the request", () => {
    const uri = withRequest(
        { headers: { "x-forwarded-proto": "https", host: "evil.example" }, trustProxy: true },
        () => getRedirectUri({ redirectUri: "https://notes.example/custom/gmail-ingest/oauth/callback" })
    );
    assert.strictEqual(uri, "https://notes.example/custom/gmail-ingest/oauth/callback");
});

test("uses the forwarded headers when Trilium trusts the proxy", () => {
    const uri = withRequest(
        {
            headers: { "x-forwarded-proto": "https", "x-forwarded-host": "notes.example", host: "127.0.0.1:8080" },
            protocol: "http",
            trustProxy: true
        },
        () => getRedirectUri({ redirectUri: "" })
    );
    assert.strictEqual(uri, "https://notes.example/custom/gmail-ingest/oauth/callback");
});

test("ignores the forwarded headers when the proxy is not trusted", () => {
    // Without trust proxy the headers come from whoever is calling, so believing them would let
    // that caller choose the redirect_uri embedded in the authorize URL returned to them.
    const uri = withRequest(
        {
            headers: { "x-forwarded-proto": "http", "x-forwarded-host": "evil.example", host: "notes.example" },
            protocol: "https",
            trustProxy: false
        },
        () => getRedirectUri({ redirectUri: "" })
    );
    assert.strictEqual(uri, "https://notes.example/custom/gmail-ingest/oauth/callback");
});

test("takes the first value of a forwarded header list", () => {
    const uri = withRequest(
        {
            headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "notes.example, inner.local", host: "127.0.0.1" },
            trustProxy: true
        },
        () => getRedirectUri({ redirectUri: "" })
    );
    assert.strictEqual(uri, "https://notes.example/custom/gmail-ingest/oauth/callback");
});

test("rewrites the callback path from either route and drops the query", () => {
    const fromCallback = withRequest(
        { headers: { host: "notes.example" }, protocol: "https", originalUrl: "/custom/gmail-ingest/oauth/callback?code=abc&state=xyz" },
        () => getRedirectUri({ redirectUri: "" })
    );
    assert.strictEqual(fromCallback, "https://notes.example/custom/gmail-ingest/oauth/callback");

    const belowPath = withRequest(
        { headers: { host: "notes.example" }, protocol: "https", originalUrl: "/trilium/custom/gmail-ingest/oauth/start" },
        () => getRedirectUri({ redirectUri: "" })
    );
    assert.strictEqual(belowPath, "https://notes.example/trilium/custom/gmail-ingest/oauth/callback");
});

test("falls back to https when the request reports no protocol", () => {
    const uri = withRequest(
        { headers: { host: "notes.example" }, protocol: "" },
        () => getRedirectUri({ redirectUri: "" })
    );
    assert.strictEqual(uri, "https://notes.example/custom/gmail-ingest/oauth/callback");
});
