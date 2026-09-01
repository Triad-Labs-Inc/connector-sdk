import type { drive_v3 } from "googleapis";
import { FILE_FIELDS, FOLDER_MIME, SHORTCUT_MIME } from "./types.js";
import type { SkippedReason, WalkState } from "./types.js";

export type Resolved =
  | { kind: "skip"; id: string; name?: string; reason: SkippedReason }
  | { kind: "folder"; id: string }
  | { kind: "file"; file: drive_v3.Schema$File };

export async function resolveItem(
  file: drive_v3.Schema$File,
  state: WalkState,
): Promise<Resolved | undefined> {
  if (!file.id || file.trashed) return undefined;
  if (file.mimeType !== SHORTCUT_MIME) {
    return file.mimeType === FOLDER_MIME
      ? { kind: "folder", id: file.id }
      : { kind: "file", file };
  }

  const shortcutId = file.id;
  const skip = (reason: SkippedReason): Resolved => ({
    kind: "skip",
    id: shortcutId,
    ...(file.name ? { name: file.name } : {}),
    reason,
  });
  const targetId = file.shortcutDetails?.targetId;
  if (!targetId) return skip("shortcut_missing_target");
  if (state.resolvingTargets.has(targetId)) {
    return skip("shortcut_cycle_detected");
  }

  state.resolvingTargets.add(targetId);
  try {
    if (file.shortcutDetails?.targetMimeType === FOLDER_MIME) {
      return { kind: "folder", id: targetId };
    }
    let target: drive_v3.Schema$File;
    try {
      const response = await state.drive.files.get({
        fileId: targetId,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      target = response.data;
    } catch {
      return skip("shortcut_target_unreadable");
    }
    if (target.trashed) return skip("shortcut_target_trashed");
    return await resolveItem(target, state);
  } finally {
    state.resolvingTargets.delete(targetId);
  }
}
