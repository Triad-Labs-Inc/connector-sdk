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

/** Google OAuth application settings used during the consent flow. */
export interface GDriveOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Opaque value returned by Google for request/callback correlation. */
  state?: string;
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

/** Google Drive scope configuration is invalid. */
export class ConnectorScopeError extends Error {
  override readonly name = "ConnectorScopeError";
}

interface ServiceAccountKey {
  client_email?: unknown;
  private_key?: unknown;
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConnectorAuthError(`${field} must be a non-empty string`);
  }
}

function requireRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConnectorAuthError(`${field} must be an object`);
  }
}

function createOAuth2Client(config: GDriveOAuthClientConfig) {
  requireRecord(config, "config");
  requireNonEmpty(config.clientId, "clientId");
  requireNonEmpty(config.clientSecret, "clientSecret");
  requireNonEmpty(config.redirectUri, "redirectUri");
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
}

/**
 * Builds a Google consent URL that requests a reusable refresh token.
 *
 * Both offline access and an explicit consent prompt are intentional: Google
 * may otherwise omit the refresh token without reporting an error.
 */
export function getAuthorizationUrl(config: GDriveOAuthClientConfig): string {
  requireRecord(config, "config");
  if (config.state !== undefined) requireNonEmpty(config.state, "state");
  return createOAuth2Client(config).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [DRIVE_READONLY_SCOPE],
    ...(config.state ? { state: config.state } : {}),
  });
}

/** Exchanges a Google authorization code for reusable OAuth credentials. */
export async function exchangeAuthorizationCode(
  config: GDriveOAuthClientConfig & { code: string },
): Promise<{
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
}> {
  requireRecord(config, "config");
  requireNonEmpty(config.code, "code");
  const auth = createOAuth2Client(config);
  const { tokens } = await auth.getToken(config.code);

  if (!tokens.refresh_token) {
    throw new ConnectorAuthError(
      "Google returned no refresh_token. Generate the consent URL with " +
        'access_type:"offline" and prompt:"consent", then authorize again.',
    );
  }

  return {
    refreshToken: tokens.refresh_token,
    ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
    ...(typeof tokens.expiry_date === "number"
      ? { expiryDate: tokens.expiry_date }
      : {}),
  };
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
  requireRecord(credentials, "credentials");
  if (credentials.type === "service-account") {
    requireNonEmpty(credentials.keyJson, "keyJson");

    let key: ServiceAccountKey;
    try {
      key = JSON.parse(credentials.keyJson) as ServiceAccountKey;
    } catch {
      throw new ConnectorAuthError("keyJson must contain valid JSON");
    }

    if (
      typeof key !== "object" ||
      key === null ||
      Array.isArray(key) ||
      typeof key.client_email !== "string" ||
      key.client_email.trim() === ""
    ) {
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

  if (credentials.type !== "oauth") {
    throw new ConnectorAuthError(
      'credentials.type must be "service-account" or "oauth"',
    );
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
  removed: string[];
  cursor: GDriveSyncCursor;
  /** Shortcut target IDs discovered during backfill, for persistence by consumers. */
  visitedTargets?: string[];
}

const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]+$/;

/** Parses a bare Drive folder ID or a standard Drive folder URL. */
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
    const match = url.pathname.match(/^\/drive\/folders\/([^/]+)\/?$/);
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
