import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EditorM7WatchEvent } from "@oscharko-dev/keiko-contracts";

import {
  createWorkspaceWatchService,
  type WorkspaceNativeWatchHandle,
  type WorkspaceWatchAdapter,
  type WorkspaceWatchAdapterArgs,
  type WorkspaceWatchRawEvent,
} from "./workspaceWatchService.js";

interface FakeHandle extends WorkspaceNativeWatchHandle {
  readonly close: Mock<() => void>;
}

class FakeAdapter implements WorkspaceWatchAdapter {
  public readonly calls: WorkspaceWatchAdapterArgs[] = [];
  public readonly handles: FakeHandle[] = [];
  public recursive = true;
  public throwOnWatch = false;

  public watch(args: WorkspaceWatchAdapterArgs): WorkspaceNativeWatchHandle {
    if (this.throwOnWatch) throw new Error("watch unavailable");
    this.calls.push(args);
    const handle: FakeHandle = { recursive: this.recursive, close: vi.fn<() => void>() };
    this.handles.push(handle);
    return handle;
  }

  public emit(event: WorkspaceWatchRawEvent): void {
    this.calls.at(-1)?.onEvent(event);
  }

  public fail(): void {
    this.calls.at(-1)?.onError(new Error("watch failed"));
  }
}

let root = "";
let outside = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-watch-root-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "keiko-watch-outside-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error("condition was not observed");
}

function service(
  adapter: FakeAdapter,
  maxQueueDepth = 16,
): ReturnType<typeof createWorkspaceWatchService> {
  return createWorkspaceWatchService({
    adapter,
    coalesceMs: 0,
    fallbackPollMs: 5_000,
    idleTearDownMs: 0,
    maxQueueDepth,
    replayCapacity: 2,
  });
}

async function drainInitialBaseline(
  manager: ReturnType<typeof createWorkspaceWatchService>,
  adapter: FakeAdapter,
): Promise<void> {
  adapter.emit({ eventType: "change", filename: "__baseline_probe__.missing" });
  await waitForCondition(() => manager.snapshot(root).queueDepth === 0);
}

describe("workspace watch service", () => {
  it("shares one native watcher per canonical root and closes it after the last unsubscribe", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const first = manager.subscribe({ root, onEvent: vi.fn() });
    const second = manager.subscribe({ root, onEvent: vi.fn() });

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    expect(adapter.calls).toHaveLength(1);
    if (first.kind === "ok") first.unsubscribe();
    expect(adapter.handles[0]?.close).not.toHaveBeenCalled();
    if (second.kind === "ok") second.unsubscribe();

    await waitForCondition(() => adapter.handles[0]?.close.mock.calls.length === 1);
  });

  it("emits reconciled create, change, delete, and rename deltas without file content", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    await writeFile(join(root, "a.txt"), "one", "utf8");
    adapter.emit({ eventType: "rename", filename: "a.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "created"));

    await writeFile(join(root, "a.txt"), "one two", "utf8");
    adapter.emit({ eventType: "change", filename: "a.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "changed"));

    await rename(join(root, "a.txt"), join(root, "b.txt"));
    adapter.emit({ eventType: "rename", oldFilename: "a.txt", filename: "b.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "renamed"));

    await unlink(join(root, "b.txt"));
    adapter.emit({ eventType: "rename", filename: "b.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "deleted"));

    expect(JSON.stringify(events)).not.toContain("one two");
    expect(events.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4]);
    expect(events.find((event) => event.kind === "renamed")).toMatchObject({
      relativePath: "b.txt",
      oldRelativePath: "a.txt",
    });
  });

  it("seeds existing entries before processing native change events", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const events: EditorM7WatchEvent[] = [];
    await writeFile(join(root, "existing.txt"), "one", "utf8");
    manager.subscribe({ root, onEvent: (event) => events.push(event) });

    adapter.emit({ eventType: "change", filename: "existing.txt" });
    await waitForCondition(() => manager.snapshot(root).queueDepth === 0);
    expect(events).toHaveLength(0);

    await writeFile(join(root, "existing.txt"), "one two", "utf8");
    adapter.emit({ eventType: "change", filename: "existing.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "changed"));

    expect(events.some((event) => event.kind === "created")).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "changed", relativePath: "existing.txt" });
  });

  it("turns null filenames, burst overflow, and unavailable native watch into explicit degraded state", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter, 1);
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });

    adapter.emit({ eventType: "change", filename: null });
    await waitForCondition(() => events.some((event) => event.kind === "rescan"));

    adapter.emit({ eventType: "rename", filename: "first.txt" });
    adapter.emit({ eventType: "rename", filename: "second.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "overflow"));

    adapter.fail();
    const snapshot = manager.snapshot(root);
    expect(snapshot.health).toBe("rescanRequired");
    expect(snapshot.degradedReasons).toEqual(
      expect.arrayContaining(["ambiguous-event", "event-overflow", "native-watch-unavailable"]),
    );
  });

  it("rejects escaping symlink substitutions and never emits the hostile relative path", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });

    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));
    adapter.emit({ eventType: "rename", filename: "linked-secret.txt" });

    await waitForCondition(() => manager.snapshot(root).degradedReasons.includes("unsafe-path"));
    expect(events.some((event) => event.relativePath === "linked-secret.txt")).toBe(false);
  });

  it("replays retained sequence events and requires a snapshot on silent gaps", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const firstEvents: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => firstEvents.push(event) });
    await drainInitialBaseline(manager, adapter);

    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(root, name), name, "utf8");
      adapter.emit({ eventType: "rename", filename: name });
    }
    await waitForCondition(() => firstEvents.length === 3);

    const replayed = manager.subscribe({ root, lastSequence: 2, onEvent: vi.fn() });
    expect(replayed).toMatchObject({ kind: "ok", snapshotRequired: false });
    if (replayed.kind === "ok")
      expect(replayed.replay.map((event) => event.relativePath)).toEqual(["c.txt"]);

    const stale = manager.subscribe({ root, lastSequence: 0, onEvent: vi.fn() });
    expect(stale).toMatchObject({ kind: "ok", snapshotRequired: true });
  });

  it("stops callbacks after disposal and reports fallback health when native watching is unavailable", () => {
    const adapter = new FakeAdapter();
    adapter.throwOnWatch = true;
    const manager = service(adapter);
    const listener = vi.fn();

    const subscription = manager.subscribe({ root, onEvent: listener });
    expect(subscription.snapshot).toMatchObject({
      health: "degraded",
      nativeWatcherCount: 0,
      degradedReasons: ["native-watch-unavailable"],
    });
    manager.disposeRoot(root);
    adapter.emit({ eventType: "rename", filename: "late.txt" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back to polling after an async native watcher error", async () => {
    const adapter = new FakeAdapter();
    const manager = createWorkspaceWatchService({
      adapter,
      coalesceMs: 0,
      fallbackPollMs: 5,
      idleTearDownMs: 0,
      maxQueueDepth: 16,
      replayCapacity: 8,
    });
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    adapter.fail();
    expect(adapter.handles[0]?.close).toHaveBeenCalledOnce();
    expect(manager.snapshot(root).nativeWatcherCount).toBe(0);

    await writeFile(join(root, "after-failure.txt"), "one", "utf8");
    await waitForCondition(() =>
      events.some(
        (event) => event.kind === "created" && event.relativePath === "after-failure.txt",
      ),
    );
  });

  it("applies additionalExclusions to suppress matching watch events", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({
      root,
      onEvent: (event) => events.push(event),
      additionalExclusions: ["generated"],
    });
    await drainInitialBaseline(manager, adapter);

    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "file.txt"), "one", "utf8");
    adapter.emit({ eventType: "rename", filename: "generated/file.txt" });

    await writeFile(join(root, "allowed.txt"), "one", "utf8");
    adapter.emit({ eventType: "rename", filename: "allowed.txt" });
    await waitForCondition(() => events.some((event) => event.relativePath === "allowed.txt"));

    expect(events.some((event) => event.relativePath.startsWith("generated"))).toBe(false);
  });

  it("does not fabricate deleted events when a fallback rescan is truncated by maxScanEntries", async () => {
    const adapter = new FakeAdapter();
    await mkdir(join(root, "dirA"), { recursive: true });
    await writeFile(join(root, "dirA", "existing.txt"), "existing", "utf8");
    const manager = createWorkspaceWatchService({
      adapter,
      coalesceMs: 0,
      fallbackPollMs: 5,
      idleTearDownMs: 0,
      maxQueueDepth: 16,
      replayCapacity: 8,
      maxScanEntries: 1,
    });
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "new.txt"), "new", "utf8");

    adapter.fail();
    await waitForCondition(() => events.some((event) => event.kind === "overflow"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(events.some((event) => event.kind === "deleted")).toBe(false);
  });

  it("signals a root-replaced rescan when the watched root is moved out from under the watcher", async () => {
    const adapter = new FakeAdapter();
    const manager = createWorkspaceWatchService({
      adapter,
      coalesceMs: 0,
      fallbackPollMs: 5,
      idleTearDownMs: 0,
      maxQueueDepth: 16,
      replayCapacity: 8,
    });
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    await rename(root, join(outside, "relocated-root"));
    adapter.fail();

    await waitForCondition(() => events.some((event) => event.kind === "rescan"));
    const snapshot = manager.snapshot(root);
    expect(snapshot.health).toBe("rescanRequired");
    expect(snapshot.degradedReasons).toEqual(
      expect.arrayContaining(["native-watch-unavailable", "root-replaced"]),
    );
    expect(events.find((event) => event.kind === "rescan")).toMatchObject({
      reason: "root-replaced",
      health: "rescanRequired",
      relativePath: "",
    });
  });

  it("signals a root-replaced rescan when the watched root is replaced by a non-directory", async () => {
    const adapter = new FakeAdapter();
    const manager = createWorkspaceWatchService({
      adapter,
      coalesceMs: 0,
      fallbackPollMs: 5,
      idleTearDownMs: 0,
      maxQueueDepth: 16,
      replayCapacity: 8,
    });
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    await rename(root, join(outside, "relocated-root-file"));
    await writeFile(root, "now-a-file", "utf8");
    adapter.fail();

    await waitForCondition(() => events.some((event) => event.kind === "rescan"));
    expect(manager.snapshot(root).degradedReasons).toContain("root-replaced");
    expect(events.find((event) => event.kind === "rescan")).toMatchObject({
      reason: "root-replaced",
    });
  });

  it("stays healthy when a native event's file vanishes before its metadata stat (ENOENT race)", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    // The OS delivers a create event, but the file is deleted before reconciliation stats it —
    // the same shape as an ENOENT racing a stat() between readdir and stat. It was never known,
    // so no delta is fabricated and the watcher must not degrade or crash.
    adapter.emit({ eventType: "rename", filename: "vanished-before-stat.txt" });
    await waitForCondition(() => manager.snapshot(root).queueDepth === 0);

    expect(events).toHaveLength(0);
    expect(manager.snapshot(root).health).toBe("healthy");
    expect(manager.snapshot(root).degradedReasons).toEqual([]);
  });

  it("reports the observed size for a truncated mid-write and reconciles when the write completes", async () => {
    const adapter = new FakeAdapter();
    const manager = service(adapter);
    const events: EditorM7WatchEvent[] = [];
    manager.subscribe({ root, onEvent: (event) => events.push(event) });
    await drainInitialBaseline(manager, adapter);

    // First observation catches the file mid-write (partial bytes on disk); the watcher reports
    // whatever size it saw rather than blocking or erroring.
    await writeFile(join(root, "streamed.txt"), "AB", "utf8");
    adapter.emit({ eventType: "rename", filename: "streamed.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "created"));

    // The write then completes; a subsequent change event reconciles the final size.
    await writeFile(join(root, "streamed.txt"), "ABCDEFGH", "utf8");
    adapter.emit({ eventType: "change", filename: "streamed.txt" });
    await waitForCondition(() => events.some((event) => event.kind === "changed"));

    expect(events.find((event) => event.kind === "created")).toMatchObject({
      relativePath: "streamed.txt",
      sizeBytes: 2,
    });
    expect(events.find((event) => event.kind === "changed")).toMatchObject({
      relativePath: "streamed.txt",
      sizeBytes: 8,
    });
    expect(manager.snapshot(root).health).toBe("healthy");
  });
});
