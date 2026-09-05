import type { drive_v3 } from "googleapis";
import type {
  Connector,
  ConnectorDocument,
  ParserFn,
} from "@triadlabs/connectors-core";
import type { GDriveCredentials } from "./auth.js";

export type GDriveScope =
  | { folder: string; allFiles?: never }
  | { allFiles: true; folder?: never };

export interface GDriveConnectorOptions {
  auth: GDriveCredentials;
  scope: GDriveScope;
  parser?: ParserFn;
}

export interface VisitedTargets {
  files: string[];
  folders: string[];
}

export interface GDriveSyncCursor {
  pageToken: string;
}

export interface GDriveSyncResume {
  cursor?: GDriveSyncCursor;
  visitedTargets?: VisitedTargets;
}

export type SkippedReason =
  | "shortcut_missing_target"
  | "shortcut_cycle_detected"
  | "shortcut_target_unreadable"
  | "shortcut_target_trashed";

export interface SkippedEntry {
  id: string;
  name?: string;
  reason: SkippedReason;
}

export interface GDriveSyncResult {
  documents: ConnectorDocument[];
  removed: string[];
  skipped: SkippedEntry[];
  cursor: GDriveSyncCursor;
  visitedTargets: VisitedTargets;
}

export interface GDriveConnector extends Connector<
  GDriveSyncResume,
  GDriveSyncResult,
  ConnectorDocument
> {
  iterateChanges(resume?: GDriveCheckpoint | GDriveSyncResume, options?: { signal?: AbortSignal }): AsyncIterable<GDriveStreamEvent>;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
export const FILE_FIELDS =
  "id,name,mimeType,webViewLink,modifiedTime,parents,trashed,shortcutDetails(targetId,targetMimeType)";

export interface WalkState {
  drive: drive_v3.Drive;
  documents: ConnectorDocument[];
  skipped: SkippedEntry[];
  visitedFiles: Set<string>;
  visitedFolders: Set<string>;
  resolvingTargets: Set<string>;
  knownTargetFiles: Set<string>;
  knownTargetFolders: Set<string>;
  scopeCache?: Map<string, boolean>;
}

/** Opaque, serializable state. Persist the entire object after prior writes commit. */
export interface GDriveCheckpoint {
  version: 1;
  scope: string;
  phase: "backfill" | "incremental" | "idle";
  cursor: GDriveSyncCursor;
  pendingFolders: Array<{ id: string | null; pageToken?: string }>;
  visitedFiles: string[];
  visitedFolders: string[];
  visitedTargets: VisitedTargets;
  filesDiscovered: number;
  foldersVisited: number;
  coverage: "complete" | "partial";
}

export type GDriveStreamEvent =
  | { kind: "document"; document: ConnectorDocument; discoveredVia: "direct" | "shortcut" }
  | { kind: "removed"; providerDocId: string; reason: "deleted" | "trashed" | "outOfScope" | "accessLost" }
  | { kind: "skipped"; entry: SkippedEntry }
  | { kind: "progress"; phase: "backfill" | "incremental"; filesDiscovered: number; foldersVisited: number }
  | { kind: "checkpoint"; resume: GDriveCheckpoint }
  | { kind: "complete"; phase: "backfill" | "incremental"; coverage: "complete" | "partial"; resume: GDriveCheckpoint };
