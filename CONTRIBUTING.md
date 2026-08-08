# Contributing

Changes in this repository should remain specific to the Gmail Ingest package. Trilium host
infrastructure, the Plugins settings tab, and host-side tests belong in the separate
[Trilium repository](https://github.com/iansherr/Trilium), currently tested through
[`integration/plugins`](https://github.com/iansherr/Trilium/tree/integration/plugins).

Before submitting a change, validate `trilium-package.json`, keep artifact integrity hashes
in sync, and test OAuth and import behavior in a disposable Trilium instance when runtime
behavior changes. Never commit OAuth credentials or refresh tokens.

## Tests

```sh
npm test        # or: node --test
```

The suite has no dependencies and needs nothing installed; `package.json` exists only to carry
that script, which is why it declares no name or version. This repository is versioned by
`trilium-package.json`, and a second version field would be one more thing to keep in sync.
GitHub Actions runs the suite on Node 20, 22, and 24 for every push and pull request.

The suite covers the message-HTML sanitizer, the OAuth redirect URI, and the package manifest,
including whether each artifact integrity hash still matches its source. Editing a file under
`src/` therefore fails the manifest test until the hash is updated:

```sh
printf 'sha256-%s\n' "$(openssl dgst -sha256 -binary src/gmail-ingest.js | openssl base64 -A)"
```

`src/gmail-ingest.js` runs under Trilium, which evaluates it with an `api` object in scope and no
module wrapper. Its entrypoint and its `module.exports` are each guarded on the absence of the
other so the file stays loadable by both, which is what lets the tests require it directly.
Anything reaching Trilium state belongs in a disposable instance instead; the tests cover the
pure helpers and those reading only a mockable `api`.
