import {
  ConnectorExtractionError,
  createGDriveConnector,
  type ConnectorDocument,
  type GDriveConnector,
  type GDriveCredentials,
  type GDriveSyncCursor,
  type VisitedTargets,
} from "@triadlabs/connectors-gdrive";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ManifestDocument {
  providerDocId: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  url?: string;
  modifiedAt: string;
  contentHash: string;
  output: string;
  error?: string;
}

export interface DumpManifest {
  documents: ManifestDocument[];
  cursor: GDriveSyncCursor;
  visitedTargets: VisitedTargets;
  savedAt: string;
}

export function sanitizeFilename(name: string): string {
  const sanitized = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return sanitized === "" || sanitized === "." || sanitized === ".."
    ? "untitled"
    : sanitized;
}

function shortId(providerDocId: string): string {
  const safe = providerDocId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return safe || createHash("sha256").update(providerDocId).digest("hex").slice(0, 8);
}

export function allocateOutputPath(
  name: string,
  providerDocId: string,
  claimed: ReadonlySet<string>,
): string {
  const base = sanitizeFilename(name);
  const preferred = `${base}.md`;
  if (!claimed.has(preferred.toLowerCase())) return preferred;
  let candidate = `${base}-${shortId(providerDocId)}.md`;
  let counter = 2;
  while (claimed.has(candidate.toLowerCase())) {
    candidate = `${base}-${shortId(providerDocId)}-${counter}.md`;
    counter += 1;
  }
  return candidate;
}

export function readManifest(path: string): DumpManifest | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DumpManifest>;
  if (!Array.isArray(value.documents) || !value.cursor || !value.visitedTargets) {
    throw new Error(`Invalid manifest: ${path}`);
  }
  return value as DumpManifest;
}

export function writeManifest(path: string, manifest: DumpManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

interface SyncOptions {
  connector: GDriveConnector;
  outDir: string;
  previous?: DumpManifest;
  now?: () => Date;
}

export interface SyncSummary {
  new: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: number;
}

function isExpiredCursor(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  return candidate.code === 410 || candidate.response?.status === 410;
}

function safeOutputFile(outDir: string, output: string): string {
  const root = resolve(outDir);
  const target = resolve(root, output);
  if (isAbsolute(output) || relative(root, target).startsWith("..")) {
    throw new Error(`Unsafe manifest output path: ${output}`);
  }
  return target;
}

function toManifestDocument(
  doc: ConnectorDocument,
  output: string,
  error?: string,
): ManifestDocument {
  return {
    providerDocId: doc.providerDocId,
    name: doc.name,
    mimeType: doc.mimeType,
    ...(doc.webViewLink ? { webViewLink: doc.webViewLink } : {}),
    ...(doc.url ? { url: doc.url } : {}),
    modifiedAt: doc.modifiedAt,
    contentHash: doc.contentHash,
    output,
    ...(error ? { error } : {}),
  };
}

export async function syncDump(options: SyncOptions): Promise<{
  manifest: DumpManifest;
  summary: SyncSummary;
}> {
  mkdirSync(options.outDir, { recursive: true });
  const previous = options.previous;
  let fullBackfill = !previous;
  let result;
  try {
    result = await options.connector.listChanges(previous?.cursor);
  } catch (error) {
    if (!previous || !isExpiredCursor(error)) throw error;
    fullBackfill = true;
    result = await options.connector.listChanges();
  }

  const oldById = new Map(
    (previous?.documents ?? []).map((document) => [document.providerDocId, document]),
  );
  const nextById = new Map(oldById);
  const claimed = new Set(
    (previous?.documents ?? []).map((document) => document.output.toLowerCase()),
  );
  const summary: SyncSummary = {
    new: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    errors: 0,
  };

  if (fullBackfill && previous) {
    const returnedIds = new Set(result.documents.map((document) => document.providerDocId));
    for (const old of previous.documents) {
      if (returnedIds.has(old.providerDocId)) continue;
      const path = safeOutputFile(options.outDir, old.output);
      if (existsSync(path)) unlinkSync(path);
      nextById.delete(old.providerDocId);
      claimed.delete(old.output.toLowerCase());
      summary.removed += 1;
    }
  }

  for (const id of new Set(result.removed)) {
    const old = nextById.get(id);
    if (!old) continue;
    const path = safeOutputFile(options.outDir, old.output);
    if (existsSync(path)) unlinkSync(path);
    nextById.delete(id);
    claimed.delete(old.output.toLowerCase());
    summary.removed += 1;
  }

  for (const metadata of result.documents) {
    const old = oldById.get(metadata.providerDocId);
    const output = old?.output ?? allocateOutputPath(
      metadata.name,
      metadata.providerDocId,
      claimed,
    );
    claimed.add(output.toLowerCase());
    try {
      const extracted = await options.connector.fetchContent(metadata);
      if (old?.contentHash && old.contentHash === extracted.contentHash) {
        nextById.set(metadata.providerDocId, toManifestDocument(extracted, output));
        summary.unchanged += 1;
        continue;
      }
      writeFileSync(safeOutputFile(options.outDir, output), extracted.markdown, "utf8");
      nextById.set(metadata.providerDocId, toManifestDocument(extracted, output));
      if (old) summary.updated += 1;
      else summary.new += 1;
    } catch (error) {
      if (!(error instanceof ConnectorExtractionError)) throw error;
      const message = error.message;
      nextById.set(
        metadata.providerDocId,
        toManifestDocument({ ...metadata, contentHash: old?.contentHash ?? "" }, output, message),
      );
      summary.errors += 1;
    }
  }

  const manifest: DumpManifest = {
    documents: [...nextById.values()].sort((a, b) =>
      a.providerDocId.localeCompare(b.providerDocId),
    ),
    cursor: result.cursor,
    visitedTargets: result.visitedTargets ?? previous?.visitedTargets ?? {
      files: [],
      folders: [],
    },
    savedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  writeManifest(join(options.outDir, "manifest.json"), manifest);
  return { manifest, summary };
}

interface ParsedArgs {
  command?: string;
  source?: string;
  folder?: string;
  out?: string;
  allFiles: boolean;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  serviceAccountJson?: string;
  help: boolean;
}

const valueFlags = new Map([
  ["--source", "source"],
  ["--folder", "folder"],
  ["--out", "out"],
  ["--client-id", "clientId"],
  ["--client-secret", "clientSecret"],
  ["--refresh-token", "refreshToken"],
  ["--service-account-json", "serviceAccountJson"],
] as const);
type ValueFlag = "--source" | "--folder" | "--out" | "--client-id" |
  "--client-secret" | "--refresh-token" | "--service-account-json";

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { allFiles: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (index === 0 && arg && !arg.startsWith("-")) {
      parsed.command = arg;
      continue;
    }
    if (arg === "--all-files") parsed.allFiles = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg && valueFlags.has(arg as ValueFlag)) {
      const key = valueFlags.get(arg as ValueFlag);
      const value = args[index + 1];
      if (!key || !value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      (parsed as unknown as Record<string, unknown>)[key] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export const USAGE = `Usage:
  triad-connectors sync --source gdrive --folder <id-or-url> --out <dir>
  triad-connectors sync --source gdrive --all-files --out <dir>

Authentication:
  OAuth flags: --client-id, --client-secret, --refresh-token
  OAuth env:   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
  Service account: --service-account-json <path-or-json>
                   or GOOGLE_SERVICE_ACCOUNT_JSON`;

function credentials(args: ParsedArgs, env: NodeJS.ProcessEnv): GDriveCredentials {
  const serviceAccount = args.serviceAccountJson ?? env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (serviceAccount) {
    const keyJson = existsSync(serviceAccount)
      ? readFileSync(serviceAccount, "utf8")
      : serviceAccount;
    return { type: "service-account", keyJson };
  }
  const clientId = args.clientId ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = args.clientSecret ?? env.GOOGLE_CLIENT_SECRET;
  const refreshToken = args.refreshToken ?? env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google credentials; provide OAuth flags/env vars or a service account");
  }
  return { type: "oauth", clientId, clientSecret, refreshToken };
}

export async function runCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    if (args.command !== "sync" || args.source !== "gdrive" || !args.out) {
      throw new Error("The sync command requires --source gdrive and --out <dir>");
    }
    if (args.folder && args.allFiles) throw new Error("Use either --folder or --all-files, not both");
    if (!args.folder && !args.allFiles) throw new Error("Missing scope: provide --folder or --all-files");
    if (args.allFiles) {
      console.warn("WARNING: --all-files scans EVERYTHING visible to this Google credential.");
    }
    const outDir = resolve(args.out);
    const manifestPath = join(outDir, "manifest.json");
    const previous = readManifest(manifestPath);
    const connector = createGDriveConnector({
      auth: credentials(args, env),
      scope: args.allFiles ? { allFiles: true } : { folder: args.folder as string },
      knownTargets: previous?.visitedTargets,
    });
    const { summary } = await syncDump({ connector, outDir, previous });
    console.log(
      `${summary.new} new, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
        `${summary.removed} removed, ${summary.errors} extraction errors`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 1;
  }
}
