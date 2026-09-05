import { beforeEach, describe, expect, it, vi } from "vitest";
import type { drive_v3 } from "googleapis";
import { createIterateChanges } from "../src/stream.js";
import { ConnectorResumeError, ConnectorRescanRequiredError, ConnectorProviderError, ConnectorCursorExpiredError } from "@triadlabs/connectors-core";
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
    for await (const event of createIterateChanges({ drive, getFolderId: async () => undefined })({ cursor: { pageToken: "start" } })) {
      if (event.kind === "checkpoint") { checkpoint = JSON.parse(JSON.stringify(event.resume)); break; }
    }
    const events = await collect(createIterateChanges({ drive, getFolderId: async () => undefined })(checkpoint));
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
    await expect(collect(make()())).rejects.toBeInstanceOf(ConnectorProviderError);
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

  it("rejects malformed legacy state with an actionable resume error", async () => {
    for (const resume of [null, [], { visitedTargets: null }, { cursor: null }, { extra: true }]) {
      await expect(collect(make()(resume as never))).rejects.toBeInstanceOf(ConnectorResumeError);
    }
  });

  it("does not authorize a sweep when provider file metadata is malformed", async () => {
    list.mockResolvedValue({ data: { files: [{ name: "missing ID", mimeType: "text/plain" }] } });
    const events: GDriveStreamEvent[] = [];
    await expect((async () => {
      for await (const event of make()()) events.push(event);
    })()).rejects.toBeInstanceOf(ConnectorProviderError);
    expect(events.some(e => e.kind === "complete")).toBe(false);
  });

  it("handles whole-drive discovery without a root-folder lookup", async () => {
    const iterate = createIterateChanges({ drive, getFolderId: async () => undefined });
    list.mockResolvedValue({ data: { files: [file("one")] } });
    expect(ids(await collect(iterate()))).toEqual(["one"]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("source membership", () => {
  it("retains shortcut membership when its target was already discovered directly", async () => {
    list.mockResolvedValue({ data: { files: [file("target"), file("link", { mimeType: shortcutMime, shortcutDetails: { targetId: "target" } })] } });
    get.mockImplementation(async ({ fileId }) => ({ data: fileId === "root" ? { id: "root", mimeType: folderMime } : file("target") }));
    const backfill = await collect(make()());
    expect(ids(backfill)).toEqual(["target"]);
    const resume = lastResume(backfill);
    expect(resume.visitedTargets.files).toEqual(["target"]);
    changes.mockResolvedValue({ data: { changes: [{ file: file("target", { parents: [] }) }], newStartPageToken: "end" } });
    const incremental = await collect(make()(resume));
    expect(ids(incremental)).toEqual(["target"]);
    expect(incremental.some(e => e.kind === "removed")).toBe(false);
  });

  it("emits removal when a live file leaves the selected folder", async () => {
    changes.mockResolvedValue({ data: { changes: [{ file: file("moved", { parents: [] }) }], newStartPageToken: "end" } });
    const events = await collect(make()({ cursor: { pageToken: "start" } }));
    expect(events.find(e => e.kind === "removed")).toEqual({ kind: "removed", providerDocId: "moved", reason: "outOfScope" });
  });

  it.each([folderMime, shortcutMime])("requests a rescan for a %s structural change before checkpointing it", async (mimeType) => {
    changes.mockResolvedValue({ data: { changes: [{ file: file("structural", { mimeType }) }], newStartPageToken: "end" } });
    const events: GDriveStreamEvent[] = [];
    await expect((async () => { for await (const e of make()({ cursor: { pageToken: "start" } })) events.push(e); })()).rejects.toBeInstanceOf(ConnectorRescanRequiredError);
    expect(events).toEqual([]);
  });

  it("rescans unknown removals instead of assuming a removed folder has no descendants", async () => {
    changes.mockResolvedValue({ data: { changes: [{ fileId: "removed-subtree", removed: true }], newStartPageToken: "end" } });
    await expect(collect(make()({ cursor: { pageToken: "start" } }))).rejects.toBeInstanceOf(ConnectorRescanRequiredError);
  });

  it("re-backfill finds descendants when a populated folder enters scope", async () => {
    list.mockImplementation(async ({ q }) => ({ data: { files: q.startsWith("'root'") ? [file("moved-folder", { mimeType: folderMime })] : [file("old-child")] } }));
    expect(ids(await collect(make()()))).toEqual(["old-child"]);
  });

  it("removing one shortcut preserves a target reached by the remaining shortcut", async () => {
    const shortcut = (id: string) => file(id, { mimeType: shortcutMime, shortcutDetails: { targetId: "target" } });
    get.mockImplementation(async ({ fileId }) => ({ data: fileId === "root" ? { id: "root", mimeType: folderMime } : file("target", { parents: [] }) }));
    list.mockResolvedValueOnce({ data: { files: [shortcut("a"), shortcut("b")] } })
      .mockResolvedValueOnce({ data: { files: [shortcut("b")] } })
      .mockResolvedValueOnce({ data: { files: [] } });
    expect(ids(await collect(make()()))).toEqual(["target"]);
    expect(ids(await collect(make()()))).toEqual(["target"]);
    const removed = await collect(make()());
    expect(ids(removed)).toEqual([]);
    expect(removed.at(-1)).toMatchObject({ coverage: "complete" });
  });

  it("retargeting a shortcut drops its old target from a new inventory", async () => {
    get.mockImplementation(async ({ fileId }) => ({ data: fileId === "root" ? { id: "root", mimeType: folderMime } : file(fileId, { parents: [] }) }));
    list.mockResolvedValueOnce({ data: { files: [file("link", { mimeType: shortcutMime, shortcutDetails: { targetId: "old" } })] } })
      .mockResolvedValueOnce({ data: { files: [file("link", { mimeType: shortcutMime, shortcutDetails: { targetId: "new" } })] } });
    const old = lastResume(await collect(make()()));
    const fresh = await collect(make()({ visitedTargets: old.visitedTargets }));
    expect(ids(fresh)).toEqual(["new"]);
    expect(lastResume(fresh).visitedTargets.files).toEqual(["new"]);
  });

  it("keeps files reached through a direct path after a shortcut disappears", async () => {
    list.mockResolvedValue({ data: { files: [file("target")] } });
    expect(ids(await collect(make()()))).toEqual(["target"]);
  });

  it("follows multiple parent paths without caching an early false result", async () => {
    changes.mockResolvedValue({ data: { changes: [{ file: file("nested", { parents: ["allowed", "outside"] }) }], newStartPageToken: "end" } });
    get.mockImplementation(async ({ fileId }) => ({ data: { id: fileId, parents: fileId === "allowed" ? ["root"] : [] } }));
    expect(ids(await collect(make()({ cursor: { pageToken: "start" } })))).toEqual(["nested"]);
  });

  it.each([429, 503, 403])("does not turn HTTP %i on a parent lookup into removal", async (status) => {
    changes.mockResolvedValue({ data: { changes: [{ file: file("nested", { parents: ["parent"] }) }], newStartPageToken: "end" } });
    get.mockRejectedValue({ response: { status, headers: { "retry-after": "2" } } });
    await expect(collect(make()({ cursor: { pageToken: "start" } }))).rejects.toMatchObject({ name: "ConnectorProviderError", status, retryAfterMs: 2000, retryable: status !== 403 });
  });

  it("requires a rescan after a confirmed missing parent", async () => {
    changes.mockResolvedValue({ data: { changes: [{ file: file("nested", { parents: ["parent"] }) }], newStartPageToken: "end" } });
    get.mockRejectedValue({ response: { status: 404 } });
    await expect(collect(make()({ cursor: { pageToken: "start" } }))).rejects.toBeInstanceOf(ConnectorRescanRequiredError);
  });

  it("exposes rate-limited 403 responses as retryable", async () => {
    list.mockRejectedValue({ response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } });
    await expect(collect(make()())).rejects.toMatchObject({ retryable: true });
  });

  it("does not complete a backfill when the source root is inaccessible", async () => {
    get.mockRejectedValue({ response: { status: 404 } });
    await expect(collect(make()())).rejects.toBeInstanceOf(ConnectorProviderError);
    expect(list).not.toHaveBeenCalled();
  });

  it("does not swallow transient shortcut resolution errors", async () => {
    list.mockResolvedValue({ data: { files: [file("link", { mimeType: shortcutMime, shortcutDetails: { targetId: "target" } })] } });
    get.mockImplementation(async ({ fileId }) => {
      if (fileId === "target") throw { response: { status: 503 } };
      return { data: { id: "root", mimeType: folderMime } };
    });
    await expect(collect(make()())).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("marks an unresolved shortcut partial rather than authorizing a sweep", async () => {
    list.mockResolvedValue({ data: { files: [file("link", { mimeType: shortcutMime, shortcutDetails: { targetId: "missing" } })] } });
    get.mockImplementation(async ({ fileId }) => {
      if (fileId === "missing") throw { response: { status: 404 } };
      return { data: { id: "root", mimeType: folderMime } };
    });
    expect((await collect(make()())).at(-1)).toMatchObject({ coverage: "partial" });
  });

  it("maps expired feed cursors to the existing reset error", async () => {
    changes.mockRejectedValue({ response: { status: 410 } });
    await expect(collect(make()({ cursor: { pageToken: "expired" } }))).rejects.toBeInstanceOf(ConnectorCursorExpiredError);
  });

  it("a restarted partial scan retains partial coverage", async () => {
    list.mockResolvedValueOnce({ data: { files: [], incompleteSearch: true, nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { files: [] } });
    let saved: GDriveCheckpoint | undefined;
    for await (const e of make()()) if (e.kind === "checkpoint") { saved = e.resume; break; }
    expect((await collect(make()(saved))).at(-1)).toMatchObject({ coverage: "partial" });
  });
});
