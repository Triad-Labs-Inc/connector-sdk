import { createHash } from "node:crypto";
import type { drive_v3 } from "googleapis";
import {
  ConnectorExtractionError,
  type ConnectorDocument,
  type ParserFn,
} from "@triadlabs/connectors-core";
import { FOLDER_MIME, SHORTCUT_MIME } from "./types.js";

export const EXPORT_MIME_TYPES = new Map([
  ["application/vnd.google-apps.document", "text/markdown"],
  ["application/vnd.google-apps.spreadsheet", "text/csv"],
  ["application/vnd.google-apps.presentation", "text/plain"],
]);

async function downloadBytes(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Uint8Array> {
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  const data = response.data as unknown;
  return data instanceof Uint8Array
    ? data
    : new Uint8Array(data as ArrayBuffer);
}

export function createFetchContent(
  drive: drive_v3.Drive,
  parser?: ParserFn,
): (doc: ConnectorDocument) => Promise<ConnectorDocument> {
  return async (doc) => {
    if (doc.mimeType === FOLDER_MIME || doc.mimeType === SHORTCUT_MIME) {
      throw new ConnectorExtractionError(
        `Cannot extract Google Drive item with mimeType ${doc.mimeType}`,
      );
    }

    const exportMimeType = EXPORT_MIME_TYPES.get(doc.mimeType);
    const baseMimeType = doc.mimeType.split(";", 1)[0]?.trim().toLowerCase();
    const isDirectText = baseMimeType === "text/plain" ||
      baseMimeType === "text/markdown" ||
      baseMimeType === "text/csv";

    let markdown: string;
    if (exportMimeType) {
      const response = await drive.files.export(
        {
          fileId: doc.providerDocId,
          mimeType: exportMimeType,
          supportsAllDrives: true,
        } as drive_v3.Params$Resource$Files$Export,
        { responseType: "text" },
      ) as { data: unknown };
      markdown = typeof response.data === "string"
        ? response.data
        : String(response.data);
    } else if (isDirectText) {
      markdown = new TextDecoder().decode(
        await downloadBytes(drive, doc.providerDocId),
      );
    } else {
      if (!parser) {
        throw new ConnectorExtractionError(
          `No parser configured for mimeType ${doc.mimeType}`,
        );
      }
      markdown = await parser(
        await downloadBytes(drive, doc.providerDocId),
        doc.mimeType,
      );
    }

    return {
      ...doc,
      markdown,
      contentHash: createHash("sha256").update(markdown).digest("hex"),
    };
  };
}
