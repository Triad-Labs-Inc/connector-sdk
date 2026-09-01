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

// Shares the oauth-flow example's credential cache so you only consent once
// across both examples.
const exampleDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(exampleDir, "../oauth-flow/.env.local");

function parseLocalEnv(): Record<string, string> {
  if (!existsSync(envPath)) return {};
  chmodSync(envPath, 0o600);
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

const localEnv = parseLocalEnv();
const clientId = process.env.GOOGLE_CLIENT_ID ?? localEnv.GOOGLE_CLIENT_ID;
const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET ?? localEnv.GOOGLE_CLIENT_SECRET;
let refreshToken =
  process.env.GOOGLE_REFRESH_TOKEN ?? localEnv.GOOGLE_REFRESH_TOKEN;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.\n" +
      "See examples/oauth-flow for one-time Google Cloud setup, then put both\n" +
      "values in examples/oauth-flow/.env.local and rerun.",
  );
  process.exit(1);
}

const parsedPort = Number(process.env.PORT ?? "3000");
const redirectUri = `http://localhost:${parsedPort}/oauth2callback`;

if (refreshToken) {
  console.log("Using cached credentials (delete .env.local to re-consent).\n");
} else {
  const expectedState = randomBytes(32).toString("base64url");
  refreshToken = await new Promise<string>((resolve, reject) => {
    let settled = false;
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
        response.writeHead(404).end("Not found");
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        response.writeHead(400).end(`Google authorization failed: ${oauthError}`);
        finish(new Error(`Google authorization failed: ${oauthError}`));
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        response.writeHead(400).end("Invalid OAuth state.");
        finish(new Error("OAuth callback state did not match the request."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400).end("Missing authorization code.");
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
          "<!doctype html><title>Connected</title><h1>You're authenticated</h1>" +
            "<p>You can close this tab and return to the terminal.</p>",
        );
        finish(undefined, tokens.refreshToken);
      } catch (error) {
        response.writeHead(500).end("Token exchange failed.");
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const timeout = setTimeout(() => {
      finish(new Error("No OAuth redirect arrived within 3 minutes."));
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
      console.log("\nWaiting up to 3 minutes for Google's redirect…\n");
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
  console.log(`Credentials saved to ${envPath} (permissions: 600).\n`);
}

const drive = createDriveClient({
  type: "oauth",
  clientId,
  clientSecret,
  refreshToken,
});

const FOLDER = "application/vnd.google-apps.folder";
interface Item {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  driveId?: string;
}

const items: Item[] = [];
let pageToken: string | undefined;
do {
  const page = await drive.files.list({
    q: "trashed = false",
    fields:
      "nextPageToken,files(id,name,mimeType,parents,driveId)",
    pageSize: 1000,
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  items.push(...((page.data.files ?? []) as Item[]));
  pageToken = page.data.nextPageToken ?? undefined;
} while (pageToken);

const folders = items.filter((item) => item.mimeType === FOLDER);
const files = items.filter((item) => item.mimeType !== FOLDER);

console.log(`Visible to this account: ${folders.length} folders, ${files.length} files\n`);

if (folders.length > 0) {
  console.log("Folders:");
  for (const folder of folders) {
    console.log(`  ${folder.name}  (${folder.id})`);
  }
  console.log("");
}

if (files.length > 0) {
  console.log("Files:");
  for (const file of files) {
    const shortMime = file.mimeType
      .replace("application/vnd.google-apps.", "g:")
      .replace("application/", "");
    console.log(`  ${file.name}  [${shortMime}]  (${file.id})`);
  }
  console.log("");
}

console.log(
  "Tip: pass a folder id from above to the CLI:\n" +
    "  triad-connectors sync --source gdrive --folder <id> --out ./dump\n",
);
