# Examples

Standalone examples showing how to run connectors outside any backend.

## `oauth-flow/`

User-facing localhost OAuth flow: prints a Google consent link, catches the
callback, saves the refresh token in a gitignored `.env.local`, and lists the
authenticated user's visible Drive folders.

```bash
cd examples/oauth-flow
pnpm install
pnpm oauth
```

See [`oauth-flow/README.md`](oauth-flow/README.md) for the one-time Google Cloud
setup. Every later run is just `pnpm oauth`, then click the link if authorization
is needed.

## `sync-test/`

OAuth-powered manual harness for the sync engine. Run it once to backfill a real
Drive folder, change a file, then run it again to see cursor-based incremental
changes:

```bash
cd examples/sync-test
pnpm sync --folder <id-or-url>
```

It reuses credentials from `oauth-flow/.env.local`. See
[`sync-test/README.md`](sync-test/README.md) for cursor reset and all-files
options.

## `smoke/`

Tier-2 auth smoke test: proves a service-account credential actually works
against the real Drive API (the one thing unit tests with mocks cannot prove).

```bash
# from repo root
pnpm install
pnpm build                      # builds @triadlabs/connectors-gdrive

cd examples/smoke
GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json pnpm smoke
```

Setup (one time, ~5 minutes):

1. Google Cloud console → create project → enable **Google Drive API**
2. Create a service account → download the JSON key
3. In Drive, share a test folder with the robot email
   (`….iam.gserviceaccount.com`) — Viewer is enough

Expected outcomes:

- folders listed → auth works; the robot sees what you shared
- empty list → auth works, but nothing is shared with the robot email
- HTTP 403 → Drive API is not enabled in the cloud project
- `ConnectorAuthError` → the JSON key is malformed
