import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import { useWorkspaceWatch } from "./useWorkspaceWatch";

vi.mock("../../../../../lib/browser-stream-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/browser-stream-capacity")>()),
  acquirePersistentBrowserStreamCapacity: (onGranted: () => void): (() => void) => {
    onGranted();
    return () => undefined;
  },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent<string>(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitRaw(type: string, data: string): void {
    const event = new MessageEvent<string>(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  resetSharedEventSourcesForTests();
  vi.unstubAllGlobals();
});

describe("useWorkspaceWatch", () => {
  it("shares a workspace watch stream and parses content-free file events", () => {
    const onFirstEvent = vi.fn();
    const onSecondEvent = vi.fn();

    renderHook(() => useWorkspaceWatch("/repo", onFirstEvent));
    renderHook(() => useWorkspaceWatch("/repo", onSecondEvent));

    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      "/api/editor/workspace-watch/events?root=%2Frepo",
    ]);

    act(() => {
      FakeEventSource.instances[0]?.emit("editor-watch:changed", {
        schemaVersion: "1",
        sequence: 7,
        kind: "changed",
        relativePath: "src/app.ts",
        metadataHash: "0123456789abcdef",
      });
    });

    expect(onFirstEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "changed", relativePath: "src/app.ts", sequence: 7 }),
    );
    expect(onSecondEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "changed", relativePath: "src/app.ts", sequence: 7 }),
    );
  });

  it("marks snapshot gaps and ignores malformed stream payloads", async () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() => useWorkspaceWatch("/repo", onEvent));

    act(() => {
      FakeEventSource.instances[0]?.emit("editor-watch:snapshot-required", {
        schemaVersion: "1",
        sequence: 9,
        rootToken: "0123456789abcdef",
        nativeWatcherCount: 1,
        subscriberCount: 1,
        queueDepth: 0,
        replayCapacity: 100,
        replayOldestSequence: 1,
        eventCount: 8,
        requiresSnapshot: true,
        health: "rescanRequired",
        degradedReasons: ["sequence-gap"],
      });
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        health: "rescanRequired",
        sequence: 9,
        degradedReason: "sequence-gap",
        snapshotRequired: true,
      });
    });

    act(() => result.current.acknowledgeSnapshot());
    expect(result.current).toMatchObject({
      health: "rescanRequired",
      sequence: 9,
      degradedReason: "sequence-gap",
      snapshotRequired: false,
    });

    act(() => {
      FakeEventSource.instances[0]?.emitRaw("editor-watch:changed", "{not-json");
    });

    expect(onEvent).not.toHaveBeenCalled();
  });
});

function watchSnapshot(health: "healthy" | "rescanRequired"): object {
  return {
    schemaVersion: "1",
    sequence: 9,
    rootToken: ["01234567", "89abcdef"].join(""),
    nativeWatcherCount: 1,
    subscriberCount: 1,
    queueDepth: 0,
    replayCapacity: 100,
    replayOldestSequence: 1,
    eventCount: 8,
    requiresSnapshot: false,
    health,
    degradedReasons: health === "healthy" ? [] : ["ambiguous-event"],
  };
}

it("does not retain the previous root's interrupted watch state", () => {
  const { result, rerender } = renderHook(({ root }) => useWorkspaceWatch(root, vi.fn()), {
    initialProps: { root: "/old" },
  });
  act(() =>
    FakeEventSource.instances[0]?.emit("editor-watch:snapshot", watchSnapshot("rescanRequired")),
  );
  expect(result.current.health).toBe("rescanRequired");
  rerender({ root: "/new" });
  expect(result.current).toMatchObject({ health: "healthy", sequence: 0, degradedReason: null });
});

it("refreshes the existing shared watch connection and accepts its recovery snapshot", () => {
  const first = renderHook(() => useWorkspaceWatch("/repo", vi.fn()));
  const second = renderHook(() => useWorkspaceWatch("/repo", vi.fn()));
  act(() =>
    FakeEventSource.instances[0]?.emit("editor-watch:snapshot", watchSnapshot("rescanRequired")),
  );
  expect(first.result.current.health).toBe("rescanRequired");
  act(() => first.result.current.refresh());
  expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
  expect(FakeEventSource.instances).toHaveLength(2);
  act(() => FakeEventSource.instances[1]?.emit("editor-watch:snapshot", watchSnapshot("healthy")));
  expect(first.result.current.health).toBe("healthy");
  expect(second.result.current.health).toBe("healthy");
});

it("keeps a current healthy snapshot while delivering older replay changes", () => {
  const onEvent = vi.fn();
  const { result } = renderHook(() => useWorkspaceWatch("/repo", onEvent));
  act(() => FakeEventSource.instances[0]?.emit("editor-watch:snapshot", watchSnapshot("healthy")));
  act(() =>
    FakeEventSource.instances[0]?.emit("editor-watch:rescan", {
      schemaVersion: "1",
      sequence: 4,
      kind: "rescan",
      relativePath: "",
      entryKind: "unknown",
      health: "rescanRequired",
      reason: "ambiguous-event",
    }),
  );
  expect(result.current.health).toBe("healthy");
  expect(result.current.sequence).toBe(9);
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ sequence: 4, kind: "rescan" }));
});
