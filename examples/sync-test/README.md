# Google Drive sync test

This OAuth-only manual harness exercises the Google Drive connector's backfill
and cursor-based incremental sync against a real folder. It reuses credentials
saved by [`../oauth-flow`](../oauth-flow/README.md); service accounts are not
supported here.

## Run the two-step ritual

First authenticate once, if needed:

```bash
cd examples/oauth-flow
pnpm oauth
```

Then run a backfill from this directory with a Drive folder ID or URL:

```bash
cd ../sync-test
pnpm sync --folder <id-or-url>
```

Edit, add, or delete a file in that folder, then run the same command again.
The second run performs incremental sync and prints changed documents and
removed file IDs. `FOLDER_ID` or `GOOGLE_FOLDER_ID` can supply the folder when
`--folder` is omitted; the command-line value takes precedence.

Cursor state is stored in the gitignored `examples/sync-test/.cursor.json` with
permissions `0600`. Use `--reset` to delete it and force a fresh backfill:

```bash
pnpm sync --folder <id-or-url> --reset
```

Use `--all-files` instead of a folder to scan all content visible to the OAuth
credential. The command prints a warning because this scope can be broad:

```bash
pnpm sync --all-files
```

If Google reports that the saved change token expired, the harness deletes the
cursor and automatically runs a full backfill.
