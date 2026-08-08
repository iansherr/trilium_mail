/*
 * Guards the package manifest. The integrity hashes are what a Trilium instance checks before it
 * installs an artifact, so a source edit that ships without a matching hash update is a broken
 * package rather than a failing feature: this turns the CONTRIBUTING rule into a check.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "trilium-package.json"), "utf8"));

function integrityOf(source) {
    return `sha256-${crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, source))).digest("base64")}`;
}

test("every artifact integrity hash matches its source", () => {
    for (const artifact of manifest.artifacts) {
        assert.strictEqual(
            artifact.integrity,
            integrityOf(artifact.source),
            `${artifact.id}: integrity is stale, update it to the value on the right`
        );
    }
});

test("artifacts sharing a source share its hash", () => {
    // The worker and the endpoint are the same file installed twice, so a hash updated in one
    // place and not the other would install two different versions of the same script.
    const bySource = new Map();
    for (const artifact of manifest.artifacts) {
        const seen = bySource.get(artifact.source);
        if (seen) assert.strictEqual(artifact.integrity, seen.integrity, `${artifact.id} and ${seen.id} share a source`);
        else bySource.set(artifact.source, artifact);
    }
});

test("artifact sources exist and ids are unique", () => {
    const ids = new Set();
    for (const artifact of manifest.artifacts) {
        assert.ok(fs.existsSync(path.join(ROOT, artifact.source)), `${artifact.id}: missing source ${artifact.source}`);
        assert.ok(!ids.has(artifact.id), `duplicate artifact id ${artifact.id}`);
        ids.add(artifact.id);
    }
});

test("setting keys are unique and typed", () => {
    const keys = new Set();
    for (const setting of manifest.settings) {
        assert.ok(!keys.has(setting.key), `duplicate setting key ${setting.key}`);
        keys.add(setting.key);
        assert.ok(["string", "secret", "number", "boolean"].includes(setting.type), `${setting.key}: unexpected type ${setting.type}`);
        assert.ok("default" in setting, `${setting.key}: missing default`);
    }
});

test("the settings the backend reads are declared", () => {
    // readSettings falls back to a default for anything undeclared, so a setting it reads but the
    // manifest never renders is one the user has no way to set.
    const source = fs.readFileSync(path.join(ROOT, "src", "gmail-ingest.js"), "utf8");
    const declared = new Set(manifest.settings.map((setting) => setting.key));
    const read = [...source.matchAll(/\bvalue\("([a-zA-Z]+)"/g)].map((match) => match[1]);
    assert.ok(read.length > 0, "expected readSettings to read at least one setting");
    for (const key of read) {
        assert.ok(declared.has(key), `readSettings reads "${key}", which trilium-package.json does not declare`);
    }
});
