import type { drive_v3 } from "googleapis";
import type { ConnectorDocument } from "@triadlabs/connectors-core";
import { resolveItem } from "./resolve.js";
import {
  FILE_FIELDS,
  FOLDER_MIME,
  SHORTCUT_MIME,
} from "./types.js";
import type { WalkState } from "./types.js";

export interface WalkPolicy {
  descend: boolean;
  emitKnownFiles: boolean;
  descendNewTargetFolders: boolean;
}

function toDocument(
  file: drive_v3.Schema$File,
): ConnectorDocument | undefined {
  if (!file.id || !file.name || !file.mimeType) return undefined;
  return {
    providerDocId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ...(file.webViewLink
      ? { webViewLink: file.webViewLink, url: file.webViewLink }
      : {}),
    modifiedAt: file.modifiedTime ?? "",
    contentHash: "",
    markdown: "",
  };
}

export async function* listChildren(
  drive: drive_v3.Drive,
  folderId?: string,
): AsyncGenerator<drive_v3.Schema$File> {
  let pageToken: string | undefined;
  do {
    const page = await drive.files.list({
      q: folderId
        ? `'${folderId}' in parents and trashed = false`
        : "trashed = false",
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const file of page.data.files ?? []) yield file;
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
}

export async function walk(
  start: string | Iterable<drive_v3.Schema$File>,
  policy: WalkPolicy,
  state: WalkState,
): Promise<void> {
  const walkFolder = async (id: string): Promise<void> => {
    if (state.visitedFolders.has(id)) return;
    state.visitedFolders.add(id);
    for await (const child of listChildren(state.drive, id)) {
      await visit(child, policy.descend);
    }
  };

  const visit = async (
    file: drive_v3.Schema$File,
    descend: boolean,
  ): Promise<void> => {
    const wasShortcut = file.mimeType === SHORTCUT_MIME;
    const targetId = wasShortcut ? file.shortcutDetails?.targetId : undefined;
    const targetWasKnownFolder = targetId
      ? state.knownTargetFolders.has(targetId)
      : false;
    const resolved = await resolveItem(file, state);
    if (!resolved) return;
    if (resolved.kind === "skip") {
      state.skipped.push({
        id: resolved.id,
        ...(resolved.name ? { name: resolved.name } : {}),
        reason: resolved.reason,
      });
      return;
    }
    if (resolved.kind === "folder") {
      const isTarget = wasShortcut || state.resolvingTargets.has(resolved.id);
      if (isTarget) {
        state.knownTargetFolders.add(resolved.id);
        state.scopeCache?.set(resolved.id, true);
      }
      if (
        descend ||
        (isTarget && !targetWasKnownFolder && policy.descendNewTargetFolders)
      ) {
        await walkFolder(resolved.id);
      }
      return;
    }

    const resolvedFile = resolved.file;
    if (!resolvedFile.id) return;
    const isTarget = wasShortcut || state.resolvingTargets.has(resolvedFile.id);
    if (isTarget) {
      state.knownTargetFiles.add(resolvedFile.id);
      state.scopeCache?.set(resolvedFile.id, true);
    } else if (descend && !policy.emitKnownFiles) {
      const wasKnownTarget = state.knownTargetFiles.has(resolvedFile.id);
      state.knownTargetFiles.add(resolvedFile.id);
      state.scopeCache?.set(resolvedFile.id, true);
      if (wasKnownTarget) return;
    }
    if (state.visitedFiles.has(resolvedFile.id)) return;
    state.visitedFiles.add(resolvedFile.id);
    const document = toDocument(resolvedFile);
    if (document) state.documents.push(document);
  };

  if (typeof start === "string") {
    await walkFolder(start);
  } else {
    for (const file of start) await visit(file, policy.descend);
  }
}
