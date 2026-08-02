# Trilium Gmail Ingest

This Community Package connects one or more Gmail accounts to Trilium. The hourly worker searches each account for messages carrying the configured Gmail label (default: `trilium-ingest`), creates a Trilium HTML text note, preserves text-only mail as escaped plain text, saves attachments, and then removes the ingest label and adds `trilium-done`.

## Package boundary

This repository contains only the Gmail Ingest package: its manifest, worker, and dashboard
artifacts. The host-side package manager, Plugins settings tab, lifecycle locking, and
Trilium tests live separately in the [Trilium integration branch](https://github.com/iansherr/Trilium/tree/integration/plugins).
That branch does not bundle this repository or replace it; it is the current development
and end-to-end testing environment until the host changes are accepted upstream.

## Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable the Gmail API.
3. Configure an OAuth consent screen and add the Gmail account as a test user if the app is still in testing.
4. Create an OAuth 2.0 **Web application** client.
5. Add the exact callback URL to its authorized redirect URIs:

   `https://YOUR-TRILIUM-HOST/custom/gmail-ingest/oauth/callback`

   If Trilium is served below a path or behind a proxy, set the full exact URL in the package’s **OAuth redirect URI** setting instead.

## Trilium setup

1. Install this package through the Community Packages manager and enable it.
2. In Settings → Plugins, set the Google client ID and secret, an import parent note ID, and a long random manual sync endpoint secret.
3. Open the installed **Gmail Ingest** Render Note and choose **Connect Gmail account**.
4. Add the `trilium-ingest` label to a Gmail message and wait for the hourly run, or choose **Sync now**.

The package stores OAuth refresh tokens in its managed package settings. The custom endpoint is intentionally protected for manual processing, while the OAuth callback is protected by a short-lived state value. Backend scripting must be enabled in Trilium.

If a message already has a non-archived Trilium note with its `gmailMessageId`, the message is not duplicated; its Gmail labels are still advanced to the done state.

## FAQ

### Is this the Trilium application?

No. This is an independently versioned Trilium package. Trilium provides the host runtime
and package manager.

### Which Trilium version should be used for testing?

Use the separate [`integration/plugins` branch](https://github.com/iansherr/Trilium/tree/integration/plugins)
for current package-manager testing. It is experimental and is not a production release.

### Is the integration branch included in this package?

No. The branch contains Trilium-side infrastructure and tests; this repository contains the
Gmail Ingest package payload.
