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
  `resume.cursor`, checks changed files against the folder and known shortcut
  targets, and returns changes. Structural changes request a fresh backfill
  (see Membership changes below).
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
  removed: string[];               // IDs no longer reachable through this source
  skipped: SkippedEntry[];         // { id, name?, reason } — see below
  cursor: GDriveSyncCursor;        // persist me
  visitedTargets: VisitedTargets;  // persist me
  coverage?: "complete" | "partial"; // only a complete backfill permits a sweep
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
| `ConnectorCursorExpiredError` | The provider rejected the persisted changes cursor — catch this and re-run a full backfill |

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

## Streaming discovery and durable checkpoints

`iterateChanges()` streams metadata before a traversal finishes. Persist **the
entire** versioned checkpoint after all preceding events have durable outcomes
or durable pending work in your store. Replays are possible; destination writes
must be idempotent. A provider checkpoint is not proof that content delivery has
finished. The connector never acknowledges your writes itself.

```ts
for await (const event of connector.iterateChanges(savedCheckpoint, { signal })) {
  if (event.kind === "document") await recordPendingDocument(event.document);
  if (event.kind === "removed") await recordRemoval(event.providerDocId);
  if (event.kind === "skipped") await recordSkip(event.entry);
  if (event.kind === "progress") showProgress(event);
  if (event.kind === "checkpoint" || event.kind === "complete") {
    await commitPriorWorkAndCheckpoint(event.resume);
  }
}
```

The helper functions above belong to your application. Resume values are opaque
JSON, bound to the resolved folder or `allFiles` scope. They include unfinished
folder pagination and the original pre-backfill changes token. Recreate the
connector after a restart and pass the saved object to continue. Invalid state
raises `ConnectorResumeError` (a `ConnectorCursorExpiredError` subtype).

`complete` distinguishes backfill/incremental and `complete`/`partial` coverage.
Only a complete backfill is an inventory suitable for retiring unseen source
memberships. Incremental results never imply unseen files are gone. Cancellation
or provider failure throws without emitting completion. Counters describe known
discovery progress; no total is invented. One provider page is buffered, plus
traversal/visited-ID state that grows with the corpus.

The legacy `listChanges()` API remains available. Its `{ cursor, visitedTargets }`
resume value can start the iterator between scans, but cannot represent an
unfinished walk. Save streaming checkpoints whole rather than extracting those
two fields. Keep credentials/source configuration paired with their own resume
state; resetting or replacing credentials requires a deliberate new backfill.

### Membership changes

Folder-scoped incremental discovery emits `outOfScope` removal events for live
files that moved out. Folder/shortcut changes and ambiguous removals raise
`ConnectorRescanRequiredError` before advancing that page's checkpoint. Start a
fresh backfill and reconcile its complete inventory against your source rows.
This deliberately trades a rescan for precise subtree bookkeeping. Structural
changes elsewhere in the account can also request a rescan; scope-level webhook
optimization and a persistent reachability graph are not implemented.

Both discovery APIs now use the same engine. Existing consumers that catch
`ConnectorCursorExpiredError` also catch the rescan-required subtype. The CLI
keeps existing files when a replacement backfill has partial coverage or skips.
Missing/unresolved shortcut targets are reported as partial coverage: repair the
source or retry before retiring unseen documents. A root lookup failure throws;
it is never a successful empty inventory.

`ConnectorProviderError` exposes `status`, `retryable`, and optional
`retryAfterMs` without copying credential-bearing provider response bodies into
its message. Rate limits, temporary failures, and cancellation never produce
removal events. The consumer owns retries and scheduling.

## Bounded content fetching

Pass limits and a deadline for each fetch in a durable worker:

```ts
const full = await connector.fetchContent(doc, {
  signal: AbortSignal.timeout(60_000),
  maxBytes: 20 * 1024 * 1024,
  maxOutputCharacters: 1_000_000,
});
```

These numbers are example consumer policy. Limits are optional for compatibility;
without them there is no SDK byte/output cap. `maxBytes` is checked against known
binary size before downloading and against actual bytes while reading downloads
and native exports. Metadata-only documents expose optional `sizeBytes` and
`providerVersion`. Google export size may differ from stored file size, so exports
always use the runtime byte check.

`fetchContent` reads provider metadata before and after the download. It throws
`ConnectorContentChangedError` if the version, modification time, or MIME type
changes between those reads. Retry that file. Successful results contain the
metadata observed for the fetched content, which may be newer than discovery.
This is a consistency check around the download, not a pinned Drive revision.

Parsers receive an optional third argument with `providerDocId`, `name`, `mimeType`,
`sizeBytes`, and `signal`; existing two-argument parsers still work. Throw
`ConnectorExtractionError(message, reason)` for deterministic failures. Reasons
are `unsupported`, `encrypted`, `malformed`, `resourceLimit`, `needsOcr`, and
`parserFailed`. The SDK attaches the document ID. A parser that calls another
service can throw `ConnectorProviderError` to preserve retry metadata.

The output limit is checked after decoding or parsing, using JavaScript string
length (UTF-16 code units). It cannot constrain the parser's own allocations or
interrupt synchronous parser code. Run parsers in a worker/process that your
application can terminate when enforcing CPU, memory, or wall-time budgets.
Cancellation interrupts Drive requests and streams and is passed to the parser.

See [Durable sync integration](../../docs/DURABLE_SYNC.md) for checkpoint,
reconciliation, worker, and verification responsibilities.

## License

MIT
