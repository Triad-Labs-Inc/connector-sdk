import type { drive_v3 } from "googleapis";
import { ConnectorCursorExpiredError, ConnectorResumeError, ConnectorRescanRequiredError } from "@triadlabs/connectors-core";
import { providerError, providerStatus } from "./provider-error.js";
import { FILE_FIELDS, FOLDER_MIME, SHORTCUT_MIME } from "./types.js";
import type { GDriveCheckpoint, GDriveStreamEvent, GDriveSyncResume, SkippedEntry } from "./types.js";

interface Options {
  drive: drive_v3.Drive;
  getFolderId: (signal?: AbortSignal) => Promise<string | undefined>;
}

function copy<T>(value: T): T { return structuredClone(value); }
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Checkpoints may have crossed a JSON/database boundary. Reject invalid state. */
function validate(value: GDriveCheckpoint, scope: string): void {
  if (value.version !== 1 || value.scope !== scope ||
      !["backfill", "incremental", "idle"].includes(value.phase) ||
      typeof value.cursor?.pageToken !== "string" || !value.cursor.pageToken ||
      !strings(value.visitedFiles) || !strings(value.visitedFolders) ||
      !strings(value.visitedTargets?.files) || !strings(value.visitedTargets?.folders) ||
      !Array.isArray(value.pendingFolders) || !value.pendingFolders.every(folder =>
        folder && (folder.id === null || typeof folder.id === "string") &&
        (folder.pageToken === undefined || typeof folder.pageToken === "string")) ||
      !Number.isSafeInteger(value.filesDiscovered) || value.filesDiscovered < 0 ||
      !Number.isSafeInteger(value.foldersVisited) || value.foldersVisited < 0 ||
      !["complete", "partial"].includes(value.coverage)) {
    throw new ConnectorResumeError("Invalid checkpoint version, state, or source scope; start a new backfill");
  }
  if (value.phase !== "backfill" && value.pendingFolders.length > 0) {
    throw new ConnectorResumeError("Unexpected pending folders outside backfill");
  }
}

export function createIterateChanges({ drive, getFolderId }: Options) {
  async function* run(
    resume?: GDriveCheckpoint | GDriveSyncResume,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<GDriveStreamEvent> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (resume !== undefined && (resume === null || typeof resume !== "object" || Array.isArray(resume))) {
      throw new ConnectorResumeError("Resume state must be an object");
    }
    const folderId = await getFolderId(signal);
    const scope = folderId ? `folder:${folderId}` : "allFiles";
    let state: GDriveCheckpoint;
    if (resume && "version" in resume) {
      validate(resume, scope);
      state = copy(resume);
      if (state.phase === "idle") {
        state.phase = "incremental";
        state.visitedFiles = [];
        state.filesDiscovered = 0;
        state.foldersVisited = 0;
        state.coverage = "complete";
      }
    } else {
      if (resume && (Object.keys(resume).some(key => !["cursor", "visitedTargets"].includes(key)) ||
          (resume.cursor !== undefined && (typeof resume.cursor?.pageToken !== "string" || !resume.cursor.pageToken)) ||
          (resume.visitedTargets !== undefined && (!strings(resume.visitedTargets?.files) || !strings(resume.visitedTargets?.folders))))) {
        throw new ConnectorResumeError("Invalid legacy resume state");
      }
      let token = resume?.cursor?.pageToken;
      if (!token) {
        const response = await drive.changes.getStartPageToken({ supportsAllDrives: true }, { signal });
        token = response.data.startPageToken ?? undefined;
        if (!token) throw new Error("Google Drive returned no start page token");
        if (folderId) {
          const root = await drive.files.get({ fileId: folderId, fields: "id,mimeType,trashed", supportsAllDrives: true }, { signal });
          if (root.data.mimeType !== FOLDER_MIME || root.data.trashed) throw new ConnectorResumeError("Source folder is unavailable or is not a folder");
        }
      }
      state = {
        version: 1, scope, phase: resume?.cursor ? "incremental" : "backfill",
        cursor: { pageToken: token }, pendingFolders: resume?.cursor ? [] : [{ id: folderId ?? null }],
        visitedFiles: [], visitedFolders: [],
        visitedTargets: copy(resume?.cursor ? resume.visitedTargets ?? { files: [], folders: [] } : { files: [], folders: [] }),
        filesDiscovered: 0, foldersVisited: 0, coverage: "complete",
      };
    }
    const phase = state.phase as "backfill" | "incremental";
    const seenFiles = new Set(state.visitedFiles);
    const seenFolders = new Set(state.visitedFolders);

    async function resolve(file: drive_v3.Schema$File, chain = new Set<string>()): Promise<drive_v3.Schema$File | SkippedEntry> {
      if (file.mimeType !== SHORTCUT_MIME) return file;
      const id = file.id!;
      const targetId = file.shortcutDetails?.targetId;
      const skip = (reason: SkippedEntry["reason"]): SkippedEntry => ({ id, name: file.name ?? undefined, reason });
      if (!targetId) return skip("shortcut_missing_target");
      if (chain.has(targetId)) return skip("shortcut_cycle_detected");
      chain.add(targetId);
      let target;
      try {
        target = await drive.files.get({ fileId: targetId, fields: FILE_FIELDS, supportsAllDrives: true }, { signal });
      } catch (error) {
        const status = providerStatus(error);
        if (status === 404) return skip("shortcut_target_unreadable");
        throw error;
      }
      if (target.data.trashed) return skip("shortcut_target_trashed");
      return resolve(target.data, chain);
    }

    async function* document(file: drive_v3.Schema$File, descend: boolean): AsyncGenerator<GDriveStreamEvent> {
      signal?.throwIfAborted();
      if (!file.id) throw new Error("Drive returned a file without an ID");
      if (file.trashed) return;
      const shortcut = file.mimeType === SHORTCUT_MIME;
      const resolved = await resolve(file);
      if ("reason" in resolved) {
        state.coverage = "partial";
        yield { kind: "skipped", entry: resolved as SkippedEntry };
        return;
      }
      const item = resolved as drive_v3.Schema$File;
      if (!item.id) throw new Error("Drive returned a file without an ID");
      if (item.mimeType === FOLDER_MIME) {
        if (shortcut && !state.visitedTargets.folders.includes(item.id)) state.visitedTargets.folders.push(item.id);
        if (descend && !seenFolders.has(item.id)) {
          seenFolders.add(item.id);
          state.visitedFolders.push(item.id);
          state.pendingFolders.push({ id: item.id });
        }
        return;
      }
      if (shortcut && !state.visitedTargets.files.includes(item.id)) state.visitedTargets.files.push(item.id);
      if (phase === "backfill" && seenFiles.has(item.id)) return;
      if (!item.name || !item.mimeType) throw new Error(`Drive returned incomplete metadata for ${item.id}`);
      seenFiles.add(item.id);
      if (phase === "backfill") state.visitedFiles.push(item.id);
      state.filesDiscovered++;
      yield { kind: "document", discoveredVia: shortcut ? "shortcut" : "direct", document: {
        providerDocId: item.id, name: item.name, mimeType: item.mimeType,
        modifiedAt: item.modifiedTime ?? "", contentHash: "", markdown: "",
        ...(item.webViewLink ? { url: item.webViewLink, webViewLink: item.webViewLink } : {}),
      } };
    }

    async function inScope(file: drive_v3.Schema$File): Promise<boolean> {
      if (!folderId) return true;
      if (file.id && state.visitedTargets.files.includes(file.id)) return true;
      const parents = [...(file.parents ?? [])];
      const seen = new Set<string>();
      while (parents.length) {
        const id = parents.pop()!;
        if (id === folderId || state.visitedTargets.folders.includes(id)) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const parent = await drive.files.get({ fileId: id, fields: "id,parents", supportsAllDrives: true }, { signal });
          parents.push(...(parent.data.parents ?? []));
        } catch (error) {
          if (providerStatus(error) === 404) throw new ConnectorRescanRequiredError("A parent is no longer readable; rescan source membership");
          throw error;
        }
      }
      return false;
    }

    if (phase === "backfill") {
      while (state.pendingFolders.length) {
        signal?.throwIfAborted();
        const folder = state.pendingFolders[0]!;
        if (folder.id && !seenFolders.has(folder.id)) {
          seenFolders.add(folder.id);
          state.visitedFolders.push(folder.id);
        }
        const page = await drive.files.list({
          q: folder.id ? `'${folder.id}' in parents and trashed = false` : "trashed = false",
          pageToken: folder.pageToken, pageSize: 1000,
          fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        }, { signal });
        if (page.data.incompleteSearch) state.coverage = "partial";
        for (const file of page.data.files ?? []) yield* document(file, folder.id !== null || file.mimeType === SHORTCUT_MIME);
        if (page.data.nextPageToken) folder.pageToken = page.data.nextPageToken;
        else { state.pendingFolders.shift(); state.foldersVisited++; }
        signal?.throwIfAborted();
        yield { kind: "progress", phase, filesDiscovered: state.filesDiscovered, foldersVisited: state.foldersVisited };
        yield { kind: "checkpoint", resume: copy(state) };
      }
    } else {
      for (;;) {
        signal?.throwIfAborted();
        let page;
        try {
          page = await drive.changes.list({
            pageToken: state.cursor.pageToken, pageSize: 1000,
            fields: `nextPageToken,newStartPageToken,changes(removed,fileId,file(${FILE_FIELDS}))`,
            supportsAllDrives: true, includeItemsFromAllDrives: true,
          }, { signal });
        } catch (error) {
          if ((error as { response?: { status?: number }; code?: number }).response?.status === 410 || (error as { code?: number }).code === 410) throw new ConnectorCursorExpiredError();
          throw error;
        }
        for (const change of page.data.changes ?? []) {
          const id = change.fileId ?? change.file?.id;
          if (!id) throw new Error("Drive change is missing its file ID");
          const structural = change.file?.mimeType === FOLDER_MIME || change.file?.mimeType === SHORTCUT_MIME;
          const uncertainRemoval = (change.removed || !change.file || change.file.trashed) &&
            (folderId !== undefined || state.visitedTargets.files.length > 0 || state.visitedTargets.folders.length > 0);
          if ((structural && (folderId !== undefined || change.file?.mimeType === SHORTCUT_MIME)) || uncertainRemoval) {
            throw new ConnectorRescanRequiredError("Drive folder, shortcut, or removal changed source reachability; run a new backfill");
          }
          if (change.removed || !change.file || change.file.trashed) {
            yield { kind: "removed", providerDocId: id, reason: change.file?.trashed ? "trashed" : "accessLost" };
          } else if (await inScope(change.file)) yield* document(change.file, false);
          else yield { kind: "removed", providerDocId: id, reason: "outOfScope" };
        }
        const token = page.data.nextPageToken ?? page.data.newStartPageToken;
        if (!token) throw new Error("Drive returned no continuation token");
        state.cursor = { pageToken: token };
        const done = !page.data.nextPageToken;
        if (done) state.phase = "idle";
        signal?.throwIfAborted();
        yield { kind: "progress", phase, filesDiscovered: state.filesDiscovered, foldersVisited: state.foldersVisited };
        yield { kind: "checkpoint", resume: copy(state) };
        if (done) break;
      }
    }
    state.phase = "idle";
    state.visitedFiles = [];
    signal?.throwIfAborted();
    yield { kind: "complete", phase, coverage: state.coverage, resume: copy(state) };
  }
  return async function* iterateChanges(resume?: GDriveCheckpoint | GDriveSyncResume, options: { signal?: AbortSignal } = {}): AsyncGenerator<GDriveStreamEvent> {
    try { yield* run(resume, options); }
    catch (error) { options.signal?.throwIfAborted(); throw providerError(error, "Drive discovery"); }
  };
}
