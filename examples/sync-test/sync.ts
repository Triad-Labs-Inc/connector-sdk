import {
  createGDriveConnector,
  type ConnectorDocument,
  type GDriveCredentials,
  type GDriveSyncResume,
} from "@triadlabs/connectors-gdrive";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exampleDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(exampleDir, "../oauth-flow/.env.local");
const cursorPath = join(exampleDir, ".cursor.json");

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

interface SavedState {
  resume: GDriveSyncResume;
  savedAt: string;
}

function persistCursor(state: SavedState): void {
  writeFileSync(cursorPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(cursorPath, 0o600);
}

function readCursor(): SavedState | undefined {
  if (!existsSync(cursorPath)) return undefined;
  chmodSync(cursorPath, 0o600);
  return JSON.parse(readFileSync(cursorPath, "utf8")) as SavedState;
}

function removeCursor(): void {
  if (existsSync(cursorPath)) unlinkSync(cursorPath);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function printUsage(): void {
  console.error(`Usage:
  pnpm sync --folder <id-or-url> [--extract]
  pnpm sync --folder <id-or-url> --reset [--extract]
  pnpm sync --all-files [--reset] [--extract]

FOLDER_ID or GOOGLE_FOLDER_ID may be used instead of --folder.`);
}

async function extractDocuments(documents: ConnectorDocument[]): Promise<void> {
  if (!extract) return;
  for (const document of documents) {
    try {
      const extracted = await connector.fetchContent(document);
      const markdown = extracted.markdown ?? "";
      const preview = markdown.replace(/\s+/g, " ").trim().slice(0, 200);
      console.log(`\n${document.name}`);
      console.log(`  mimeType: ${document.mimeType}`);
      console.log(
        `  markdown: ${markdown.length} chars, ${Buffer.byteLength(markdown, "utf8")} bytes`,
      );
      console.log(`  contentHash: ${extracted.contentHash?.slice(0, 12) ?? "-"}`);
      console.log(`  preview: ${preview || "-"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n${document.name}: extraction failed: ${message}`);
    }
  }
}

function printDocuments(documents: ConnectorDocument[]): void {
  if (documents.length === 0) return;
  const headers = ["name", "mimeType", "modifiedAt", "webViewLink"];
  const rows = documents.map((document) => [
    document.name,
    document.mimeType,
    document.modifiedAt,
    document.webViewLink ?? "-",
  ]);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (row: string[]): string =>
    row.map((value, column) => value.padEnd(widths[column] ?? 0)).join("  ");
  console.log(`\n${format(headers)}`);
  console.log(format(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(format(row));
}

function isExpiredPageToken(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    response?: { status?: unknown };
  };
  return candidate.code === 410 || candidate.response?.status === 410;
}

const localEnv = parseLocalEnv();
const clientId = process.env.GOOGLE_CLIENT_ID ?? localEnv.GOOGLE_CLIENT_ID;
const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET ?? localEnv.GOOGLE_CLIENT_SECRET;
const refreshToken =
  process.env.GOOGLE_REFRESH_TOKEN ?? localEnv.GOOGLE_REFRESH_TOKEN;

const allFiles = process.argv.includes("--all-files");
const reset = process.argv.includes("--reset");
const extract = process.argv.includes("--extract");
const folder =
  argumentValue("--folder") ??
  process.env.FOLDER_ID ??
  process.env.GOOGLE_FOLDER_ID;

if (!allFiles && !folder) {
  printUsage();
  process.exit(1);
}
if (process.argv.includes("--folder") && !argumentValue("--folder")) {
  printUsage();
  process.exit(1);
}
if (!clientId || !clientSecret || !refreshToken) {
  console.error(
    "Missing Google OAuth credentials. Run `pnpm oauth` in examples/oauth-flow first.",
  );
  process.exit(1);
}
if (reset) removeCursor();
if (allFiles) {
  console.warn("scanning ALL content visible to this credential");
}
const saved = readCursor();

const auth: GDriveCredentials = {
  type: "oauth",
  clientId,
  clientSecret,
  refreshToken,
};
const connector = createGDriveConnector({
  auth,
  scope: allFiles ? { allFiles: true } : { folder: folder as string },
});

async function backfill(): Promise<void> {
  const result = await connector.listChanges();
  const visitedTargets = result.visitedTargets;
  const targetCount = visitedTargets.files.length + visitedTargets.folders.length;
  console.log(
    `backfill complete: ${result.documents.length} documents, ${targetCount} shortcut targets`,
  );
  printDocuments(result.documents);
  await extractDocuments(result.documents);
  persistCursor({
    resume: { cursor: result.cursor, visitedTargets },
    savedAt: new Date().toISOString(),
  });
  console.log(
    "\nNow edit, add, or delete a file in the folder, then run this command again to see incremental sync.",
  );
}

async function run(): Promise<void> {
  if (!saved) {
    await backfill();
    return;
  }
  try {
    const result = await connector.listChanges(saved.resume);
    console.log(
      `incremental: ${result.documents.length} changed, ${result.removed.length} removed`,
    );
    printDocuments(result.documents);
    await extractDocuments(result.documents);
    if (result.removed.length > 0) {
      console.log("\nremoved IDs");
      for (const id of result.removed) console.log(`  ${id}`);
    }
    persistCursor({
      resume: {
        cursor: result.cursor,
        visitedTargets: result.visitedTargets,
      },
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!isExpiredPageToken(error)) throw error;
    console.log("cursor expired — re-running full backfill");
    removeCursor();
    await backfill();
  }
}

await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
