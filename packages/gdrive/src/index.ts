import { drive_v3, google } from "googleapis";

export const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";

/** A document extracted and normalized by a source connector. */
export interface ConnectorDocument {
  providerDocId: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  url?: string;
  modifiedAt: string;
  contentHash: string;
  markdown: string;
}

/** Consumer-provided binary-to-Markdown parser socket. */
export type ParserFn = (
  bytes: Uint8Array,
  mimeType: string,
) => Promise<string>;

/** Service-account JSON key contents supplied by the consumer. */
export interface GDriveServiceAccountAuth {
  type: "service-account";
  keyJson: string;
}

/** OAuth credentials supplied after the consumer completes its own OAuth UI. */
export interface GDriveOAuthRefreshTokenAuth {
  type: "oauth";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type GDriveCredentials =
  | GDriveServiceAccountAuth
  | GDriveOAuthRefreshTokenAuth;

/** @deprecated Use GDriveCredentials. */
export type GDriveAuth = GDriveCredentials;

/** Authentication configuration is invalid or cannot be parsed. */
export class ConnectorAuthError extends Error {
  override readonly name = "ConnectorAuthError";
}

interface ServiceAccountKey {
  client_email?: unknown;
  private_key?: unknown;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new ConnectorAuthError(`${field} must be a non-empty string`);
  }
}

/**
 * Creates an authenticated, read-only Google Drive v3 client.
 *
 * The connector owns no credential storage, OAuth consent redirect, or sync
 * scheduling. Consumers obtain credentials and control those concerns.
 */
export function createDriveClient(
  credentials: GDriveCredentials,
): drive_v3.Drive {
  if (credentials.type === "service-account") {
    requireNonEmpty(credentials.keyJson, "keyJson");

    let key: ServiceAccountKey;
    try {
      key = JSON.parse(credentials.keyJson) as ServiceAccountKey;
    } catch {
      throw new ConnectorAuthError("keyJson must contain valid JSON");
    }

    if (typeof key.client_email !== "string" || key.client_email.trim() === "") {
      throw new ConnectorAuthError(
        "Service-account keyJson must include a non-empty client_email",
      );
    }
    if (typeof key.private_key !== "string" || key.private_key.trim() === "") {
      throw new ConnectorAuthError(
        "Service-account keyJson must include a non-empty private_key",
      );
    }

    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [DRIVE_READONLY_SCOPE],
    });
    return google.drive({ version: "v3", auth });
  }

  requireNonEmpty(credentials.refreshToken, "refreshToken");
  requireNonEmpty(credentials.clientId, "clientId");
  requireNonEmpty(credentials.clientSecret, "clientSecret");

  const auth = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
  );
  auth.setCredentials({
    refresh_token: credentials.refreshToken,
    scope: DRIVE_READONLY_SCOPE,
  });
  return google.drive({ version: "v3", auth });
}

/** Restricts sync to a folder, or explicitly permits all visible files. */
export type GDriveScope =
  | { folder: string; allFiles?: never }
  | { allFiles: true; folder?: never };

/** Configuration for a Google Drive connector instance. */
export interface GDriveConnectorOptions {
  auth: GDriveCredentials;
  scope: GDriveScope;
  parser?: ParserFn;
}

/** Opaque state used to resume a cursor-based incremental sync. */
export interface GDriveSyncCursor {
  pageToken: string;
}

/** Result of a backfill or incremental sync page. */
export interface GDriveSyncResult {
  documents: ConnectorDocument[];
  cursor: GDriveSyncCursor;
}
