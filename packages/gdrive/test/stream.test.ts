import { beforeEach, describe, expect, it, vi } from "vitest";
import type { drive_v3 } from "googleapis";
import { createIterateChanges } from "../src/stream.js";
import { ConnectorResumeError } from "@triadlabs/connectors-core";
import type { GDriveCheckpoint, GDriveStreamEvent } from "../src/types.js";

const folderMime = "application/vnd.google-apps.folder";
const shortcutMime = "application/vnd.google-apps.shortcut";
const file = (id: string, extra = {}) => ({ id, name: id, mimeType: "text/plain", parents: ["root"], ...extra });
const list = vi.fn(); const get = vi.fn(); const changes = vi.fn(); const start = vi.fn();
const drive = { files: { list, get }, changes: { list: changes, getStartPageToken: start } } as unknown as drive_v3.Drive;
const make = (folder: string | undefined = "root") => createIterateChanges({ drive, getFolderId: async () => folder });
async function collect(iterable: AsyncIterable<GDriveStreamEvent>) {
  const events: GDriveStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
function ids(events: GDriveStreamEvent[]) { return events.flatMap(e => e.kind === "document" ? [e.document.providerDocId] : []); }
function lastResume(events: GDriveStreamEvent[]) {
  const end = events.at(-1);
  if (end?.kind !== "complete") throw new Error("not complete");
  return JSON.parse(JSON.stringify(end.resume)) as GDriveCheckpoint;
}
beforeEach(() => {
  vi.resetAllMocks();
  start.mockResolvedValue({ data: { startPageToken: "start" } });
  get.mockImplementation(async ({ fileId }) => ({ data: { id: fileId, mimeType: folderMime, parents: ["root"] } }));
  list.mockResolvedValue({ data: { files: [] } });
  changes.mockResolvedValue({ data: { changes: [], newStartPageToken: "next" } });
});

describe("streaming discovery", () => {
  it("resumes a paginated walk with pending children on a new instance", async () => {
    list.mockImplementation(async ({ q, pageToken }) => ({ data:
      q.startsWith("'child'") ? { files: [file("nested")] } : pageToken === "page2" ? { files: [file("second")] } :
      { files: [file("first"), file("child", { mimeType: folderMime })], nextPageToken: "page2" } }));
    let checkpoint: GDriveCheckpoint | undefined;
    const first: GDriveStreamEvent[] = [];
    for await (const event of make()()) {
      first.push(event);
      if (event.kind === "checkpoint") { checkpoint = JSON.parse(JSON.stringify(event.resume)); break; }
    }
    expect(list).toHaveBeenCalledTimes(1);
    const second = await collect(make()(checkpoint));
    expect(ids([...first, ...second])).toEqual(["first", "second", "nested"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(lastResume(second).cursor.pageToken).toBe("start");
    expect(lastResume(second).phase).toBe("idle");
  });

  it("does not fetch another page until the consumer asks", async () => {
    list.mockResolvedValue({ data: { files: [file("one"), file("two")], nextPageToken: "p2" } });
    const iterator = make()();
    expect((await iterator.next()).value?.kind).toBe("document");
    expect(list).toHaveBeenCalledTimes(1);
    await iterator.return(undefined);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("replays an uncommitted page without losing events", async () => {
    list.mockResolvedValue({ data: { files: [file("one"), file("two")] } });
    const iterator = make()();
    await iterator.next(); await iterator.return(undefined);
    expect(ids(await collect(make()()))).toEqual(["one", "two"]);
  });

  it("resumes incremental pagination and preserves repeated updates in order", async () => {
    changes.mockImplementation(async ({ pageToken }) => ({ data: pageToken === "start" ?
      { changes: [{ file: file("one") }], nextPageToken: "p2" } :
      { changes: [{ file: file("one", { name: "new name" }) }, { fileId: "deleted", removed: true }], newStartPageToken: "end" } }));
    let checkpoint: GDriveCheckpoint | undefined;
    for await (const event of make()({ cursor: { pageToken: "start" } })) {
      if (event.kind === "checkpoint") { checkpoint = JSON.parse(JSON.stringify(event.resume)); break; }
    }
    const events = await collect(make()(checkpoint));
    expect(ids(events)).toEqual(["one"]);
    expect(events.find(e => e.kind === "removed")).toMatchObject({ providerDocId: "deleted" });
    expect(lastResume(events).cursor.pageToken).toBe("end");
  });

  it("does not mutate supplied checkpoints or previously yielded snapshots", async () => {
    const saved = lastResume(await collect(make()()));
    const original = JSON.stringify(saved);
    await collect(make()(saved));
    expect(JSON.stringify(saved)).toBe(original);
  });

  it("deduplicates direct files and shortcuts and detects cycles", async () => {
    list.mockResolvedValue({ data: { files: [file("target"), file("shortcut", { mimeType: shortcutMime, shortcutDetails: { targetId: "target" } }), file("cycle", { mimeType: shortcutMime, shortcutDetails: { targetId: "cycle" } })] } });
    get.mockImplementation(async ({ fileId }) => ({ data: fileId === "root" ? { id: "root", mimeType: folderMime } : fileId === "cycle" ? file("cycle", { mimeType: shortcutMime, shortcutDetails: { targetId: "cycle" } }) : file("target") }));
    const events = await collect(make()());
    expect(ids(events)).toEqual(["target"]);
    expect(events.find(e => e.kind === "skipped")).toMatchObject({ entry: { reason: "shortcut_cycle_detected" } });
    expect(events.at(-1)).toMatchObject({ coverage: "partial" });
  });

  it("marks incomplete search partial and propagates failures without completion", async () => {
    list.mockResolvedValueOnce({ data: { files: [file("one")], incompleteSearch: true } });
    expect((await collect(make()())).at(-1)).toMatchObject({ coverage: "partial" });
    list.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(collect(make()())).rejects.toThrow("provider unavailable");
  });

  it("cancels without completion and passes the signal to requests", async () => {
    const controller = new AbortController();
    list.mockResolvedValue({ data: { files: [file("one"), file("two")] } });
    const iterator = make()(undefined, { signal: controller.signal });
    await iterator.next(); controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(list).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  it("rejects incompatible, malformed, or wrong-scope checkpoints", async () => {
    const saved = lastResume(await collect(make()()));
    for (const changed of [{ version: 99 }, { scope: "folder:other" }, { visitedFiles: null }, { pendingFolders: [null] }, { filesDiscovered: -1 }]) {
      await expect(collect(make()({ ...saved, ...changed } as never))).rejects.toBeInstanceOf(ConnectorResumeError);
    }
  });

  it("handles whole-drive discovery without a root-folder lookup", async () => {
    const iterate = createIterateChanges({ drive, getFolderId: async () => undefined });
    list.mockResolvedValue({ data: { files: [file("one")] } });
    expect(ids(await collect(iterate()))).toEqual(["one"]);
    expect(get).not.toHaveBeenCalled();
  });
});
