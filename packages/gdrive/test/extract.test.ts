import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorContentChangedError, ConnectorExtractionError, ConnectorProviderError, type ConnectorDocument } from "@triadlabs/connectors-core";
import { createFetchContent } from "../src/extract.js";

const metadata = vi.fn(); const download = vi.fn(); const exportFile = vi.fn();
const get = vi.fn(async (args) => args.alt === "media" ? download(args) : metadata(args));
const drive = { files: { get, export: exportFile } } as unknown as drive_v3.Drive;
const doc: ConnectorDocument = { providerDocId: "doc", name: "Old name", mimeType: "text/plain", modifiedAt: "old", markdown: "", contentHash: "" };
const meta = (extra = {}) => ({ id: "doc", name: "Current name", mimeType: "text/plain", modifiedTime: "2026-09-05T00:00:00Z", version: "10", webViewLink: "https://drive.google.com/file/d/doc/view", ...extra });
const bytes = (...parts: Array<string | Uint8Array>) => ({ data: Readable.from(parts.map(part => typeof part === "string" ? Buffer.from(part) : part)) });
beforeEach(() => {
  vi.clearAllMocks();
  metadata.mockReset().mockResolvedValue({ data: meta() });
  download.mockReset().mockImplementation(async () => bytes("hello"));
  exportFile.mockReset().mockImplementation(async () => bytes("exported"));
});

describe("bounded content fetching", () => {
  it("returns current provider metadata, normalized content and its hash", async () => {
    const result = await createFetchContent(drive)(doc);
    expect(result).toMatchObject({ name: "Current name", markdown: "hello", providerVersion: "10", url: "https://drive.google.com/file/d/doc/view" });
    expect(result.contentHash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(metadata).toHaveBeenCalledTimes(2);
  });

  it.each(["text/plain", "text/markdown", "text/csv", "text/plain; charset=utf-8"])("decodes %s without a parser", async mimeType => {
    metadata.mockResolvedValue({ data: meta({ mimeType }) });
    expect((await createFetchContent(drive)(doc)).markdown).toBe("hello");
    expect(exportFile).not.toHaveBeenCalled();
  });

  it.each([
    ["application/vnd.google-apps.document", "text/markdown"],
    ["application/vnd.google-apps.spreadsheet", "text/csv"],
    ["application/vnd.google-apps.presentation", "text/plain"],
  ])("exports %s as %s", async (mimeType, expected) => {
    metadata.mockResolvedValue({ data: meta({ mimeType }) });
    expect((await createFetchContent(drive)(doc)).markdown).toBe("exported");
    expect(exportFile).toHaveBeenCalledWith({ fileId: "doc", mimeType: expected }, { responseType: "stream", signal: undefined });
  });

  it("falls back to plain text when Docs Markdown export is unsupported", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/vnd.google-apps.document" }) });
    exportFile.mockRejectedValueOnce({ response: { status: 400 } });
    expect((await createFetchContent(drive)(doc)).markdown).toBe("exported");
    expect(exportFile).toHaveBeenLastCalledWith({ fileId: "doc", mimeType: "text/plain" }, expect.any(Object));
  });

  it("does not mask export authorization errors with a fallback", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/vnd.google-apps.document" }) });
    exportFile.mockRejectedValue({ response: { status: 403 } });
    await expect(createFetchContent(drive)(doc)).rejects.toMatchObject({ status: 403, retryable: false });
    expect(exportFile).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized metadata before downloading", async () => {
    metadata.mockResolvedValue({ data: meta({ size: "1000" }) });
    await expect(createFetchContent(drive)(doc, { maxBytes: 100 })).rejects.toMatchObject({ reason: "resourceLimit", providerDocId: "doc" });
    expect(download).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])("enforces the byte limit with missing or inaccurate size (%s)", async size => {
    metadata.mockResolvedValue({ data: meta({ size }) });
    const stream = Readable.from([Buffer.from("123"), Buffer.from("456"), Buffer.from("789")]);
    download.mockResolvedValue({ data: stream });
    await expect(createFetchContent(drive)(doc, { maxBytes: 5 })).rejects.toMatchObject({ reason: "resourceLimit" });
    expect(stream.destroyed).toBe(true);
  });

  it("enforces export byte limits and measures UTF-8 bytes", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/vnd.google-apps.document" }) });
    exportFile.mockImplementation(async () => bytes("😀"));
    await expect(createFetchContent(drive)(doc, { maxBytes: 3 })).rejects.toMatchObject({ reason: "resourceLimit" });
  });

  it("accepts content exactly at the byte limit", async () => {
    expect((await createFetchContent(drive)(doc, { maxBytes: 5 })).markdown).toBe("hello");
  });

  it("passes document context to the parser and preserves two-argument compatibility", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf", size: "5" }) });
    const parser = vi.fn(async (data: Uint8Array, mimeType: string) => `${mimeType}: ${data.byteLength}`);
    expect((await createFetchContent(drive, parser)(doc)).markdown).toBe("application/pdf: 5");
    expect(parser).toHaveBeenCalledWith(expect.any(Uint8Array), "application/pdf", expect.objectContaining({ providerDocId: "doc", name: "Current name", sizeBytes: 5 }));
  });

  it.each(["encrypted", "malformed", "needsOcr", "resourceLimit"] as const)("preserves the parser's %s reason and attributes the error", async reason => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    const parser = async () => { throw new ConnectorExtractionError("Cannot parse", reason); };
    await expect(createFetchContent(drive, parser)(doc)).rejects.toMatchObject({ reason, providerDocId: "doc" });
  });

  it("attributes unknown parser failures without leaking their payload", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    await expect(createFetchContent(drive, async () => { throw new Error("private parser payload"); })(doc)).rejects.toMatchObject({ reason: "parserFailed", providerDocId: "doc", message: "Parser failed for document doc" });
  });

  it("preserves a parser's typed transient provider error", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    await expect(createFetchContent(drive, async () => { throw new ConnectorProviderError("retry", 429, true, 1000); })(doc)).rejects.toMatchObject({ retryable: true, retryAfterMs: 1000 });
  });

  it("limits parsed output", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    await expect(createFetchContent(drive, async () => "large output")(doc, { maxOutputCharacters: 5 })).rejects.toMatchObject({ reason: "resourceLimit" });
  });

  it("rejects non-text parser output", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    await expect(createFetchContent(drive, async () => null as never)(doc)).rejects.toMatchObject({ reason: "malformed" });
  });

  it("cancels an idle stream without waiting for another chunk", async () => {
    const controller = new AbortController();
    const stream = new Readable({ read() {} });
    download.mockImplementation(async () => {
      setTimeout(() => controller.abort(), 5);
      return { data: stream };
    });
    await expect(createFetchContent(drive)(doc, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.destroyed).toBe(true);
  });

  it("does no network work for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createFetchContent(drive)(doc, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(get).not.toHaveBeenCalled();
  });

  it("detects edits during download before invoking a parser", async () => {
    metadata.mockResolvedValueOnce({ data: meta({ mimeType: "application/pdf" }) }).mockResolvedValueOnce({ data: meta({ mimeType: "application/pdf", version: "11" }) });
    const parser = vi.fn(async () => "parsed");
    await expect(createFetchContent(drive, parser)(doc)).rejects.toBeInstanceOf(ConnectorContentChangedError);
    expect(parser).not.toHaveBeenCalled();
  });

  it("detects modified-time changes when the provider omits a version", async () => {
    metadata.mockResolvedValueOnce({ data: meta({ version: undefined }) })
      .mockResolvedValueOnce({ data: meta({ version: undefined, modifiedTime: "later" }) });
    await expect(createFetchContent(drive)(doc)).rejects.toBeInstanceOf(ConnectorContentChangedError);
  });

  it("does not parse or return partial bytes when a download stream fails", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    const stream = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw new Error("connection reset");
    })());
    download.mockResolvedValue({ data: stream });
    const parser = vi.fn(async () => "parsed");
    await expect(createFetchContent(drive, parser)(doc)).rejects.toMatchObject({ name: "ConnectorProviderError", retryable: true });
    expect(parser).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it("passes cancellation to a cooperative parser", async () => {
    metadata.mockResolvedValue({ data: meta({ mimeType: "application/pdf" }) });
    const controller = new AbortController();
    const parser = vi.fn(async (_bytes, _mime, context) => {
      expect(context.signal).toBe(controller.signal);
      controller.abort();
      context.signal.throwIfAborted();
      return "unused";
    });
    await expect(createFetchContent(drive, parser)(doc, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("limits direct text output as well as parsed output", async () => {
    await expect(createFetchContent(drive)(doc, { maxOutputCharacters: 4 })).rejects.toMatchObject({ reason: "resourceLimit" });
  });

  it("reports download failures as retryable and does not invoke the parser", async () => {
    download.mockRejectedValue({ response: { status: 503, headers: { "retry-after": "3" } } });
    await expect(createFetchContent(drive)(doc)).rejects.toMatchObject({ status: 503, retryable: true, retryAfterMs: 3000 });
  });

  it.each(["application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut", "application/pdf"])("rejects unsupported %s before download", async mimeType => {
    metadata.mockResolvedValue({ data: meta({ mimeType }) });
    await expect(createFetchContent(drive)(doc)).rejects.toMatchObject({ reason: "unsupported" });
    expect(download).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid bounds (%s) before network work", async maxBytes => {
    await expect(createFetchContent(drive)(doc, { maxBytes })).rejects.toBeInstanceOf(RangeError);
    expect(get).not.toHaveBeenCalled();
  });
});
