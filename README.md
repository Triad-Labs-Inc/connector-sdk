# connector-sdk

Connectors that write to **your** store. Plumbing, not a silo.

`connector-sdk` is a set of open-source connectors for extracting and normalizing
company data. A connector handles authentication, change detection, download,
and normalization, then returns portable documents to the consumer. It does not
host your data, choose your database, or make you query through a Triad service.

The first connector targets Google Drive, with folder-scoped backfills,
cursor-based incremental sync, native Google exports, and an injected parser
for binary files. A standalone CLI writes Markdown and a manifest to disk.

The repository is an early TypeScript monorepo. See [the design](docs/DESIGN.md)
for the accepted architecture and planned scope.

## Packages

- `@triadlabs/connectors-gdrive` — Google Drive connector (authentication,
  backfill, incremental sync, extraction)
- [`@triadlabs/connectors-cli`](packages/cli/README.md) — standalone Google
  Drive-to-Markdown dump CLI

## Status

The Google Drive connector implements the accepted design: service-account and
OAuth authentication, recursive folder backfills, Drive shortcut resolution,
cursor-based incremental sync, native Google exports, direct decoding of text
formats, and an injected parser socket for binary files. The CLI writes one
Markdown file per document plus a `manifest.json` with metadata, content
hashes, and incremental cursor state; binary formats are recorded as errors in
the manifest until a parser is configured.

Durable consumers can stream discovery with serializable checkpoints, reconcile
complete inventories, and bound content downloads. See
[Durable sync integration](docs/DURABLE_SYNC.md) for the worker contract and tests.
Automated tests exercise the Drive API boundary with fixtures; an optional
read-only live smoke script verifies inventory, restart, and content retrieval.

## License

MIT
