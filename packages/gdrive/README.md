# `@triadlabs/connectors-gdrive`

Google Drive connector that writes to **your** store. Plumbing, not a silo.

The connector handles authentication, change detection, download, and
normalization, then returns portable documents to you. It does not host your
data, choose your database, or make you query through a Triad service. You own
the destination and decide how documents are stored, indexed, queried, and
deleted.

- Recursive folder backfills or whole-drive scans
- Cursor-based incremental sync via the Drive changes feed
- Drive shortcut resolution with cycle detection
- Native Google exports (Docs → Markdown, Sheets → CSV, Slides → text)
- Direct decoding of `text/plain`, `text/markdown`, and `text/csv`
- Injected parser socket for binary formats (PDF, DOCX, …)
- SHA-256 content hashes, deletion IDs, and structured skip reasons

Requires Node.js >= 20. ESM only.

## Install

```sh
npm install @triadlabs/connectors-gdrive
```

Shared contracts (`ConnectorDocument`, `ParserFn`, typed errors) are
re-exported from this package; you do not need to install
`@triadlabs/connectors-core` separately unless you are building your own
connector.

## Quick start

```ts
import { createGDriveConnector } from "@triadlabs/connectors-gdrive";

const connector = createGDriveConnector({
  auth: {
    type: "oauth",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
  },
  scope: { folder: "https://drive.google.com/drive/folders/<id>" },
  // or scope: { folder: "<id>" } or scope: { allFiles: true }
});

// First call with no argument = full backfill.
const result = await connector.listChanges();

for (const doc of result.documents) {
  const full = await connector.fetchContent(doc);
  // full.markdown, full.contentHash — store them wherever you want.
}

// Persist the resume blob wherever you keep state.
saveResume({
  cursor: result.cursor,
  visitedTargets: result.visitedTargets,
});

// Later: incremental sync. Pass the blob back; get only what changed.
const next = await connector.listChanges(loadResume());
// next.documents = new/updated, next.removed = deleted IDs,
// next.skipped = items that could not be processed (with reasons).
```

## Authentication

Two credential types, both using the `drive.readonly` scope. The package does
not store credentials, run an OAuth consent redirect, or schedule
synchronization — that is your job.

**Service account** (best for servers; share Drive folders with the service
account email):

```ts
createGDriveConnector({
  auth: { type: "service-account", keyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON! },
  scope: { folder: "<id>" },
});
```

**OAuth refresh token** (best for user-delegated access):

```ts
createGDriveConnector({
  auth: {
    type: "oauth",
    clientId: "...",
    clientSecret: "***",
    refreshToken: "***",
  },
  scope: { folder: "<id>" },
});
```

To obtain a refresh token, this package exports the OAuth helpers
`getAuthorizationUrl(config)` and `exchangeAuthorizationCode({ ...config, code })`.
See `examples/oauth-flow` in the repo for a complete localhost consent flow,
and `examples/list-visible` for a script that consents and then lists every
file and folder visible to an account.

## Sync model

```ts
listChanges(resume?: { cursor?: GDriveSyncCursor; visitedTargets?: VisitedTargets })
  : Promise<GDriveSyncResult>
```

- **No argument → backfill.** Walks the scope, returns every document plus a
  fresh cursor and the initial `visitedTargets`.
- **`resume` present → incremental.** Reads the Drive changes feed from
  `resume.cursor`, re-walks known shortcut-target folders to discover new
  descendants, and returns only changes.
- **The connector owns no state.** Resume data goes in as an argument and
  comes out in the result. Persist it (database, file, wherever) and pass it
  back next run. Reusing a connector instance across calls does **not**
  accumulate state — the blob is the state.
- **`visitedTargets` matters when shortcuts are involved.** Shortcut targets
  live outside your scoped folder, so the changes feed alone cannot scope
  them. Always round-trip the full blob.

`GDriveSyncResult`:

```ts
{
  documents: ConnectorDocument[];  // new or updated (metadata only until fetchContent)
  removed: string[];               // providerDocIds that were deleted or trashed
  skipped: SkippedEntry[];         // { id, name?, reason } — see below
  cursor: GDriveSyncCursor;        // persist me
  visitedTargets: VisitedTargets;  // persist me
}
```

Skip reasons: `shortcut_missing_target`, `shortcut_cycle_detected`,
`shortcut_target_unreadable`, `shortcut_target_trashed`.

## Extraction

`listChanges` returns metadata-only documents. Call `fetchContent(doc)` to get
`markdown` and a SHA-256 `contentHash`:

- Google Docs/Sheets/Slides are exported natively (Markdown/CSV/plain text).
- `text/plain`, `text/markdown`, `text/csv` are downloaded and decoded
  directly.
- Everything else requires a parser you inject at construction:

```ts
createGDriveConnector({
  auth,
  scope,
  parser: async (bytes: Uint8Array, mimeType: string) => {
    // your pipeline: Firecrawl, a local parser, an LLM, whatever
    return markdown;
  },
});
```

Binary documents without a configured parser throw
`ConnectorExtractionError` from `fetchContent`. Extraction is lazy and per
document, so you control concurrency, retries, and cost.

## Errors

All errors are typed and catchable with `instanceof`:

| Error | Thrown when |
| --- | --- |
| `ConnectorAuthError` | Credentials are malformed or cannot be parsed |
| `ConnectorScopeError` | `scope` is missing/invalid, or folder ID/URL is malformed |
| `ConnectorExtractionError` | No parser for a binary type, or extraction of a folder/shortcut was attempted |
| `ConnectorCursorExpiredError` | The Drive changes cursor expired (Drive retains ~30 days) — catch this and re-run a full backfill |

```ts
import { ConnectorCursorExpiredError } from "@triadlabs/connectors-gdrive";

try {
  const result = await connector.listChanges(loadResume());
} catch (error) {
  if (error instanceof ConnectorCursorExpiredError) {
    clearResume();
    const fresh = await connector.listChanges(); // full backfill
  } else {
    throw error;
  }
}
```

## Scope notes

- `scope.folder` accepts a raw folder ID or a full Drive folder URL.
- `scope: { allFiles: true }` scans everything the credential can see. Use
  deliberately.
- Shared drives are supported throughout (`supportsAllDrives` /
  `includeItemsFromAllDrives` are set on every request).
- The special folder ID `root` is resolved once and shared by both backfill
  and incremental modes.

## License

MIT
