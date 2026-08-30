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
    files: { list: filesListMock, get: filesGetMock },
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
  ])("parses %s", (input, expected) => {
    expect(parseGDriveFolderId(input)).toBe(expected);
  });

  it.each(["", "not an id", "http://drive.google.com/drive/folders/id", "https://example.com/drive/folders/id", "https://drive.google.com/file/d/id"])(
    "rejects invalid scope %s",
    (input) => expect(() => parseGDriveFolderId(input)).toThrow(ConnectorScopeError),
  );
});

describe("createGDriveConnector listChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureOAuth2Mock();
    configureDriveMock();
    startTokenMock.mockResolvedValue({ data: { startPageToken: "start" } });
  });

  it("captures the start token before a paginated recursive walk and deduplicates files", async () => {
    const order: string[] = [];
    startTokenMock.mockImplementation(async () => {
      order.push("token");
      return { data: { startPageToken: "start" } };
    });
    filesListMock.mockImplementation(async ({ q, pageToken }: { q: string; pageToken?: string }) => {
      order.push(`list:${q}`);
      if (q.includes("'root'")) return pageToken
        ? { data: { files: [{ id: "file", name: "Doc", mimeType: "text/plain", modifiedTime: "2026-01-01" }] } }
        : { data: { nextPageToken: "p2", files: [{ id: "child", name: "Child", mimeType: "application/vnd.google-apps.folder" }, { id: "file", name: "Doc", mimeType: "text/plain", modifiedTime: "2026-01-01" }] } };
      return { data: { files: [{ id: "file", name: "Doc", mimeType: "text/plain" }, { id: "child", name: "Self", mimeType: "application/vnd.google-apps.folder" }] } };
    });
    const result = await createGDriveConnector({ auth, scope: { folder: "root" } }).listChanges();
    expect(order[0]).toBe("token");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ providerDocId: "file", markdown: "", contentHash: "" });
    expect(result.cursor.pageToken).toBe("start");
    expect(filesListMock).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true }));
  });

  it("resolves shortcuts to files and folders and terminates shortcut cycles", async () => {
    filesListMock.mockImplementation(async ({ q }: { q: string }) => {
      if (q.includes("'root'")) return { data: { files: [
        { id: "sf", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "target-file" } },
        { id: "sd", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "target-folder" } },
      ] } };
      return { data: { files: [{ id: "loop", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "target-folder" } }, { id: "nested", name: "Nested", mimeType: "text/plain" }] } };
    });
    filesGetMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: fileId === "target-file"
      ? { id: fileId, name: "Target", mimeType: "text/plain" }
      : { id: fileId, name: "Folder", mimeType: "application/vnd.google-apps.folder" } }));
    const result = await createGDriveConnector({ auth, scope: { folder: "root" } }).listChanges();
    expect(result.documents.map((d) => d.providerDocId)).toEqual(["target-file", "nested"]);
    expect(result.visitedTargets).toEqual(["target-file", "target-folder"]);
    expect(filesGetMock).toHaveBeenCalledWith(expect.objectContaining({ fileId: "target-file", supportsAllDrives: true }));
  });

  it("processes multiple change pages, removals, trash, and deep in-scope files", async () => {
    changesListMock
      .mockResolvedValueOnce({ data: { nextPageToken: "p2", changes: [
        { fileId: "gone", removed: true },
        { fileId: "trash", file: { id: "trash", trashed: true } },
        { fileId: "deep", file: { id: "deep", name: "Deep", mimeType: "text/plain", parents: ["p1"] } },
      ] } })
      .mockResolvedValueOnce({ data: { newStartPageToken: "fresh", changes: [] } });
    filesGetMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: fileId === "p1" ? { id: "p1", parents: ["root"] } : { id: fileId, parents: [] } }));
    const result = await createGDriveConnector({ auth, scope: { folder: "root" } }).listChanges({ pageToken: "old" });
    expect(result.removed).toEqual(["gone", "trash"]);
    expect(result.documents.map((d) => d.providerDocId)).toEqual(["deep"]);
    expect(result.cursor.pageToken).toBe("fresh");
    expect(changesListMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "p2", supportsAllDrives: true }));
  });

  it("excludes outside and inaccessible parent chains", async () => {
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [
      { fileId: "outside", file: { id: "outside", name: "Outside", mimeType: "text/plain", parents: ["other"] } },
      { fileId: "hidden", file: { id: "hidden", name: "Hidden", mimeType: "text/plain", parents: ["denied"] } },
    ] } });
    filesGetMock.mockImplementation(async ({ fileId }: { fileId: string }) => {
      if (fileId === "denied") throw new Error("403");
      return { data: { id: fileId, parents: [] } };
    });
    const result = await createGDriveConnector({ auth, scope: { folder: "root" } }).listChanges({ pageToken: "old" });
    expect(result.documents).toEqual([]);
  });

  it("keeps shortcut targets in scope for later incremental sync", async () => {
    filesListMock.mockResolvedValue({ data: { files: [{ id: "s", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "target" } }] } });
    filesGetMock.mockResolvedValue({ data: { id: "target", name: "Target", mimeType: "text/plain" } });
    const connector = createGDriveConnector({ auth, scope: { folder: "root" } });
    await connector.listChanges();
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [{ fileId: "target", file: { id: "target", name: "Changed", mimeType: "text/plain", parents: [] } }] } });
    const result = await connector.listChanges({ pageToken: "start" });
    expect(result.documents[0]?.providerDocId).toBe("target");
  });

  it("does not advance beyond the prior cursor when processing a page fails", async () => {
    changesListMock.mockResolvedValue({ data: { nextPageToken: "p2", changes: [{ fileId: "deep", file: { id: "deep", name: "Deep", mimeType: "text/plain", parents: ["parent"] } }] } });
    filesGetMock.mockRejectedValue(new Error("network failure"));
    const connector = createGDriveConnector({ auth, scope: { allFiles: true } });
    // allFiles does not resolve parents, so make document conversion itself harmless and fail the next page.
    changesListMock.mockResolvedValueOnce({ data: { nextPageToken: "p2", changes: [] } }).mockRejectedValueOnce(new Error("network failure"));
    await expect(connector.listChanges({ pageToken: "old" })).rejects.toThrow("network failure");
    expect(changesListMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageToken: "old" }));
  });
});
