# `@triadlabs/connectors-gdrive`

Google Drive plumbing for consumer-owned document stores.

## Authentication

Pass either the contents of a service-account JSON key file or OAuth client
credentials with a refresh token:

```ts
import { createDriveClient } from "@triadlabs/connectors-gdrive";

const serviceAccountDrive = createDriveClient({
  type: "service-account",
  keyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON!,
});

const oauthDrive = createDriveClient({
  type: "oauth",
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
});
```

Both clients use the `drive.readonly` scope. The package does not store
credentials, run an OAuth consent redirect, or schedule synchronization.

## Sync status

Step 3 is shipped: `createGDriveConnector` supports recursive folder backfills,
Drive shortcut resolution, cursor-based incremental changes, folder ancestry
scope checks, shared-drive flags, deletion IDs, and metadata-complete document
stubs. Content extraction is intentionally deferred to step 4.

Persist `visitedTargets` from a backfill result and pass it back as
`knownTargets` when recreating the connector so incremental sync retains scope
for shortcut targets.
