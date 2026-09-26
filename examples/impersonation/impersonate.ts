import {
  createGDriveConnector,
  DRIVE_READONLY_SCOPE,
} from "@triadlabs/connectors-gdrive";
import { GoogleAuth } from "google-auth-library";

/**
 * Live check for the "access-token" credential type using keyless
 * service-account impersonation. No service-account key is downloaded:
 * your own gcloud login mints short-lived tokens for the service account.
 *
 * Setup: see README.md in this folder.
 *
 * Run:
 *   cd examples/impersonation && pnpm install
 *   SERVICE_ACCOUNT=robot@project.iam.gserviceaccount.com pnpm start --folder <id-or-url>
 *   # add --force-refresh to prove the connector asks for new tokens
 */

const serviceAccount = process.env.SERVICE_ACCOUNT;
const folderFlag = process.argv.indexOf("--folder");
const folder = folderFlag === -1 ? undefined : process.argv[folderFlag + 1];
const forceRefresh = process.argv.includes("--force-refresh");

if (!serviceAccount || !folder) {
  console.error(
    "Usage: SERVICE_ACCOUNT=<robot email> pnpm start --folder <id-or-url> [--force-refresh]",
  );
  process.exit(1);
}

// Application Default Credentials: `gcloud auth application-default login`.
const source = await new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
}).getClient();

let mintCount = 0;

async function mintDriveToken(): Promise<{ accessToken: string; expiresAt: number }> {
  const { data } = await source.request<{ accessToken: string; expireTime: string }>({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount!)}:generateAccessToken`,
    method: "POST",
    data: { scope: [DRIVE_READONLY_SCOPE], lifetime: "3600s" },
  });
  mintCount += 1;
  const realExpiry = Date.parse(data.expireTime);
  console.log(`minted token #${mintCount} (expires ${new Date(realExpiry).toISOString()})`);
  // --force-refresh reports the token as already expiring, so the Google
  // client calls getAccessToken again before the next request.
  return { accessToken: data.accessToken, expiresAt: forceRefresh ? Date.now() : realExpiry };
}

const connector = createGDriveConnector({
  auth: { type: "access-token", getAccessToken: mintDriveToken },
  scope: { folder },
});

let documents = 0;
let firstDocument: Parameters<typeof connector.fetchContent>[0] | undefined;
for await (const event of connector.iterateChanges()) {
  if (event.kind === "document") {
    documents += 1;
    firstDocument ??= event.document;
    console.log(`  ${event.document.name}`);
  } else if (event.kind === "skipped") {
    console.log(`  skipped ${event.entry.id}: ${event.entry.reason}`);
  } else if (event.kind === "complete") {
    console.log(`walk ${event.coverage}: ${documents} documents`);
  }
}

if (firstDocument) {
  const full = await connector.fetchContent(firstDocument);
  console.log(`fetched "${firstDocument.name}": ${full.markdown.length} chars`);
}

console.log(`tokens minted: ${mintCount}${forceRefresh ? " (expect more than 1)" : ""}`);
