import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  driveMock,
  generateAuthUrlMock,
  getTokenMock,
  jwtMock,
  oauth2Mock,
  setCredentialsMock,
} = vi.hoisted(() => ({
  driveMock: vi.fn(() => ({ files: {} })),
  generateAuthUrlMock: vi.fn(() => "https://accounts.google.com/o/oauth2/auth"),
  getTokenMock: vi.fn(),
  jwtMock: vi.fn(function () {}),
  oauth2Mock: vi.fn(function () {}),
  setCredentialsMock: vi.fn(),
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
  createDriveClient,
  DRIVE_READONLY_SCOPE,
  exchangeAuthorizationCode,
  getAuthorizationUrl,
} from "../src/index.js";

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
    expect(client).toEqual({ files: {} });
  });

  it("rejects malformed service-account JSON", () => {
    expect(() =>
      createDriveClient({ type: "service-account", keyJson: "{" }),
    ).toThrow(ConnectorAuthError);
  });

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
});
