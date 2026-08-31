import { drive_v3, google } from "googleapis";
import { createHash } from "node:crypto";

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

/** A Drive item cannot be extracted through the configured connector. */
export class ConnectorExtractionError extends Error {
  override readonly name = "ConnectorExtractionError";
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
  /** Shortcut targets restored from a previous sync result. */
  knownTargets?: VisitedTargets;
}

export interface VisitedTargets {
  files: string[];
  folders: string[];
}

/** Opaque state used to resume a cursor-based incremental sync. */
export interface GDriveSyncCursor {
  pageToken: string;
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

/** Result of a backfill or incremental sync page. */
export interface GDriveSyncResult {
  documents: ConnectorDocument[];
  removed: string[];
  skipped: SkippedEntry[];
  cursor: GDriveSyncCursor;
  /** Shortcut targets discovered during sync, for persistence by consumers. */
  visitedTargets: VisitedTargets;
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

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const FILE_FIELDS =
  "id,name,mimeType,webViewLink,modifiedTime,parents,trashed,shortcutDetails(targetId,targetMimeType)";

function toDocument(file: drive_v3.Schema$File): ConnectorDocument | undefined {
  if (!file.id || !file.name || !file.mimeType) return undefined;
  // Extraction is step 4; step 3 intentionally emits metadata-complete stubs.
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

/** A configured Google Drive sync connector. */
export interface GDriveConnector {
  listChanges(cursor?: GDriveSyncCursor): Promise<GDriveSyncResult>;
  fetchContent(doc: ConnectorDocument): Promise<ConnectorDocument>;
}

/** Creates a connector that performs backfill and cursor-based incremental sync. */
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
  const knownTargetFiles = new Set(options.knownTargets?.files ?? []);
  const knownTargetFolders = new Set(options.knownTargets?.folders ?? []);
  let resolvedFolderId: Promise<string | undefined> | undefined;

  async function fetchContent(
    doc: ConnectorDocument,
  ): Promise<ConnectorDocument> {
    if (doc.mimeType === FOLDER_MIME || doc.mimeType === SHORTCUT_MIME) {
      throw new ConnectorExtractionError(
        `Cannot extract Google Drive item with mimeType ${doc.mimeType}`,
      );
    }

    const exportMimeType = new Map([
      ["application/vnd.google-apps.document", "text/markdown"],
      ["application/vnd.google-apps.spreadsheet", "text/csv"],
      ["application/vnd.google-apps.presentation", "text/plain"],
    ]).get(doc.mimeType);
    const baseMimeType = doc.mimeType.split(";", 1)[0]?.trim().toLowerCase();
    const isDirectText = baseMimeType === "text/plain" ||
      baseMimeType === "text/markdown";

    let markdown: string;
    if (exportMimeType) {
      const response = await drive.files.export(
        {
          fileId: doc.providerDocId,
          mimeType: exportMimeType,
          supportsAllDrives: true,
        } as drive_v3.Params$Resource$Files$Export,
        { responseType: "text" },
      ) as { data: unknown };
      markdown = typeof response.data === "string"
        ? response.data
        : String(response.data);
    } else if (isDirectText) {
      const response = await drive.files.get(
        {
          fileId: doc.providerDocId,
          alt: "media",
          supportsAllDrives: true,
        },
        { responseType: "arraybuffer" },
      );
      const data = response.data as unknown;
      const bytes = data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
      markdown = new TextDecoder().decode(bytes);
    } else {
      if (!options.parser) {
        throw new ConnectorExtractionError(
          `No parser configured for mimeType ${doc.mimeType}`,
        );
      }
      const response = await drive.files.get(
        {
          fileId: doc.providerDocId,
          alt: "media",
          supportsAllDrives: true,
        },
        { responseType: "arraybuffer" },
      );
      const data = response.data as unknown;
      const bytes = data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
      markdown = await options.parser(bytes, doc.mimeType);
    }

    return {
      ...doc,
      markdown,
      contentHash: createHash("sha256").update(markdown).digest("hex"),
    };
  }

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

  async function backfill(): Promise<GDriveSyncResult> {
    const folderId = configuredFolderId;
    const start = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    if (!start.data.startPageToken) {
      throw new Error("Google Drive returned no start page token");
    }
    const documents: ConnectorDocument[] = [];
    const skipped: SkippedEntry[] = [];
    const visitedFolders = new Set<string>();
    const visitedFiles = new Set<string>();
    const resolvingTargets = new Set<string>();

    const visit = async (
      file: drive_v3.Schema$File,
      traverseFolders = true,
    ): Promise<void> => {
      if (!file.id || file.trashed) return;
      if (file.mimeType === SHORTCUT_MIME) {
        const targetId = file.shortcutDetails?.targetId;
        const recordSkip = (reason: SkippedReason): void => {
          skipped.push({ id: file.id as string, ...(file.name ? { name: file.name } : {}), reason });
        };
        if (!targetId) {
          recordSkip("shortcut_missing_target");
          return;
        }
        if (resolvingTargets.has(targetId)) {
          recordSkip("shortcut_cycle_detected");
          return;
        }
        resolvingTargets.add(targetId);
        try {
          if (file.shortcutDetails?.targetMimeType === FOLDER_MIME) {
            await visit({ id: targetId, mimeType: FOLDER_MIME }, traverseFolders);
            knownTargetFolders.add(targetId);
            return;
          }
          let target;
          try {
            target = await drive.files.get({
              fileId: targetId,
              fields: FILE_FIELDS,
              supportsAllDrives: true,
            });
          } catch {
            recordSkip("shortcut_target_unreadable");
            return;
          }
          if (target.data.trashed) {
            recordSkip("shortcut_target_trashed");
            return;
          }
          await visit(target.data, traverseFolders);
          if (target.data.mimeType === FOLDER_MIME) knownTargetFolders.add(targetId);
          else knownTargetFiles.add(targetId);
        } finally {
          resolvingTargets.delete(targetId);
        }
        return;
      }
      if (file.mimeType === FOLDER_MIME) {
        if (traverseFolders) await walkFolder(file.id);
        return;
      }
      if (visitedFiles.has(file.id)) return;
      visitedFiles.add(file.id);
      const document = toDocument(file);
      if (document) documents.push(document);
    };

    const walkFolder = async (id: string): Promise<void> => {
      if (visitedFolders.has(id)) return;
      visitedFolders.add(id);
      let pageToken: string | undefined;
      do {
        const page = await drive.files.list({
          q: `'${id}' in parents and trashed = false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const file of page.data.files ?? []) await visit(file);
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);
    };

    if (folderId) {
      await walkFolder(folderId);
    } else {
      let pageToken: string | undefined;
      do {
        const page = await drive.files.list({
          q: "trashed = false",
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const file of page.data.files ?? []) await visit(file, false);
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);
    }

    return {
      documents,
      removed: [],
      skipped,
      cursor: { pageToken: start.data.startPageToken },
      visitedTargets: {
        files: [...knownTargetFiles],
        folders: [...knownTargetFolders],
      },
    };
  }

  async function incremental(cursor: GDriveSyncCursor): Promise<GDriveSyncResult> {
    const folderId = await getFolderId();
    requireNonEmpty(cursor.pageToken, "cursor.pageToken");
    const documents: ConnectorDocument[] = [];
    const removed: string[] = [];
    const skipped: SkippedEntry[] = [];
    const visitedFiles = new Set<string>();
    const scopeCache = new Map<string, boolean>();
    if (folderId) scopeCache.set(folderId, true);
    for (const targetId of knownTargetFiles) scopeCache.set(targetId, true);
    for (const targetId of knownTargetFolders) scopeCache.set(targetId, true);
    let requestToken = cursor.pageToken;
    let durableToken = cursor.pageToken;

    const inScope = async (file: drive_v3.Schema$File): Promise<boolean> => {
      if (!folderId || (file.id && (
        knownTargetFiles.has(file.id) || knownTargetFolders.has(file.id)
      ))) return true;
      const path: string[] = [];
      const active = new Set<string>();
      let parents = file.parents ?? [];
      while (parents.length) {
        let nextParents: string[] = [];
        for (const parentId of parents) {
          const cached = scopeCache.get(parentId);
          if (cached !== undefined) {
            for (const id of path) scopeCache.set(id, cached);
            return cached;
          }
          if (active.has(parentId)) continue;
          active.add(parentId);
          path.push(parentId);
          try {
            const parent = await drive.files.get({
              fileId: parentId,
              fields: "id,parents",
              supportsAllDrives: true,
            });
            nextParents.push(...(parent.data.parents ?? []));
          } catch {
            scopeCache.set(parentId, false);
          }
        }
        parents = nextParents;
      }
      for (const id of path) scopeCache.set(id, false);
      return false;
    };

    const resolvingTargets = new Set<string>();
    const walkedFolders = new Set<string>();
    let walkTargetFolder: (id: string) => Promise<void>;
    const emit = async (
      file: drive_v3.Schema$File,
      traverseFolders = false,
    ): Promise<void> => {
      if (!file.id || file.trashed) return;
      if (file.mimeType === SHORTCUT_MIME) {
        const targetId = file.shortcutDetails?.targetId;
        const recordSkip = (reason: SkippedReason): void => {
          skipped.push({ id: file.id as string, ...(file.name ? { name: file.name } : {}), reason });
        };
        if (!targetId) {
          recordSkip("shortcut_missing_target");
          return;
        }
        if (resolvingTargets.has(targetId)) {
          recordSkip("shortcut_cycle_detected");
          return;
        }
        resolvingTargets.add(targetId);
        try {
          if (file.shortcutDetails?.targetMimeType === FOLDER_MIME) {
            knownTargetFolders.add(targetId);
            scopeCache.set(targetId, true);
            if (traverseFolders) await walkTargetFolder(targetId);
            return;
          }
          let target;
          try {
            target = await drive.files.get({
              fileId: targetId,
              fields: FILE_FIELDS,
              supportsAllDrives: true,
            });
          } catch {
            recordSkip("shortcut_target_unreadable");
            return;
          }
          if (target.data.trashed) {
            recordSkip("shortcut_target_trashed");
            return;
          }
          await emit(target.data, traverseFolders);
          if (target.data.mimeType === FOLDER_MIME) knownTargetFolders.add(targetId);
          else knownTargetFiles.add(targetId);
          scopeCache.set(targetId, true);
        } finally {
          resolvingTargets.delete(targetId);
        }
        return;
      }
      if (file.mimeType === FOLDER_MIME) {
        if (traverseFolders) await walkTargetFolder(file.id);
        return;
      }
      if (visitedFiles.has(file.id)) return;
      visitedFiles.add(file.id);
      const document = toDocument(file);
      if (document) documents.push(document);
    };

    walkTargetFolder = async (id: string): Promise<void> => {
      if (walkedFolders.has(id)) return;
      walkedFolders.add(id);
      let pageToken: string | undefined;
      do {
        const page = await drive.files.list({
          q: `'${id}' in parents and trashed = false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const file of page.data.files ?? []) await emit(file, true);
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);
    };

    for (const targetFolderId of [...knownTargetFolders]) {
      await walkTargetFolder(targetFolderId);
    }

    for (;;) {
      const page = await drive.changes.list({
        pageToken: requestToken,
        fields: `nextPageToken,newStartPageToken,changes(removed,fileId,file(${FILE_FIELDS}))`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 1000,
      });
      for (const change of page.data.changes ?? []) {
        const id = change.fileId ?? change.file?.id;
        if (!id) continue;
        if (change.removed || !change.file || change.file.trashed) {
          removed.push(id);
        } else if (await inScope(change.file)) {
          await emit(change.file);
        }
      }
      // This page is fully processed; only now may its successor become durable.
      durableToken = page.data.nextPageToken ?? page.data.newStartPageToken ?? durableToken;
      if (!page.data.nextPageToken) break;
      requestToken = page.data.nextPageToken;
    }
    return {
      documents,
      removed,
      skipped,
      cursor: { pageToken: durableToken },
      visitedTargets: {
        files: [...knownTargetFiles],
        folders: [...knownTargetFolders],
      },
    };
  }

  return {
    listChanges: (cursor) => (cursor ? incremental(cursor) : backfill()),
    fetchContent,
  };
}
