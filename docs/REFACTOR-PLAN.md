# Refactor plan: gdrive sync engine shape

Status: in progress on `feat/gdrive-list-changes`

Context: code review on PR #8 found the behavior correct (live-verified
2026-09-01) but the shape wrong. This refactor is behavior-preserving: the 76
existing unit tests are the regression net, and the live end-to-end run gets
repeated before merge.

## Step 1 — packages/core (pure move)

New package `@triadlabs/connectors-core` (MIT, ESM, node >= 20, tsup build
matching gdrive). Owns:

- `ConnectorDocument`
- `ParserFn`
- `ConnectorAuthError`, `ConnectorExtractionError`, `ConnectorScopeError`
- generic `Connector` interface (listChanges + fetchContent shape)

gdrive depends on core and re-exports these names so existing imports keep
working. No behavior change; all tests must pass untouched.

## Step 2 — unified walker

Split `packages/gdrive/src/index.ts` into:

- `index.ts` — thin wiring: `createGDriveConnector(drive, scope, parser)`
- `auth.ts` — existing auth helpers (unchanged)
- `resolve.ts` — `resolveItem`: shortcut law, exactly once
- `walk.ts` — unified walker with policy flags
- `changes.ts` — change-feed paging, ancestry/scope checks
- `extract.ts` — fetchContent, one `downloadBytes()`, module-level export table
- `types.ts` — GDriveScope, VisitedTargets, GDriveSyncCursor

Walker shape:

```ts
type Resolved =
  | { kind: "skip"; id: string; name?: string; reason: SkippedReason }
  | { kind: "folder"; id: string }
  | { kind: "file"; file: drive_v3.Schema$File };

walk(start, policy: {
  descend: boolean;
  emitKnownFiles: boolean;
  descendNewTargetFolders: boolean;
}): Promise<WalkOutput>
```

Call sites:
| Mode | descend | emitKnownFiles | descendNewTargetFolders |
|---|---|---|---|
| Backfill | true | true | n/a |
| Change event | false | true | true |
| Re-walk known target folder | true | false | true |

`traverseFolders` and the `let walkTargetFolder` forward declaration disappear.
visit/emit/walkFolder/walkTargetFolder collapse into one walker.

## Step 3 — resume blob (intentional API break)

```ts
listChanges(resume?: { cursor?: GDriveSyncCursor; visitedTargets?: VisitedTargets })
  → { documents, removed, skipped, cursor, visitedTargets }
```

Constructor stops taking `knownTargets`. The factory owns no mutable state;
instance reuse stops being an accumulator. CLI and example thread one blob
instead of two channels. CLI manifest format changes: `cursor` +
`visitedTargets` merge into one `resume` field (approved by Ferran 2026-09-01;
no backward compat needed, nothing external consumes it yet).

Tests that depend on instance-as-accumulator get rewritten to thread the blob.

## Step 4 — folded-in should-fixes

- Throw `ConnectorCursorExpiredError` from listChanges on Drive 410; delete
  `code === 410` sniffing in CLI and example.
- Resolve the `root` folder alias once at construction; backfill and
  incremental share the resolved id (kills the split meaning + retry cache).
- extract.ts: single `downloadBytes()`, module-level export Map.

## Step 5 — follow-ups (separate PRs, not this branch)

- CLI: split dump.ts (reusable) from cli.ts (argv/process)
- examples/sync-test: slim to ~40-line library example
- test file split matching src layout

## Gates

- After each step: `pnpm vitest run` green (76 tests, minus deliberate
  resume-blob rewrites), `pnpm typecheck` green, `pnpm build` green.
- Before merge: Ferran re-runs the live end-to-end check.
