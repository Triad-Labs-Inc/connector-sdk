# Connector SDK design

Status: accepted

## Problem

Connector vendors often make ingestion cheap because their storage and query
layer is the product. They pull source data into their own store and require the
consumer to retrieve it through a proprietary SDK. That replaces one silo with
another and makes the connector difficult to reuse with an existing company
brain, search index, or agent memory system.

This SDK takes the opposite position: connectors are pure plumbing. They
authenticate with a source, detect changes, extract content, normalize it, and
hand documents back to the caller. The caller owns the destination and decides
how documents are stored, indexed, queried, and deleted.

## Architecture

Each source lives in its own package under `packages/`. Packages expose source
configuration, sync primitives, and normalized output without depending on a
Triad or Zeke backend. Examples and cross-package design notes live at the
repository root.

### Connecting is not parsing

A connector owns:

1. Authentication and authenticated source clients.
2. Listing, cursor management, and change detection.
3. Download or export of source content.
4. Source metadata normalization.
5. Delivery of normalized documents to the consumer.

Parsing arbitrary bytes into Markdown is a separate concern. The consumer
injects a parser socket with this shape:

```ts
type ParserFn = (bytes: Uint8Array, mimeType: string) => Promise<string>;
```

This keeps the package usable with local parsers, paid parsing APIs, or a
consumer's existing pipeline. Zeke can inject Firecrawl, which it already uses
for chat file uploads, but this SDK does not depend on Firecrawl or any other
paid parser.

## Google Drive connector

The first package is `@triadlabs/connectors-gdrive`.

### Authentication

Two credential shapes are supported:

- Service-account JSON, supplied as the raw JSON key file contents.
- OAuth client credentials plus a refresh token.

Both paths produce the same internal authenticated Drive client. Authentication
is an adapter boundary; sync logic does not branch on the credential type. The
package provides primitives to generate the Google consent URL and exchange an
authorization code, but it does not provide an OAuth UI, hosted callback server,
token database, or secret-management system. The consumer hosts the callback
and owns credential storage; `examples/oauth-flow` demonstrates this with a
temporary localhost server.

The URL helper always requests offline access and forces a fresh consent prompt.
Google can silently omit the refresh token when either `access_type: "offline"`
or `prompt: "consent"` is missing, so the helper makes that easy-to-miss protocol
requirement part of the package boundary rather than every consumer's concern.

### Scope

The normal setup is folder-scoped. An administrator supplies either a Drive
folder ID or a pasted folder URL; the connector parses and validates the ID.
The folder is the customer's access boundary and provides a visible, familiar
way to control the corpus.

An explicit ingest-everything mode is also supported. Its API and CLI must warn
that it scans all content visible to the credential.

Shared drives are supported by consistently passing Drive API flags such as
`supportsAllDrives` and using the corresponding list options.

### Backfill

A backfill recursively walks the selected folder using `files.list`. It records
visited folder and file IDs to prevent duplicate traversal and cycles.

Drive shortcuts require active resolution. A shortcut has MIME type
`application/vnd.google-apps.shortcut` and contains a target ID. The walker must:

1. Read shortcut metadata and `shortcutDetails.targetId`.
2. Fetch the target with `files.get` and `supportsAllDrives`.
3. Traverse it if it is a folder, or extract it if it is a file.
4. Follow targets even when they sit outside the ordinary walked tree.
5. Guard every resolved ID with a visited set so shortcut cycles terminate.

Treating shortcuts as ordinary files silently omits content, so shortcut
resolution is required rather than optional behavior.

### Incremental sync

Incremental sync uses the Drive Changes API. The connector stores the returned
page token as an opaque cursor and resumes from it on the next run. It advances
the durable cursor only after the corresponding page has been processed
successfully.

The Changes API is drive-wide, not folder-scoped. For a folder-scoped connector,
each changed file must therefore be checked for membership in the configured
scope. The connector resolves parent chains until it reaches the scoped folder,
a root, or an already-known ancestor. It caches ancestor results during a run
and guards against cycles. Removed or inaccessible files are emitted as change
metadata suitable for deletion handling even when their ancestors can no longer
be resolved; the eventual change event contract will make this explicit.

Shortcut targets and shortcut membership require the same care during
incremental sync: a change is relevant when the scoped tree contains the file
directly or reaches it through a shortcut recorded during traversal.

### Extraction paths

Extraction is selected by Drive MIME type:

- Google Docs are exported with `files.export` to Markdown when supported, with
  a deterministic textual fallback if the API requires it.
- Google Sheets are exported with `files.export` to CSV.
- Google Slides are exported with `files.export` to a deterministic textual
  format supported by Drive, normalized to Markdown by the connector.
- Other Google-native textual types use a documented Drive export format.
- Plain text and Markdown files are downloaded and decoded directly.
- Other binary files are downloaded and passed to the injected `ParserFn`.

Google-native files do not pass through the parser socket. Direct Drive exports
are free, deterministic, and cover most files in a typical company Drive. If a
binary file needs parsing and no parser was supplied, extraction returns a typed
unsupported-content error rather than silently dropping the file.

### Content identity

The connector hashes the extracted Markdown, not provider metadata or raw
download bytes. `contentHash` is a lowercase SHA-256 hex digest. This gives
consumers a stable way to skip writes when provider metadata changes but the
normalized content does not.

## Normalized document

Every successfully extracted file produces:

```ts
interface ConnectorDocument {
  providerDocId: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  url?: string;
  modifiedAt: string;
  contentHash: string;
  markdown: string;
}
```

`providerDocId` is stable within the source provider. `modifiedAt` is an ISO 8601
timestamp. `webViewLink` preserves the provider's browser link; `url` is a
provider-neutral alias for consumers that use one shared document model. At
least one is present when Drive supplies a viewable link.

## CLI

The repository ships a `triad-connectors` CLI. Its first command is:

```sh
triad-connectors sync --source gdrive --folder <id-or-url> --out ./dump
```

It authenticates from explicit flags or documented environment variables, runs
a folder backfill or incremental sync, and writes one Markdown file per document
plus `manifest.json`. The manifest contains document metadata, output paths,
content hashes, and the next cursor. Filenames are sanitized and collision-safe;
provider IDs remain in the manifest.

The dump makes the connector testable without a hosted destination and can feed
later ingestion experiments, including Honcho, without coupling this package to
them. An explicit all-files flag will exist instead of treating an omitted
folder as consent to ingest everything.

## Repository layout

```text
connector-sdk/
├── packages/
│   └── gdrive/
├── examples/
└── docs/
```

The root package is private tooling. Publishable source packages use the
`@triadlabs` npm scope. The first package is
`@triadlabs/connectors-gdrive`.

## Roadmap

1. Google Drive interfaces and repository skeleton.
2. Google Drive authentication, backfill, shortcut resolution, extraction, and
   cursor-based polling.
3. Standalone CLI and local dump contract.
4. Integration and failure-mode tests against representative Drive fixtures.
5. HubSpot connector using the same normalized output and consumer-owned sink.
6. Additional sources only after the Google Drive design proves reusable.

Deferred work includes image OCR or captioning, webhook push sync, and
per-document ACL transport. Polling and textual documents come first.

## What this package will never do

- Never store consumer source data in a Triad-operated data store.
- Never require a Triad or Zeke backend to run, sync, or query output.
- Never hard-depend on Firecrawl or another paid parser.
- Never force consumers to query through a proprietary SDK or hosted index.
- Never mirror per-document ACLs. Folder scoping is the supported access
  boundary; consumers are responsible for destination authorization.

These are product boundaries, not deferred features.
