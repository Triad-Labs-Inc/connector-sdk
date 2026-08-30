import { createDriveClient } from "@triadlabs/connectors-gdrive";
import { readFileSync } from "node:fs";

/**
 * Tier-2 smoke test: proves real Google auth works end to end.
 *
 * Setup (5 minutes):
 *   1. Google Cloud console -> create project -> enable "Google Drive API"
 *   2. Create a service account -> download the JSON key
 *   3. In Drive, share a test folder with the robot email
 *      (....iam.gserviceaccount.com) — Viewer is enough
 *
 * Run from repo root:
 *   pnpm install && pnpm --filter @triadlabs/connectors-gdrive build
 *   cd examples/smoke && pnpm install
 *   GOOGLE_SERVICE_ACCOUNT_KEY=../../service-account.json pnpm smoke
 */

const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
if (!keyPath) {
  console.error("Set GOOGLE_SERVICE_ACCOUNT_KEY to the JSON key file path.");
  process.exit(1);
}

const drive = createDriveClient({
  type: "service-account",
  keyJson: readFileSync(keyPath, "utf8"),
});

// Ask Google: what folders can this robot see?
const res = await drive.files.list({
  q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
  fields: "files(id, name)",
  pageSize: 50,
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
});

const files = res.data.files ?? [];

if (files.length === 0) {
  console.log(
    "\nAuth works, but the robot sees no folders.\n" +
      "Did you share a folder with the service-account email?\n",
  );
} else {
  console.log("\nAuth works. Folders visible to the robot:\n");
  for (const f of files) {
    console.log(`  ${f.name}  (${f.id})`);
  }
  console.log(
    "\nNext: share a folder containing real docs/sheets/PDFs — that folder\n" +
      "becomes the fixture for the backfill walk and the Honcho spike.\n",
  );
}
