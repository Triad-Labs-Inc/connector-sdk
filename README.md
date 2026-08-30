# connector-sdk

Connectors that write to **your** store. Plumbing, not a silo.

`connector-sdk` is a set of open-source connectors for extracting and normalizing
company data. A connector handles authentication, change detection, download,
and normalization, then returns portable documents to the consumer. It does not
host your data, choose your database, or make you query through a Triad service.

The first connector targets Google Drive. It supports folder-scoped backfills,
cursor-based incremental sync, native Google exports, and an injected parser for
binary files. A standalone CLI can write Markdown and a manifest to disk.

The repository is an early TypeScript monorepo. See [the design](docs/DESIGN.md)
for the accepted architecture and planned scope.

## Packages

- `@triadlabs/connectors-gdrive` — Google Drive connector (skeleton only)

## Status

Step 1 defines the interfaces and repository structure. Authentication and Drive
API behavior are intentionally held for the next implementation step.

## License

MIT
