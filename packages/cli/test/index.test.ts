import type {
  ConnectorDocument,
  GDriveConnector,
} from "@triadlabs/connectors-gdrive";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allocateOutputPath,
  readManifest,
  sanitizeFilename,
  syncDump,
  writeManifest,
  type DumpManifest,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "triad-connectors-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("output filenames", () => {
  it("sanitizes path-hostile characters and unsafe dot names", () => {
    expect(sanitizeFilename(' ../Q3: plan? <draft> \\ ')).toBe("-Q3- plan- -draft- -");
    expect(sanitizeFilename("..secret plans")).toBe("secret plans");
  });

  it("uses a fallback when sanitization produces an empty filename", () => {
    expect(sanitizeFilename(".. ")).toBe("untitled");
    expect(sanitizeFilename("...")).toBe("untitled");
  });

  it("adds a stable provider ID suffix for collisions", () => {
    const first = allocateOutputPath("Report/Q3", "first", new Set());
    const second = allocateOutputPath(
      "Report\\Q3",
      "provider-id-123",
      new Set([first.toLowerCase()]),
    );
    expect(first).toBe("Report-Q3.md");
    expect(second).toBe("Report-Q3-provider.md");

    const dotted = allocateOutputPath("..Report/Q3", "provider-id-123", new Set([
      first.toLowerCase(),
    ]));
    expect(dotted).toBe("Report-Q3-provider.md");
  });
});

describe("manifest", () => {
  it("round-trips through JSON", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "manifest.json");
    const manifest: DumpManifest = {
      documents: [{
        providerDocId: "doc-1",
        name: "Doc",
        mimeType: "text/plain",
        modifiedAt: "2026-08-31T00:00:00.000Z",
        contentHash: "abc",
        output: "Doc.md",
      }],
      resume: {
        cursor: { pageToken: "next" },
        visitedTargets: { files: ["file-1"], folders: ["folder-1"] },
      },
      savedAt: "2026-08-31T00:00:00.000Z",
    };
    writeManifest(path, manifest);
    expect(readManifest(path)).toEqual(manifest);
  });
});

describe("syncDump", () => {
  it.each([
    ["..secret plans", "secret plans.md"],
    ["../escape", "-escape.md"],
  ])("writes %s to a safe path inside the output directory", async (name, output) => {
    const directory = temporaryDirectory();
    const metadata: ConnectorDocument = {
      providerDocId: "doc-1",
      name,
      mimeType: "text/plain",
      modifiedAt: "2026-08-31T00:00:00.000Z",
      contentHash: "",
      markdown: "",
    };
    const connector: GDriveConnector = {
      listChanges: vi.fn().mockResolvedValue({
        documents: [metadata],
        removed: [],
        skipped: [],
        cursor: { pageToken: "next" },
        visitedTargets: { files: [], folders: [] },
      }),
      fetchContent: vi.fn().mockResolvedValue({
        ...metadata,
        markdown: "safe content",
        contentHash: "safe-hash",
      }),
    };

    const { manifest, summary } = await syncDump({ connector, outDir: directory });

    expect(manifest.documents[0]?.output).toBe(output);
    expect(summary.new).toBe(1);
    expect(readFileSync(join(directory, output), "utf8")).toBe("safe content");
  });

  it("uses a mocked connector and skips rewriting identical content", async () => {
    const directory = temporaryDirectory();
    const metadata: ConnectorDocument = {
      providerDocId: "doc-1",
      name: "Doc",
      mimeType: "application/vnd.google-apps.document",
      modifiedAt: "2026-08-31T00:00:00.000Z",
      contentHash: "",
      markdown: "",
    };
    const connector: GDriveConnector = {
      listChanges: vi.fn().mockResolvedValue({
        documents: [metadata],
        removed: [],
        skipped: [],
        cursor: { pageToken: "next" },
        visitedTargets: { files: [], folders: [] },
      }),
      fetchContent: vi.fn().mockResolvedValue({
        ...metadata,
        markdown: "same content",
        contentHash: "same-hash",
      }),
    };
    const previous: DumpManifest = {
      documents: [{
        ...metadata,
        contentHash: "same-hash",
        output: "Doc.md",
      }],
      resume: {
        cursor: { pageToken: "old" },
        visitedTargets: { files: [], folders: [] },
      },
      savedAt: "2026-08-30T00:00:00.000Z",
    };

    const { summary } = await syncDump({ connector, outDir: directory, previous });

    expect(connector.listChanges).toHaveBeenCalledWith(previous.resume);
    expect(connector.fetchContent).toHaveBeenCalledWith(metadata);
    expect(summary).toEqual({ new: 0, updated: 0, unchanged: 1, removed: 0, errors: 0 });
    expect(() => readFileSync(join(directory, "Doc.md"), "utf8")).toThrow();
  });

  it("keeps shortcut documents when an expired cursor triggers backfill", async () => {
    const directory = temporaryDirectory();
    const metadata: ConnectorDocument = {
      providerDocId: "shortcut-target",
      name: "Shortcut target",
      mimeType: "text/plain",
      modifiedAt: "2026-08-31T00:00:00.000Z",
      contentHash: "",
      markdown: "",
    };
    writeFileSync(join(directory, "Shortcut target.md"), "same content", "utf8");
    const connector: GDriveConnector = {
      listChanges: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("expired"), { code: 410 }))
        .mockResolvedValueOnce({
          documents: [metadata],
          removed: [],
          skipped: [],
          cursor: { pageToken: "fresh" },
          visitedTargets: { files: ["shortcut-target"], folders: [] },
        }),
      fetchContent: vi.fn().mockResolvedValue({
        ...metadata,
        markdown: "same content",
        contentHash: "same-hash",
      }),
    };
    const previous: DumpManifest = {
      documents: [{
        ...metadata,
        contentHash: "same-hash",
        output: "Shortcut target.md",
      }],
      resume: {
        cursor: { pageToken: "expired" },
        visitedTargets: { files: ["shortcut-target"], folders: [] },
      },
      savedAt: "2026-08-30T00:00:00.000Z",
    };

    const { manifest, summary } = await syncDump({
      connector,
      outDir: directory,
      previous,
    });

    expect(connector.listChanges).toHaveBeenNthCalledWith(1, previous.resume);
    expect(connector.listChanges).toHaveBeenNthCalledWith(2);
    expect(manifest.documents.map((document) => document.providerDocId))
      .toEqual(["shortcut-target"]);
    expect(summary.removed).toBe(0);
    expect(readFileSync(join(directory, "Shortcut target.md"), "utf8"))
      .toBe("same content");
  });
});
