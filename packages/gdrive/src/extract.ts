import { createHash } from "node:crypto";
import type { drive_v3 } from "googleapis";
import {
  ConnectorContentChangedError, ConnectorExtractionError, ConnectorProviderError,
  type ConnectorDocument, type FetchContentOptions, type ParserFn,
} from "@triadlabs/connectors-core";
import { providerError, providerStatus } from "./provider-error.js";
import { FOLDER_MIME, SHORTCUT_MIME } from "./types.js";

export const EXPORT_MIME_TYPES = new Map([
  ["application/vnd.google-apps.document", "text/markdown"],
  ["application/vnd.google-apps.spreadsheet", "text/csv"],
  ["application/vnd.google-apps.presentation", "text/plain"],
]);
const METADATA_FIELDS = "id,name,mimeType,webViewLink,modifiedTime,size,version,trashed";

type ByteStream = AsyncIterable<Uint8Array | string> & { destroy?: (error?: Error) => unknown };

async function readBytes(data: unknown, options: FetchContentOptions, id: string): Promise<Uint8Array> {
  if (!data || typeof (data as ByteStream)[Symbol.asyncIterator] !== "function") {
    throw new Error("Drive did not return a readable content stream");
  }
  const stream = data as ByteStream;
  const { signal } = options;
  const abort = () => stream.destroy?.(signal?.reason instanceof Error ? signal.reason : new Error("Content fetch aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        throw new ConnectorExtractionError(`Document ${id} exceeds the download byte limit`, "resourceLimit", id);
      }
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, bytes);
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy?.();
  }
}

function validateOptions(options: FetchContentOptions): void {
  for (const key of ["maxBytes", "maxOutputCharacters"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
}

export function createFetchContent(drive: drive_v3.Drive, parser?: ParserFn) {
  return async (doc: ConnectorDocument, options: FetchContentOptions = {}): Promise<ConnectorDocument> => {
    validateOptions(options);
    const { signal } = options;
    signal?.throwIfAborted();
    const id = doc.providerDocId;
    const limitError = () => new ConnectorExtractionError(`Document ${id} exceeds the download byte limit`, "resourceLimit", id);
    try {
      const metadata = async () => {
        const { data } = await drive.files.get({ fileId: id, fields: METADATA_FIELDS, supportsAllDrives: true }, { signal });
        if (data.trashed) throw new ConnectorExtractionError(`Document ${id} is trashed`, "unsupported", id);
        if (!data.id || !data.name || !data.mimeType || (!data.version && !data.modifiedTime)) {
          throw new Error("Drive returned incomplete content metadata");
        }
        return data;
      };
      const before = await metadata();
      const mimeType = before.mimeType!;
      if (mimeType === FOLDER_MIME || mimeType === SHORTCUT_MIME) {
        throw new ConnectorExtractionError(`Cannot extract Google Drive item with mimeType ${mimeType}`, "unsupported", id);
      }
      const exportType = EXPORT_MIME_TYPES.get(mimeType);
      const directText = ["text/plain", "text/markdown", "text/csv"].includes(mimeType.split(";", 1)[0]!.trim().toLowerCase());
      if (!exportType && !directText && !parser) {
        throw new ConnectorExtractionError(`No parser configured for mimeType ${mimeType}`, "unsupported", id);
      }
      const sizeBytes = before.size != null && Number.isSafeInteger(Number(before.size)) && Number(before.size) >= 0 ? Number(before.size) : undefined;
      if (!exportType && sizeBytes !== undefined && options.maxBytes !== undefined && sizeBytes > options.maxBytes) throw limitError();
      let response;
      if (exportType) {
        try {
          response = await drive.files.export({ fileId: id, mimeType: exportType }, { responseType: "stream", signal });
        } catch (error) {
          // Older Docs exports may not support Markdown. Do not mask auth/rate-limit errors.
          if (mimeType !== "application/vnd.google-apps.document" || providerStatus(error) !== 400) throw error;
          response = await drive.files.export({ fileId: id, mimeType: "text/plain" }, { responseType: "stream", signal });
        }
      } else {
        response = await drive.files.get({ fileId: id, alt: "media", supportsAllDrives: true }, { responseType: "stream", signal });
      }
      const bytes = await readBytes(response.data, options, id);
      const after = await metadata();
      signal?.throwIfAborted();
      if (before.version !== after.version || before.modifiedTime !== after.modifiedTime || before.mimeType !== after.mimeType) {
        throw new ConnectorContentChangedError(id);
      }
      let markdown: string;
      if (exportType || directText) markdown = new TextDecoder().decode(bytes);
      else {
        try {
          markdown = await parser!(bytes, mimeType, { providerDocId: id, name: before.name!, mimeType, sizeBytes, signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof ConnectorExtractionError) {
            throw new ConnectorExtractionError(error.message, error.reason, id);
          }
          if (error instanceof ConnectorProviderError) throw error;
          throw new ConnectorExtractionError(`Parser failed for document ${id}`, "parserFailed", id);
        }
      }
      signal?.throwIfAborted();
      if (typeof markdown !== "string") throw new ConnectorExtractionError(`Parser returned non-text content for ${id}`, "malformed", id);
      if (options.maxOutputCharacters !== undefined && markdown.length > options.maxOutputCharacters) {
        throw new ConnectorExtractionError(`Document ${id} exceeds the output character limit`, "resourceLimit", id);
      }
      return {
        providerDocId: id, name: before.name!, mimeType, modifiedAt: before.modifiedTime ?? "",
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(before.version ? { providerVersion: before.version } : {}),
        ...(before.webViewLink ? { url: before.webViewLink, webViewLink: before.webViewLink } : {}),
        markdown, contentHash: createHash("sha256").update(markdown).digest("hex"),
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ConnectorExtractionError || error instanceof ConnectorContentChangedError) throw error;
      throw providerError(error, `Drive content fetch for ${id}`);
    }
  };
}
