import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  driveMock,
  generateAuthUrlMock,
  getTokenMock,
  jwtMock,
  oauth2Mock,
  setCredentialsMock,
  filesListMock,
  filesGetMock,
  filesExportMock,
  changesListMock,
  startTokenMock,
} = vi.hoisted(() => ({
  driveMock: vi.fn(),
  generateAuthUrlMock: vi.fn(() => "https://accounts.google.com/o/oauth2/auth"),
  getTokenMock: vi.fn(),
  jwtMock: vi.fn(function () {}),
  oauth2Mock: vi.fn(function () {}),
  setCredentialsMock: vi.fn(),
  filesListMock: vi.fn(),
  filesGetMock: vi.fn(),
  filesExportMock: vi.fn(),
  changesListMock: vi.fn(),
  startTokenMock: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      JWT: jwtMock,
      OAuth2: oauth2Mock,
    },
    drive: driveMock,
  },
}));

import {
  ConnectorAuthError,
  ConnectorCursorExpiredError,
  ConnectorExtractionError,
  ConnectorScopeError,
  createGDriveConnector,
  createDriveClient,
  DRIVE_READONLY_SCOPE,
  exchangeAuthorizationCode,
  getAuthorizationUrl,
  parseGDriveFolderId,
} from "../src/index.js";

const auth = {
  type: "oauth" as const,
  clientId: "id",
  clientSecret: "secret",
  refreshToken: "token",
};

function configureDriveMock(): void {
  driveMock.mockReturnValue({
    files: { list: filesListMock, get: filesGetMock, export: filesExportMock },
    changes: { list: changesListMock, getStartPageToken: startTokenMock },
  });
}

function configureOAuth2Mock(): void {
  oauth2Mock.mockImplementation(function (this: {
    generateAuthUrl: typeof generateAuthUrlMock;
    getToken: typeof getTokenMock;
    setCredentials: typeof setCredentialsMock;
  }) {
    this.generateAuthUrl = generateAuthUrlMock;
    this.getToken = getTokenMock;
    this.setCredentials = setCredentialsMock;
  });
}

describe("createDriveClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureOAuth2Mock();
    configureDriveMock();
  });

  it("builds a Drive client from a service-account key", () => {
    const keyJson = JSON.stringify({
      client_email: "connector@example.iam.gserviceaccount.com",
      private_key: "private-key",
    });

    const client = createDriveClient({ type: "service-account", keyJson });

    expect(jwtMock).toHaveBeenCalledWith({
      email: "connector@example.iam.gserviceaccount.com",
      key: "private-key",
      scopes: [DRIVE_READONLY_SCOPE],
    });
    expect(driveMock).toHaveBeenCalledWith({
      version: "v3",
      auth: expect.any(jwtMock),
    });
    expect(client).toEqual(expect.objectContaining({ files: expect.any(Object) }));
  });

  it("rejects malformed service-account JSON", () => {
    expect(() =>
      createDriveClient({ type: "service-account", keyJson: "{" }),
    ).toThrow(ConnectorAuthError);
  });

  it.each([null, undefined, {}, { type: "unknown" }])(
    "rejects an invalid credentials object: %j",
    (credentials) => {
      expect(() =>
        createDriveClient(credentials as never),
      ).toThrow(ConnectorAuthError);
    },
  );

  it.each(["null", "true", "[]", '"key"']) (
    "rejects non-object service-account JSON: %s",
    (keyJson) => {
      expect(() =>
        createDriveClient({ type: "service-account", keyJson }),
      ).toThrow(ConnectorAuthError);
    },
  );

  it("rejects a service-account key without private_key", () => {
    const keyJson = JSON.stringify({
      client_email: "connector@example.iam.gserviceaccount.com",
    });

    expect(() =>
      createDriveClient({ type: "service-account", keyJson }),
    ).toThrow(ConnectorAuthError);
  });

  it("configures OAuth credentials and the read-only scope", () => {
    createDriveClient({
      type: "oauth",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });

    expect(oauth2Mock).toHaveBeenCalledWith("client-id", "client-secret");
    expect(setCredentialsMock).toHaveBeenCalledWith({
      refresh_token: "refresh-token",
      scope: DRIVE_READONLY_SCOPE,
    });
    expect(driveMock).toHaveBeenCalledWith({
      version: "v3",
      auth: expect.any(oauth2Mock),
    });
  });

  it("rejects an empty OAuth refresh token", () => {
    expect(() =>
      createDriveClient({
        type: "oauth",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "  ",
      }),
    ).toThrow(ConnectorAuthError);
  });
});

describe("OAuth consent helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureOAuth2Mock();
    configureDriveMock();
  });

  it("builds a consent URL that guarantees offline consent", () => {
    getAuthorizationUrl({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3000/oauth2callback",
    });

    expect(oauth2Mock).toHaveBeenCalledWith(
      "client-id",
      "client-secret",
      "http://localhost:3000/oauth2callback",
    );
    expect(generateAuthUrlMock).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      scope: [DRIVE_READONLY_SCOPE],
    });
  });

  it("rejects a null OAuth client config", () => {
    expect(() => getAuthorizationUrl(null as never)).toThrow(ConnectorAuthError);
  });

  it("includes an OAuth state value for callback correlation", () => {
    getAuthorizationUrl({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3000/oauth2callback",
      state: "random-state",
    });

    expect(generateAuthUrlMock).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      scope: [DRIVE_READONLY_SCOPE],
      state: "random-state",
    });
  });

  it("rejects an empty OAuth state value", () => {
    expect(() =>
      getAuthorizationUrl({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://localhost:3000/oauth2callback",
        state: " ",
      }),
    ).toThrow(ConnectorAuthError);
  });

  it("returns refresh, access, and expiry tokens after code exchange", async () => {
    getTokenMock.mockResolvedValue({
      tokens: {
        refresh_token: "refresh-token",
        access_token: "access-token",
        expiry_date: 123456,
      },
    });

    await expect(
      exchangeAuthorizationCode({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://localhost:3000/oauth2callback",
        code: "authorization-code",
      }),
    ).resolves.toEqual({
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiryDate: 123456,
    });
    expect(getTokenMock).toHaveBeenCalledWith("authorization-code");
  });

  it("throws ConnectorAuthError when Google returns no refresh token", async () => {
    getTokenMock.mockResolvedValue({ tokens: { access_token: "access-token" } });

    await expect(
      exchangeAuthorizationCode({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://localhost:3000/oauth2callback",
        code: "authorization-code",
      }),
    ).rejects.toThrow(ConnectorAuthError);
  });

  it.each([
    ["clientId", { clientId: " ", clientSecret: "secret", redirectUri: "http://localhost/callback" }],
    ["clientSecret", { clientId: "id", clientSecret: " ", redirectUri: "http://localhost/callback" }],
    ["redirectUri", { clientId: "id", clientSecret: "secret", redirectUri: " " }],
  ])("rejects an empty %s when building a URL", (_field, config) => {
    expect(() => getAuthorizationUrl(config)).toThrow(ConnectorAuthError);
  });

  it("rejects an empty authorization code", async () => {
    await expect(
      exchangeAuthorizationCode({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://localhost:3000/oauth2callback",
        code: " ",
      }),
    ).rejects.toThrow(ConnectorAuthError);
  });

  it.each([[null], [undefined], [["code"]], ["config"]])(
    "rejects a non-object config before reading fields: %s",
    async (config) => {
      await expect(
        exchangeAuthorizationCode(
          config as unknown as Parameters<typeof exchangeAuthorizationCode>[0],
        ),
      ).rejects.toThrow(ConnectorAuthError);
    },
  );
});

describe("Google Drive scope", () => {
  it.each([
    ["folder_123-abc", "folder_123-abc"],
    ["https://drive.google.com/drive/folders/folder_123", "folder_123"],
    ["https://drive.google.com/drive/folders/folder_123/?usp=sharing", "folder_123"],
    ["https://drive.google.com/drive/u/2/folders/folder_123/?usp=sharing", "folder_123"],
  ])("parses %s", (input, expected) => {
    expect(parseGDriveFolderId(input)).toBe(expected);
  });

  it.each(["", "not an id", "http://drive.google.com/drive/folders/id", "https://example.com/drive/folders/id", "https://drive.google.com/file/d/id"])(
    "rejects invalid scope %s",
    (input) => expect(() => parseGDriveFolderId(input)).toThrow(ConnectorScopeError),
  );
});

describe("createGDriveConnector fetchContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureOAuth2Mock();
    configureDriveMock();
  });

  const doc = (mimeType: string) => ({
    providerDocId: "file-id",
    name: "File",
    mimeType,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    contentHash: "",
    markdown: "",
  });

  it.each([
    ["application/vnd.google-apps.document", "text/markdown", "# Doc"],
    ["application/vnd.google-apps.spreadsheet", "text/csv", "a,b\n1,2"],
    ["application/vnd.google-apps.presentation", "text/plain", "Slide one"],
  ])("exports %s as %s", async (mimeType, exportMimeType, content) => {
    filesExportMock.mockResolvedValue({ data: content });
    const result = await createGDriveConnector({ auth, scope: { allFiles: true } })
      .fetchContent(doc(mimeType));

    expect(filesExportMock).toHaveBeenCalledWith(
      { fileId: "file-id", mimeType: exportMimeType, supportsAllDrives: true },
      { responseType: "text" },
    );
    expect(result.markdown).toBe(content);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["text/plain", "plain text"],
    ["text/plain; charset=UTF-8", "plain text with charset"],
    ["text/csv", "name,value\nalpha,1"],
  ])("downloads and decodes %s without a parser", async (mimeType, content) => {
    filesGetMock.mockResolvedValue({ data: new TextEncoder().encode(content) });

    const result = await createGDriveConnector({ auth, scope: { allFiles: true } })
      .fetchContent(doc(mimeType));

    expect(filesGetMock).toHaveBeenCalledWith(
      { fileId: "file-id", alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    expect(result.markdown).toBe(content);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["text/markdown", "# Markdown"],
    ["text/markdown; charset=utf-8", "# Markdown with charset"],
  ])("downloads and decodes %s without a parser", async (mimeType, content) => {
    filesGetMock.mockResolvedValue({ data: new TextEncoder().encode(content) });

    const result = await createGDriveConnector({ auth, scope: { allFiles: true } })
      .fetchContent(doc(mimeType));

    expect(result.markdown).toBe(content);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("downloads binary content and invokes the parser", async () => {
    const parser = vi.fn(async () => "# Parsed");
    filesGetMock.mockResolvedValue({ data: new Uint8Array([1, 2, 3]) });
    const result = await createGDriveConnector({
      auth,
      scope: { allFiles: true },
      parser,
    }).fetchContent(doc("application/pdf"));

    expect(parser).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "application/pdf");
    expect(filesGetMock).toHaveBeenCalledWith(
      { fileId: "file-id", alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    expect(result.markdown).toBe("# Parsed");
  });

  it("fails loudly when binary content has no parser", async () => {
    await expect(createGDriveConnector({ auth, scope: { allFiles: true } })
      .fetchContent(doc("application/pdf")))
      .rejects.toThrowError(new ConnectorExtractionError(
        "No parser configured for mimeType application/pdf",
      ));
  });

  it.each([
    "application/vnd.google-apps.folder",
    "application/vnd.google-apps.shortcut",
  ])("rejects non-content item %s", async (mimeType) => {
    await expect(createGDriveConnector({ auth, scope: { allFiles: true } })
      .fetchContent(doc(mimeType))).rejects.toBeInstanceOf(ConnectorExtractionError);
  });

  it("hashes extracted markdown deterministically and changes with content", async () => {
    filesExportMock
      .mockResolvedValueOnce({ data: "same" })
      .mockResolvedValueOnce({ data: "same" })
      .mockResolvedValueOnce({ data: "different" });
    const connector = createGDriveConnector({ auth, scope: { allFiles: true } });
    const first = await connector.fetchContent(doc("application/vnd.google-apps.document"));
    const second = await connector.fetchContent(doc("application/vnd.google-apps.document"));
    const third = await connector.fetchContent(doc("application/vnd.google-apps.document"));

    expect(first.contentHash).toBe(second.contentHash);
    expect(third.contentHash).not.toBe(first.contentHash);
  });
});

describe("listChanges compatibility accumulator", () => {
  beforeEach(() => {
    vi.resetAllMocks(); configureOAuth2Mock(); configureDriveMock();
    startTokenMock.mockResolvedValue({ data: { startPageToken: "start" } });
    filesListMock.mockResolvedValue({ data: { files: [] } });
    filesGetMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: {
      id: fileId === "root" ? "real-root" : fileId,
      mimeType: "application/vnd.google-apps.folder",
    } }));
  });
  it("preserves metadata, cursor and targets while accumulating streamed pages", async () => {
    filesListMock.mockResolvedValueOnce({ data: { files: [{ id: "one", name: "One", mimeType: "text/plain" }], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { files: [{ id: "two", name: "Two", mimeType: "text/plain" }] } });
    const result = await createGDriveConnector({ auth, scope: { folder: "folder" } }).listChanges();
    expect(result.documents.map(d => d.providerDocId)).toEqual(["one", "two"]);
    expect(result).toMatchObject({ cursor: { pageToken: "start" }, visitedTargets: { files: [], folders: [] }, coverage: "complete" });
  });
  it("resolves the root alias and shares it with the streaming engine", async () => {
    await createGDriveConnector({ auth, scope: { folder: "root" } }).listChanges();
    expect(filesListMock).toHaveBeenCalledWith(expect.objectContaining({ q: "'real-root' in parents and trashed = false" }), expect.any(Object));
  });
  it("cancels root alias resolution and permits a later retry", async () => {
    const controller = new AbortController();
    filesGetMock.mockImplementationOnce(async (_params, { signal }: { signal: AbortSignal }) => {
      controller.abort();
      signal.throwIfAborted();
    });
    const connector = createGDriveConnector({ auth, scope: { folder: "root" } });
    await expect((async () => {
      for await (const _event of connector.iterateChanges(undefined, { signal: controller.signal })) { /* consume */ }
    })()).rejects.toMatchObject({ name: "AbortError" });
    expect(filesListMock).not.toHaveBeenCalled();
    expect(await connector.listChanges()).toMatchObject({ coverage: "complete" });
  });
  it("preserves final event order when a document is changed then removed", async () => {
    changesListMock.mockResolvedValue({ data: { changes: [
      { file: { id: "one", name: "One", mimeType: "text/plain" } },
      { fileId: "one", removed: true },
    ], newStartPageToken: "next" } });
    const result = await createGDriveConnector({ auth, scope: { allFiles: true } }).listChanges({ cursor: { pageToken: "start" } });
    expect(result.documents).toEqual([]); expect(result.removed).toEqual(["one"]);
  });
  it("exposes incomplete inventory coverage to legacy consumers", async () => {
    filesListMock.mockResolvedValue({ data: { files: [], incompleteSearch: true } });
    expect(await createGDriveConnector({ auth, scope: { allFiles: true } }).listChanges()).toMatchObject({ coverage: "partial" });
  });
});
