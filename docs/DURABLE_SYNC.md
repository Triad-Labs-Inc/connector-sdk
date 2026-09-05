# Durable sync integration

Use this guide to connect the Google Drive SDK to an application-owned document
store. The SDK discovers documents, checks source membership, and extracts
content. Your application owns credentials, scheduling, durable jobs, storage,
parsers, and delivery to an index or memory service.

## Implementation stack

1. Streaming discovery: `iterateChanges`, versioned JSON checkpoints, page-level
   backpressure, cancellation, progress, and complete/partial inventory events.
2. Membership reconciliation: the same engine behind `listChanges`, live-file
   moves out of scope, explicit rescan requests for folder/shortcut topology,
   provider retry metadata, and preservation of CLI files after partial scans.
3. Bounded content: actual download limits, parser context and error reasons,
   provider metadata consistency, output limits, and a repeatable live smoke test.

The source packages are prepared as version 0.1.0. Build and publish core before
Google Drive after the stack is merged; this stack does not publish packages.
The CLI remains a private workspace package.

## Discovery and checkpoint commit

Use one active discovery worker per source and serialize source configuration
changes with that worker. Pair resume state with the same credential and scope;
start a new backfill after replacing credentials or changing scope.

For every `document` event, upsert a source membership and a durable content job
keyed by your source ID and the provider document ID. For every `removed` event,
retire that source membership. Replays must be harmless. Preserve membership from
other sources that still admit the same document.

Commit all work preceding a `checkpoint` event before saving its entire `resume`
object. The work may be fully delivered content or durable pending jobs. A crash
after work commits but before the checkpoint saves replays the page. Saving the
checkpoint before work commits can lose documents. The SDK does not perform the
database transaction or wait for downstream delivery.

A checkpoint includes traversal state, not only the Drive changes token. It can
resume between pages inside a folder and retains queued child folders. Memory
contains one provider page plus visited IDs and queued folders; it grows with the
inventory and is not a constant-size cursor. Only request the next event when
your persistence layer can accept it.

## Inventory reconciliation

Give each backfill a generation in your store. Mark observed source memberships
with that generation. Retire unseen memberships only after `complete` with
`phase: "backfill"` and `coverage: "complete"`. Handle that sweep and saving the
completion checkpoint atomically, or persist a completion job before advancing.
A crash after the last page checkpoint can resume and emit backfill completion.
Never sweep on an incremental completion, partial scan, cancellation, or failure.

Folder/shortcut changes and ambiguous removals can throw
`ConnectorRescanRequiredError`. Clear traversal state and start a new backfill
with a new generation. This is a conservative fallback: structural changes
elsewhere in the account can also trigger it. A confirmed missing source root
throws a provider error; let an admin or credential-reconciliation job decide
whether to disconnect the source. It does not authorize a bulk empty-inventory
sweep.

Missing, trashed, cyclic, or unresolved shortcut targets make coverage partial.
Preserve unseen memberships, surface the skip reasons, and retry or repair the
source before attempting another complete backfill. Track partial inventory
status in your application until a complete replacement backfill succeeds;
a later incremental completion does not repair the earlier inventory.

## Content workers and delivery

Drain durable content jobs independently of discovery. Set explicit `maxBytes`,
`maxOutputCharacters`, and a deadline signal on `fetchContent`. Use provider size
as an early hint; actual download bytes are checked even if size is missing or
incorrect. Store the returned metadata and hash with the extracted content.
The provider metadata is sampled before/after download; revisions are not pinned.

Run binary parsing in a process or worker that you can terminate. The SDK passes
bytes and context to your parser, but cannot bound its internal allocations or
kill synchronous work. Classify deterministic extraction failures by `reason` and
record an actionable per-document outcome. A newer provider version or changed
parser policy may make the document worth retrying.

Retry `ConnectorContentChangedError`. For `ConnectorProviderError`, use
`retryable`, `status`, and `retryAfterMs` with your own bounded retry policy.
Transient failures are not deletion evidence. Preserve retries across crashes.
After normalized content commits, deliver it to your index/memory service through
an idempotent durable job. Expose discovery, extraction, and delivery separately
so an advanced cursor does not imply the brain is current.

## Verification

Run the automated gates at each layer:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

The fixtures cover paginated restart, replay, consumer backpressure, cancellation,
shortcut reachability, partial inventories, moves and structural rescans, rate
limits and provider outages, streaming byte limits, parser failures, and edits
during downloads. They do not mutate a live Drive account.

For a read-only smoke test, configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN`, and `GOOGLE_FOLDER_ID` in your shell or a gitignored env
file. Select a small stable folder with a supported text or native Google file:

```sh
pnpm build
node --env-file=/path/to/local.env scripts/smoke-drive.mjs
```

The script resumes a JSON checkpoint in a new connector instance, compares its
inventory with `listChanges`, fetches one supported file with limits, and runs an
incremental scan. It prints counts and outcomes, never credentials or document
text. Inventory comparison can fail if the folder changes between scans. Folder
move/delete/permission mutations and crash recovery in your real database still
need application-level acceptance tests.
