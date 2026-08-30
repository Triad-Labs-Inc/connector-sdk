# connector-sdk

Connectors that write to **your** store. Plumbing, not a silo.

`connector-sdk` is a set of open-source connectors for extracting and normalizing
company data. A connector handles authentication, change detection, download,
and normalization, then returns portable documents to the consumer. It does not
host your data, choose your database, or make you query through a Triad service.

The first connector targets Google Drive. The accepted design covers
folder-scoped backfills, cursor-based incremental sync, native Google exports,
and an injected parser for binary files. A standalone CLI is planned to write
Markdown and a manifest to disk.

The repository is an early TypeScript monorepo. See [the design](docs/DESIGN.md)
for the accepted architecture and planned scope.

## Packages

- `@triadlabs/connectors-gdrive` — Google Drive connector (interfaces and
  authentication helpers)

## Status

The repository structure, public interfaces, service-account and OAuth Drive
client creation, OAuth consent helpers, and runnable authentication examples are
implemented. Backfill, shortcut resolution, extraction, incremental sync, and
the standalone CLI remain roadmap work described in the design document.

## License

MIT
