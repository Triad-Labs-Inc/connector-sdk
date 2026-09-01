import { drive_v3, google } from "googleapis";
import { ConnectorAuthError } from "@triadlabs/connectors-core";

export const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";

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

interface ServiceAccountKey {
  client_email?: unknown;
  private_key?: unknown;
}

export function requireNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConnectorAuthError(`${field} must be a non-empty string`);
  }
}

export function requireRecord(
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
