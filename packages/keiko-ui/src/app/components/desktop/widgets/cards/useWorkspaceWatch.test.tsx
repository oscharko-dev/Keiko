import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import { useWorkspaceWatch } from "./useWorkspaceWatch";

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
      expect(result.current).toEqual({
        health: "rescanRequired",
        sequence: 9,
        degradedReason: "sequence-gap",
        snapshotRequired: true,
      });
    });

    act(() => {
      FakeEventSource.instances[0]?.emitRaw("editor-watch:changed", "{not-json");
    });

    expect(onEvent).not.toHaveBeenCalled();
  });
});
