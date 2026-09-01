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

Step 4 is shipped: `createGDriveConnector` supports recursive folder backfills,
Drive shortcut resolution, cursor-based incremental changes, folder ancestry
scope checks, shared-drive flags, deletion IDs, lazy content extraction, and
SHA-256 content hashes. Shortcut target folders are re-walked during incremental
syncs so newly created descendants are discovered even without an ancestor
change event.

Persist `cursor` and `visitedTargets` from a result as one resume blob and pass
that blob to `listChanges` so incremental sync retains scope
for shortcut targets.
