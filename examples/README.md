# Examples

Standalone examples showing how to run connectors outside any backend.

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
