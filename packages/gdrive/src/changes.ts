import type { drive_v3 } from "googleapis";
import {
  ConnectorCursorExpiredError,
  type ConnectorDocument,
} from "@triadlabs/connectors-core";
import { requireNonEmpty } from "./auth.js";
import { FILE_FIELDS } from "./types.js";
import type {
  GDriveSyncCursor,
  GDriveSyncResume,
  GDriveSyncResult,
  SkippedEntry,
  WalkState,
} from "./types.js";
import { listChildren, walk } from "./walk.js";

interface ListChangesOptions {
  drive: drive_v3.Drive;
  getFolderId: () => Promise<string | undefined>;
}

interface RunOptions extends ListChangesOptions {
  knownTargetFiles: Set<string>;
  knownTargetFolders: Set<string>;
}

async function getStartPageToken(drive: drive_v3.Drive): Promise<string> {
  const start = await drive.changes.getStartPageToken({ supportsAllDrives: true });
  if (!start.data.startPageToken) {
    throw new Error("Google Drive returned no start page token");
  }
  return start.data.startPageToken;
}

function createWalkState(
  options: RunOptions,
  documents: ConnectorDocument[],
  skipped: SkippedEntry[],
  scopeCache?: Map<string, boolean>,
): WalkState {
  return {
    drive: options.drive,
    documents,
    skipped,
    visitedFiles: new Set(),
    visitedFolders: new Set(),
    resolvingTargets: new Set(),
    knownTargetFiles: options.knownTargetFiles,
    knownTargetFolders: options.knownTargetFolders,
    scopeCache,
  };
}

export function createListChanges(options: ListChangesOptions): (
  resume?: GDriveSyncResume,
) => Promise<GDriveSyncResult> {
  return async (resume) => {
  const runOptions: RunOptions = {
    ...options,
    knownTargetFiles: new Set(resume?.visitedTargets?.files ?? []),
    knownTargetFolders: new Set(resume?.visitedTargets?.folders ?? []),
  };

  const result = (
    documents: ConnectorDocument[],
    removed: string[],
    skipped: SkippedEntry[],
    pageToken: string,
  ): GDriveSyncResult => ({
    documents,
    removed,
    skipped,
    cursor: { pageToken },
    visitedTargets: {
      files: [...runOptions.knownTargetFiles],
      folders: [...runOptions.knownTargetFolders],
    },
  });

  const backfill = async (): Promise<GDriveSyncResult> => {
    const pageToken = await getStartPageToken(options.drive);
    const folderId = await options.getFolderId();
    const documents: ConnectorDocument[] = [];
    const skipped: SkippedEntry[] = [];
    const state = createWalkState(runOptions, documents, skipped);

    if (folderId) {
      await walk(folderId, {
        descend: true,
        emitKnownFiles: true,
        descendNewTargetFolders: true,
      }, state);
    } else {
      for await (const file of listChildren(options.drive)) {
        await walk([file], {
          descend: false,
          emitKnownFiles: true,
          descendNewTargetFolders: true,
        }, state);
      }
    }
    return result(documents, [], skipped, pageToken);
  };

  const incremental = async (
    cursor: GDriveSyncCursor,
  ): Promise<GDriveSyncResult> => {
    const folderId = await options.getFolderId();
    requireNonEmpty(cursor.pageToken, "cursor.pageToken");
    const documents: ConnectorDocument[] = [];
    const removed: string[] = [];
    const skipped: SkippedEntry[] = [];
    const scopeCache = new Map<string, boolean>();
    if (folderId) scopeCache.set(folderId, true);
    for (const id of runOptions.knownTargetFiles) scopeCache.set(id, true);
    for (const id of runOptions.knownTargetFolders) scopeCache.set(id, true);
    const state = createWalkState(runOptions, documents, skipped, scopeCache);

    const inScope = async (file: drive_v3.Schema$File): Promise<boolean> => {
      if (!folderId || (file.id && (
        runOptions.knownTargetFiles.has(file.id) ||
        runOptions.knownTargetFolders.has(file.id)
      ))) return true;
      const path: string[] = [];
      const active = new Set<string>();
      let parents = file.parents ?? [];
      while (parents.length) {
        const nextParents: string[] = [];
        for (const parentId of parents) {
          const cached = scopeCache.get(parentId);
          if (cached !== undefined) {
            for (const id of path) scopeCache.set(id, cached);
            return cached;
          }
          if (active.has(parentId)) continue;
          active.add(parentId);
          path.push(parentId);
          try {
            const parent = await options.drive.files.get({
              fileId: parentId,
              fields: "id,parents",
              supportsAllDrives: true,
            });
            nextParents.push(...(parent.data.parents ?? []));
          } catch {
            scopeCache.set(parentId, false);
          }
        }
        parents = nextParents;
      }
      for (const id of path) scopeCache.set(id, false);
      return false;
    };

    for (const targetFolderId of [...runOptions.knownTargetFolders]) {
      await walk(targetFolderId, {
        descend: true,
        emitKnownFiles: false,
        descendNewTargetFolders: true,
      }, state);
    }

    let requestToken = cursor.pageToken;
    let durableToken = cursor.pageToken;
    for (;;) {
      let page;
      try {
        page = await options.drive.changes.list({
          pageToken: requestToken,
          fields: `nextPageToken,newStartPageToken,changes(removed,fileId,file(${FILE_FIELDS}))`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageSize: 1000,
        });
      } catch (error) {
        const candidate = error as {
          code?: unknown;
          response?: { status?: unknown };
        };
        if (candidate.code === 410 || candidate.response?.status === 410) {
          throw new ConnectorCursorExpiredError();
        }
        throw error;
      }
      for (const change of page.data.changes ?? []) {
        const id = change.fileId ?? change.file?.id;
        if (!id) continue;
        if (change.removed || !change.file || change.file.trashed) {
          removed.push(id);
        } else if (await inScope(change.file)) {
          await walk([change.file], {
            descend: false,
            emitKnownFiles: true,
            descendNewTargetFolders: true,
          }, state);
        }
      }
      durableToken = page.data.nextPageToken ??
        page.data.newStartPageToken ?? durableToken;
      if (!page.data.nextPageToken) break;
      requestToken = page.data.nextPageToken;
    }
    return result(documents, removed, skipped, durableToken);
  };

  return resume?.cursor ? incremental(resume.cursor) : backfill();
  };
}
