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

/** Service-account credentials supplied by the consumer. */
export interface GDriveServiceAccountAuth {
  type: "serviceAccount";
  clientEmail: string;
  privateKey: string;
  projectId?: string;
  subject?: string;
}

/** OAuth credentials supplied after the consumer completes its own OAuth UI. */
export interface GDriveOAuthRefreshTokenAuth {
  type: "oauthRefreshToken";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type GDriveAuth =
  | GDriveServiceAccountAuth
  | GDriveOAuthRefreshTokenAuth;

/** Restricts sync to a folder, or explicitly permits all visible files. */
export type GDriveScope =
  | { folder: string; allFiles?: never }
  | { allFiles: true; folder?: never };

/** Configuration for a Google Drive connector instance. */
export interface GDriveConnectorOptions {
  auth: GDriveAuth;
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
