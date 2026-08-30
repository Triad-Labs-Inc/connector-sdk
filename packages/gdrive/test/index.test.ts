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

  it("uses shortcut targetMimeType to walk folders without fetching metadata", async () => {
    filesListMock.mockImplementation(async ({ q }: { q: string }) => ({ data: {
      files: q.includes("'root'")
        ? [{
            id: "shortcut",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: {
              targetId: "target-folder",
              targetMimeType: "application/vnd.google-apps.folder",
            },
          }]
        : [{ id: "nested", name: "Nested", mimeType: "text/plain" }],
    } }));

    const result = await createGDriveConnector({ auth, scope: { folder: "root" } })
      .listChanges();

    expect(result.documents.map((document) => document.providerDocId)).toEqual(["nested"]);
    expect(filesGetMock).not.toHaveBeenCalled();
    expect(filesListMock).toHaveBeenCalledWith(expect.objectContaining({
      q: "'target-folder' in parents and trashed = false",
    }));
  });

  it("lists all visible files without recursively walking folders in all-files mode", async () => {
    filesListMock.mockResolvedValue({ data: { files: [
      { id: "folder", name: "Folder", mimeType: "application/vnd.google-apps.folder" },
      { id: "file", name: "File", mimeType: "text/plain" },
    ] } });
    const result = await createGDriveConnector({ auth, scope: { allFiles: true } }).listChanges();
    expect(result.documents.map((d) => d.providerDocId)).toEqual(["file"]);
    expect(filesListMock).toHaveBeenCalledTimes(1);
    expect(filesListMock).toHaveBeenCalledWith(expect.objectContaining({ q: "trashed = false" }));
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

  it("keeps descendants of shortcut folder targets in incremental scope", async () => {
    filesListMock.mockImplementation(async ({ q }: { q: string }) => ({ data: { files: q.includes("'root'")
      ? [{ id: "shortcut", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "target-folder" } }]
      : [{ id: "nested", name: "Nested", mimeType: "text/plain" }] } }));
    filesGetMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: fileId === "target-folder"
      ? { id: fileId, name: "Target folder", mimeType: "application/vnd.google-apps.folder" }
      : { id: fileId } }));
    const connector = createGDriveConnector({ auth, scope: { folder: "root" } });
    await connector.listChanges();
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [
      { fileId: "nested", file: { id: "nested", name: "Changed", mimeType: "text/plain", parents: ["target-folder"] } },
    ] } });

    const result = await connector.listChanges({ pageToken: "start" });

    expect(result.documents.map((document) => document.providerDocId)).toEqual(["nested"]);
  });

  it("restores persisted shortcut targets for incremental scope", async () => {
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [
      { fileId: "nested", file: { id: "nested", name: "Nested", mimeType: "text/plain", parents: ["target-folder"] } },
    ] } });
    filesGetMock.mockResolvedValue({ data: { id: "real-root" } });

    const result = await createGDriveConnector({
      auth,
      scope: { folder: "root" },
      knownTargets: ["target-folder"],
    }).listChanges({ pageToken: "start" });

    expect(result.documents.map((document) => document.providerDocId)).toEqual(["nested"]);
  });

  it("skips incremental folders and resolves shortcuts using backfill MIME rules", async () => {
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [
      { fileId: "folder", file: { id: "folder", name: "Folder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] } },
      { fileId: "file-shortcut", file: { id: "file-shortcut", mimeType: "application/vnd.google-apps.shortcut", parents: ["root"], shortcutDetails: { targetId: "target-file" } } },
      { fileId: "folder-shortcut", file: { id: "folder-shortcut", mimeType: "application/vnd.google-apps.shortcut", parents: ["root"], shortcutDetails: { targetId: "target-folder" } } },
      { fileId: "cycle-shortcut", file: { id: "cycle-shortcut", mimeType: "application/vnd.google-apps.shortcut", parents: ["root"], shortcutDetails: { targetId: "cycle" } } },
      { fileId: "nested", file: { id: "nested", name: "Nested", mimeType: "text/plain", parents: ["target-folder"] } },
    ] } });
    filesGetMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: fileId === "root"
      ? { id: "root" }
      : fileId === "target-file"
        ? { id: fileId, name: "Target file", mimeType: "text/plain" }
        : fileId === "cycle"
          ? { id: fileId, mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "cycle" } }
        : { id: fileId, name: "Target folder", mimeType: "application/vnd.google-apps.folder" } }));

    const result = await createGDriveConnector({ auth, scope: { folder: "root" } })
      .listChanges({ pageToken: "start" });

    expect(result.documents.map((document) => document.providerDocId)).toEqual(["target-file", "nested"]);
  });

  it("retries a shortcut target after its fetch fails", async () => {
    filesListMock.mockResolvedValue({ data: { files: [
      { id: "shortcut", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "target" } },
    ] } });
    filesGetMock
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ data: { id: "target", name: "Target", mimeType: "text/plain" } });
    const connector = createGDriveConnector({ auth, scope: { folder: "folder" } });

    await expect(connector.listChanges()).rejects.toThrow("temporary failure");
    const result = await connector.listChanges();

    expect(result.documents.map((document) => document.providerDocId)).toEqual(["target"]);
    expect(filesGetMock).toHaveBeenCalledTimes(2);
  });

  it("resolves the root alias for incremental scope matching", async () => {
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [
      { fileId: "child", file: { id: "child", name: "Child", mimeType: "text/plain", parents: ["real-root"] } },
    ] } });
    filesGetMock.mockResolvedValue({ data: { id: "real-root" } });

    const result = await createGDriveConnector({ auth, scope: { folder: "root" } })
      .listChanges({ pageToken: "start" });

    expect(result.documents.map((document) => document.providerDocId)).toEqual(["child"]);
    expect(filesGetMock).toHaveBeenCalledWith({ fileId: "root", fields: "id", supportsAllDrives: true });
  });

  it("retries from the prior cursor when processing fails mid-page", async () => {
    const badChange = { fileId: "bad" } as { fileId: string; file?: unknown };
    Object.defineProperty(badChange, "file", {
      get: () => { throw new Error("decode failure"); },
    });
    changesListMock.mockResolvedValue({ data: { newStartPageToken: "fresh", changes: [
      { fileId: "good", file: { id: "good", name: "Good", mimeType: "text/plain", parents: ["root"] } },
      badChange,
    ] } });
    const connector = createGDriveConnector({ auth, scope: { folder: "root" } });
    await expect(connector.listChanges({ pageToken: "old" })).rejects.toThrow("decode failure");
    await expect(connector.listChanges({ pageToken: "old" })).rejects.toThrow("decode failure");
    expect(changesListMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageToken: "old" }));
    expect(changesListMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "old" }));
  });
});
