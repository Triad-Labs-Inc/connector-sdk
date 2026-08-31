# `@triadlabs/connectors-cli`

`triad-connectors` syncs Google Drive documents into a portable local dump: one
Markdown file per document and a `manifest.json` containing metadata, content
hashes, incremental cursor state, and shortcut targets.

## Usage

```sh
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
export GOOGLE_REFRESH_TOKEN="..."

triad-connectors sync --source gdrive --folder <id-or-url> --out ./dump
```

Explicit `--client-id`, `--client-secret`, and `--refresh-token` flags override
the corresponding environment variables. Service-account authentication is
also supported with `--service-account-json <path-or-json>` or the
`GOOGLE_SERVICE_ACCOUNT_JSON` environment variable.

To scan all files visible to the credential, explicitly pass `--all-files` in
place of `--folder`. The CLI warns before this broad scan. Subsequent runs use
the cursor and visited targets in `manifest.json` for incremental sync; an
expired cursor automatically triggers a full backfill.

Binary formats require a parser, which the CLI does not yet configure. Those
documents are recorded with an `error` in the manifest while the sync continues.
