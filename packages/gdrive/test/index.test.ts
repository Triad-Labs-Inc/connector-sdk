import { beforeEach, describe, expect, it, vi } from "vitest";

const { driveMock, jwtMock, oauth2Mock, setCredentialsMock } = vi.hoisted(() => ({
  driveMock: vi.fn(() => ({ files: {} })),
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
} from "../src/index.js";

describe("createDriveClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauth2Mock.mockImplementation(function (this: { setCredentials: typeof setCredentialsMock }) {
      this.setCredentials = setCredentialsMock;
    });
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
