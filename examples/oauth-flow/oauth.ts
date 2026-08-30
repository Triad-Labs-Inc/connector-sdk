import {
  createDriveClient,
  exchangeAuthorizationCode,
  getAuthorizationUrl,
} from "@triadlabs/connectors-gdrive";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exampleDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(exampleDir, ".env.local");

function parseLocalEnv(): Record<string, string> {
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => {
        const value = match[2] ?? "";
        const unquoted =
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
            ? value.slice(1, -1)
            : value;
        return [match[1], unquoted];
      }),
  );
}

function persistCredentials(values: Record<string, string>): void {
  let contents = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    contents = pattern.test(contents)
      ? contents.replace(pattern, line)
      : `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(envPath, contents, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

function printSetup(): void {
  console.error(`
Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.

One-time Google Cloud setup:
  1. Create or select a project in https://console.cloud.google.com/.
  2. APIs & Services → Library → Google Drive API → Enable.
  3. Google Auth Platform → Branding: configure an External app.
  4. Google Auth Platform → Data Access: add
     https://www.googleapis.com/auth/drive.readonly
  5. Google Auth Platform → Audience: keep Testing and add your Google
     account under Test users.
  6. Google Auth Platform → Clients → Create client → Web application.
     Add this Authorized redirect URI:
     http://localhost:3000/oauth2callback
  7. Put the client ID and secret in examples/oauth-flow/.env.local:
     GOOGLE_CLIENT_ID=...
     GOOGLE_CLIENT_SECRET=...

Then run: pnpm oauth
`);
}

const localEnv = parseLocalEnv();
const clientId = process.env.GOOGLE_CLIENT_ID ?? localEnv.GOOGLE_CLIENT_ID;
const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET ?? localEnv.GOOGLE_CLIENT_SECRET;
let refreshToken =
  process.env.GOOGLE_REFRESH_TOKEN ?? localEnv.GOOGLE_REFRESH_TOKEN;

if (!clientId || !clientSecret) {
  printSetup();
  process.exit(1);
}

const parsedPort = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  console.error("PORT must be an integer from 1 to 65535.");
  process.exit(1);
}
const redirectUri = `http://localhost:${parsedPort}/oauth2callback`;

if (refreshToken) {
  console.log("Already authenticated, listing folders…");
} else {
  const expectedState = randomBytes(32).toString("base64url");
  refreshToken = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout;
    const finish = (error?: Error, token?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (server.listening) server.close();
      if (error) reject(error);
      else resolve(token as string);
    };

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (request.method !== "GET" || url.pathname !== "/oauth2callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`Google authorization failed: ${oauthError}`);
        finish(new Error(`Google authorization failed: ${oauthError}`));
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid OAuth state.");
        finish(new Error("OAuth callback state did not match the request."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing authorization code.");
        finish(new Error("OAuth callback did not include an authorization code."));
        return;
      }

      try {
        const tokens = await exchangeAuthorizationCode({
          clientId,
          clientSecret,
          redirectUri,
          code,
        });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><title>Google Drive connected</title>" +
            "<h1>You’re authenticated</h1>" +
            "<p>You can close this tab and return to the terminal.</p>",
        );
        finish(undefined, tokens.refreshToken);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("Token exchange failed. Return to the terminal for details.");
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish(
          new Error(
            `Port ${parsedPort} is busy. Set PORT=3001 (and add ` +
              `http://localhost:3001/oauth2callback to the OAuth client) and retry.`,
          ),
        );
      } else {
        finish(error);
      }
    });

    timeout = setTimeout(() => {
      finish(
        new Error(
          "No OAuth redirect arrived within 3 minutes. Run pnpm oauth to try again.",
        ),
      );
    }, 3 * 60 * 1000);

    server.listen(parsedPort, "localhost", () => {
      const authorizationUrl = getAuthorizationUrl({
        clientId,
        clientSecret,
        redirectUri,
        state: expectedState,
      });
      console.log("\nOpen this link to connect Google Drive:\n");
      console.log(authorizationUrl);
      console.log("\nWaiting up to 3 minutes for Google’s redirect…\n");
    });
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

  persistCredentials({
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: refreshToken,
  });
  console.log(`Credentials saved to ${envPath} (permissions: 600).`);
}

const drive = createDriveClient({
  type: "oauth",
  clientId,
  clientSecret,
  refreshToken,
});

try {
  const result = await drive.files.list({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: "files(id, name)",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const folders = result.data.files ?? [];
  if (folders.length === 0) {
    console.log(
      "\nAuth works, but this account sees no folders. Create or share a Drive " +
        "folder with this account, then run pnpm oauth again.\n",
    );
  } else {
    console.log("\nAuth works. Folders visible to this account:\n");
    for (const folder of folders) console.log(`  ${folder.name}  (${folder.id})`);
  }
  console.log(
    "\nRevoke access any time at https://myaccount.google.com/permissions\n",
  );
} catch (error) {
  const status =
    typeof error === "object" && error !== null && "response" in error
      ? (error.response as { status?: unknown }).status
      : undefined;
  if (status === 403) {
    console.error(
      "Google returned HTTP 403. Enable the Google Drive API for the Cloud " +
        "project, wait a minute, then retry.",
    );
  } else {
    console.error("Could not list folders:", error);
  }
  process.exit(1);
}
