import {
  ConnectorScopeError,
  type ParserFn,
} from "@triadlabs/connectors-core";
import { createDriveClient, requireRecord } from "./auth.js";
import { createIterateChanges } from "./stream.js";
import { createListChanges } from "./changes.js";
import { createFetchContent } from "./extract.js";
import type {
  GDriveConnector,
  GDriveConnectorOptions,
} from "./types.js";

export {
  ConnectorRescanRequiredError,
  ConnectorProviderError,
  ConnectorResumeError,
  ConnectorAuthError,
  ConnectorCursorExpiredError,
  ConnectorExtractionError,
  ConnectorScopeError,
  type Connector,
  type ConnectorDocument,
  type ParserFn,
} from "@triadlabs/connectors-core";
export {
  createDriveClient,
  DRIVE_READONLY_SCOPE,
  exchangeAuthorizationCode,
  getAuthorizationUrl,
  type GDriveAuth,
  type GDriveCredentials,
  type GDriveOAuthClientConfig,
  type GDriveOAuthRefreshTokenAuth,
  type GDriveServiceAccountAuth,
} from "./auth.js";
export type {
  GDriveConnector,
  GDriveConnectorOptions,
  GDriveCheckpoint,
  GDriveStreamEvent,
  GDriveScope,
  GDriveSyncCursor,
  GDriveSyncResume,
  GDriveSyncResult,
  SkippedEntry,
  SkippedReason,
  VisitedTargets,
} from "./types.js";

const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]+$/;

export function parseGDriveFolderId(folder: string): string {
  if (typeof folder !== "string" || folder.trim() === "") {
    throw new ConnectorScopeError("scope.folder must be a Drive folder ID or URL");
  }
  const value = folder.trim();
  let id = value;
  if (value.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConnectorScopeError("scope.folder must be a valid Drive folder URL");
    }
    const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([^/]+)\/?$/);
    if (url.hostname !== "drive.google.com" || !match) {
      throw new ConnectorScopeError("scope.folder must be a Drive folder URL");
    }
    id = match[1] ?? "";
  }
  if (!DRIVE_FOLDER_ID.test(id)) {
    throw new ConnectorScopeError("scope.folder contains an invalid Drive folder ID");
  }
  return id;
}

export function createGDriveConnector(
  options: GDriveConnectorOptions,
): GDriveConnector {
  requireRecord(options, "options");
  requireRecord(options.scope, "scope");
  const configuredFolderId = "folder" in options.scope
    ? parseGDriveFolderId(options.scope.folder as string)
    : undefined;
  if (!configuredFolderId && options.scope.allFiles !== true) {
    throw new ConnectorScopeError(
      'scope must contain either "folder" or allFiles: true',
    );
  }

  const drive = createDriveClient(options.auth);
  let resolvedFolderId: Promise<string | undefined> | undefined;
  const getFolderId = (): Promise<string | undefined> => {
    resolvedFolderId ??= (configuredFolderId === "root"
      ? drive.files.get({
          fileId: "root",
          fields: "id",
          supportsAllDrives: true,
        }).then(({ data }) => data.id ?? "root")
      : Promise.resolve(configuredFolderId)).catch((error: unknown) => {
        resolvedFolderId = undefined;
        throw error;
      });
    return resolvedFolderId;
  };
  return {
    iterateChanges: createIterateChanges({ drive, getFolderId }),
    listChanges: createListChanges({
      drive,
      getFolderId,
    }),
    fetchContent: createFetchContent(drive, options.parser as ParserFn | undefined),
  };
}
