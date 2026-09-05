import type { drive_v3 } from "googleapis";
import { createIterateChanges } from "./stream.js";
import type { GDriveSyncResume, GDriveSyncResult } from "./types.js";

/** Compatibility accumulator over the same provider events used by durable consumers. */
export function createListChanges(options: {
  drive: drive_v3.Drive;
  getFolderId: () => Promise<string | undefined>;
}) {
  const iterate = createIterateChanges(options);
  return async (resume?: GDriveSyncResume): Promise<GDriveSyncResult> => {
    const documents = new Map<string, GDriveSyncResult["documents"][number]>();
    const removed = new Set<string>();
    const skipped: GDriveSyncResult["skipped"] = [];
    for await (const event of iterate(resume)) {
      if (event.kind === "document") {
        removed.delete(event.document.providerDocId);
        documents.set(event.document.providerDocId, event.document);
      } else if (event.kind === "removed") {
        documents.delete(event.providerDocId);
        removed.add(event.providerDocId);
      } else if (event.kind === "skipped") skipped.push(event.entry);
      else if (event.kind === "complete") return {
        documents: [...documents.values()], removed: [...removed], skipped,
        cursor: event.resume.cursor, visitedTargets: event.resume.visitedTargets,
        coverage: event.coverage,
      };
    }
    throw new Error("Drive discovery ended without completion");
  };
}
