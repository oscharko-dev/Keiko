/**
 * Hook-level tests for useEditorAgentBridge (GEN-PERF-EDITOR-002 + GEN-PERF-EDITOR-008).
 *
 * Mocks createSameOriginApiEventSource so we can count how many EventSources are opened as
 * panes subscribe/unsubscribe, and uses fake timers to prove the snapshot-register POST is
 * debounced across a cursor/selection burst.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  _resetEditorAgentBridgeStateForTests,
  EDITOR_AGENT_ACTIVITY_RECENCY_MS,
  EDITOR_SNAPSHOT_DEBOUNCE_MS,
  MAX_EDITOR_AGENT_IN_FLIGHT_ACTIONS,
  useEditorAgentBridge,
  type EditorAgentActionControllers,
  type UseEditorAgentBridgeParams,
} from "./editorAgentBridge";

const createSourceSpy = vi.fn();
const postResultSpy = vi.hoisted(() => vi.fn());

function capability(character: string): string {
  return character.repeat(43);
}

type RegisterSnapshot = UseEditorAgentBridgeParams["registerSnapshot"];

function registeredSnapshot(capabilityValue: string): Mock<RegisterSnapshot> {
  return vi.fn<RegisterSnapshot>((currentCapability) =>
    Promise.resolve({
      snapshot: null,
      ...(currentCapability === undefined ? { bridgeDecisionCapability: capabilityValue } : {}),
    }),
  );
}

async function flushBridgeMicrotasks(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

vi.mock("../../../../../lib/api", () => ({
  postEditorAgentActionResult: (body: unknown): unknown => postResultSpy(body),
}));

vi.mock("../../../../../lib/safe-event-source", () => ({
  createSameOriginApiEventSource: (url: string): unknown => createSourceSpy(url),
}));

class FakeEventSource {
  public readonly listeners = new Map<string, EventListener[]>();
  public closed = false;
  public constructor(public readonly url: string) {}
  public addEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  public removeEventListener(): void {
    // no-op for tests
  }
  public close(): void {
    this.closed = true;
  }
  public emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function latestEventSource(): FakeEventSource {
  const source = createSourceSpy.mock.results.at(-1)?.value as FakeEventSource | undefined;
  if (source === undefined) throw new Error("expected authenticated event source");
  return source;
}

function emitAction(source: FakeEventSource, sessionId: string, actionId: string): void {
  source.emit("editor-agent:action", {
    schemaVersion: "1",
    eventId: `event-${actionId}`,
    type: "action",
    action: {
      schemaVersion: "1",
      actionId,
      idempotencyKey: `key-${actionId}`,
      sessionId,
      type: "format",
      target: { file: "src/a.ts", paneId: "pane-1" },
    },
  });
}

function emitResult(
  source: FakeEventSource,
  sessionId: string,
  actionId: string,
  status: "queued" | "succeeded",
): void {
  source.emit("editor-agent:result", {
    schemaVersion: "1",
    eventId: `event-${actionId}-${status}`,
    type: "result",
    result: { schemaVersion: "1", actionId, sessionId, status },
  });
}

function makeControllers(): EditorAgentActionControllers {
  return {
    paneId: "pane-1",
    activePaneId: "pane-1",
    activeFile: "src/a.ts",
    verifyActiveTarget: vi.fn(() => true),
    onSelectOpenFile: vi.fn(),
    formattingEnabled: true,
    formatRequest: { increment: vi.fn() },
    persist: vi.fn().mockResolvedValue(true),
    currentText: () => "text",
    applyTextEdits: vi.fn(),
    applyPatch: vi.fn(),
    applyChangeset: vi.fn(),
    onSplitPane: vi.fn(),
    onMoveTab: vi.fn(),
    onRequestSelectionReveal: vi.fn(),
  };
}

beforeEach(() => {
  _resetEditorAgentBridgeStateForTests();
  createSourceSpy.mockReset();
  postResultSpy.mockReset();
  postResultSpy.mockResolvedValue({ result: { status: "succeeded" } });
  createSourceSpy.mockImplementation((url: string) => new FakeEventSource(url));
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  _resetEditorAgentBridgeStateForTests();
  vi.useRealTimers();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

// ─── GEN-PERF-EDITOR-002 — snapshot POST debounce ──────────────────────────────

describe("useEditorAgentBridge — snapshot debounce (GEN-PERF-EDITOR-002)", () => {
  it("collapses a burst of registerSnapshot identity changes into a bounded number of calls", () => {
    vi.useFakeTimers();
    const registerSnapshot = registeredSnapshot(capability("A"));
    const { rerender } = renderHook(
      ({ rs }: { rs: RegisterSnapshot }) =>
        useEditorAgentBridge({
          agentSessionId: "session-A",
          controllers: makeControllers(),
          registerSnapshot: rs,
          onConflict: vi.fn(),
        }),
      { initialProps: { rs: registerSnapshot } },
    );

    // 30 distinct registerSnapshot identities within one debounce window (as a
    // cursor/selection burst would produce). Each re-arms the trailing timer.
    for (let i = 0; i < 30; i += 1) {
      rerender({ rs: vi.fn(registerSnapshot) as typeof registerSnapshot });
    }
    // Nothing has fired yet; the burst is still within the debounce window.
    return act(async () => {
      vi.advanceTimersByTime(EDITOR_SNAPSHOT_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    }).then(() => {
      // One bootstrap plus at most one trailing refresh — far fewer than 30.
      expect(registerSnapshot.mock.calls.length).toBeLessThanOrEqual(2);
      expect(registerSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("keeps the issued capability in bridge memory and attaches it to refreshes and results", async () => {
    vi.useFakeTimers();
    const capability = "A".repeat(43);
    const registerSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ snapshot: null, bridgeDecisionCapability: capability })
      .mockResolvedValue({ snapshot: null });
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        useEditorAgentBridge({
          agentSessionId: "session-capability",
          controllers: makeControllers(),
          registerSnapshot: (currentCapability) => registerSnapshot(currentCapability, nonce),
          onConflict: vi.fn(),
        }),
      { initialProps: { nonce: 1 } },
    );

    await flushBridgeMicrotasks();
    expect(registerSnapshot).toHaveBeenNthCalledWith(1, undefined, 1);

    rerender({ nonce: 2 });
    await act(async () => {
      vi.advanceTimersByTime(EDITOR_SNAPSHOT_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(registerSnapshot).toHaveBeenLastCalledWith(capability, 2);

    const source = createSourceSpy.mock.results[0]?.value as FakeEventSource | undefined;
    expect(source).toBeDefined();
    source?.emit("editor-agent:action", {
      schemaVersion: "1",
      eventId: "event-capability",
      type: "action",
      action: {
        schemaVersion: "1",
        actionId: "action-capability",
        idempotencyKey: "key-capability",
        sessionId: "session-capability",
        type: "format",
        target: { file: "src/a.ts", paneId: "pane-1" },
      },
    });
    expect(postResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeDecisionCapability: capability }),
    );
  });
});

describe("useEditorAgentBridge — authenticated bootstrap", () => {
  it("does nothing while disabled, including snapshot registration", async () => {
    vi.useFakeTimers();
    const registerSnapshot = registeredSnapshot(capability("F"));
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "disabled",
        controllers: makeControllers(),
        enabled: false,
        registerSnapshot,
        onConflict: vi.fn(),
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(EDITOR_SNAPSHOT_DEBOUNCE_MS * 2);
      await Promise.resolve();
    });
    expect(registerSnapshot).not.toHaveBeenCalled();
    expect(createSourceSpy).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("waits for the initial capability before opening the session stream", async () => {
    let resolveRegistration:
      | ((value: { readonly snapshot: null; readonly bridgeDecisionCapability: string }) => void)
      | undefined;
    const registration = new Promise<{
      readonly snapshot: null;
      readonly bridgeDecisionCapability: string;
    }>((resolve) => {
      resolveRegistration = resolve;
    });
    const registerSnapshot = vi.fn(() => registration);
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "deferred",
        controllers: makeControllers(),
        registerSnapshot,
        onConflict: vi.fn(),
      }),
    );

    await flushBridgeMicrotasks();
    expect(registerSnapshot).toHaveBeenCalledWith(undefined);
    expect(createSourceSpy).not.toHaveBeenCalled();
    resolveRegistration?.({ snapshot: null, bridgeDecisionCapability: capability("G") });
    await flushBridgeMicrotasks();
    expect(createSourceSpy).toHaveBeenCalledTimes(1);
    expect(createSourceSpy.mock.calls[0]?.[0]).toContain(
      `bridgeDecisionCapability=${capability("G")}`,
    );
    hook.unmount();
  });

  it("keeps an unready subscriber out of the URL without blocking a ready session", async () => {
    const unready = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "unready",
        controllers: makeControllers(),
        registerSnapshot: vi.fn().mockResolvedValue({ snapshot: null }),
        onConflict: vi.fn(),
      }),
    );
    const ready = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "ready",
        controllers: makeControllers(),
        registerSnapshot: registeredSnapshot(capability("I")),
        onConflict: vi.fn(),
      }),
    );

    await flushBridgeMicrotasks();
    expect(createSourceSpy).toHaveBeenCalledTimes(1);
    const url = createSourceSpy.mock.calls[0]?.[0] as string;
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.getAll("sessionId")).toEqual(["ready"]);
    expect(params.getAll("bridgeDecisionCapability")).toEqual([capability("I")]);
    expect(url).not.toContain("unready");
    unready.unmount();
    ready.unmount();
  });

  it("opens SSE after a debounced retry recovers from initial registration failure", async () => {
    vi.useFakeTimers();
    const registerSnapshot = vi
      .fn()
      // Runtime intentionally converts a failed POST into `void` after resetting its dedupe key.
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ snapshot: null, bridgeDecisionCapability: capability("J") });
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "retry",
        controllers: makeControllers(),
        registerSnapshot,
        onConflict: vi.fn(),
      }),
    );

    await flushBridgeMicrotasks();
    expect(registerSnapshot).toHaveBeenCalledTimes(1);
    expect(createSourceSpy).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(EDITOR_SNAPSHOT_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(registerSnapshot).toHaveBeenCalledTimes(2);
    expect(createSourceSpy).toHaveBeenCalledTimes(1);
    expect(createSourceSpy.mock.calls[0]?.[0]).toContain("sessionId=retry");
    hook.unmount();
  });

  it("forwards only validated terminal results for the exact session", async () => {
    const onTerminalResult = vi.fn();
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "terminal",
        controllers: makeControllers(),
        registerSnapshot: registeredSnapshot(capability("H")),
        onConflict: vi.fn(),
        onTerminalResult,
      }),
    );
    await flushBridgeMicrotasks();
    const source = createSourceSpy.mock.results[0]?.value as FakeEventSource | undefined;
    if (source === undefined) throw new Error("expected authenticated event source");
    const result = {
      schemaVersion: "1" as const,
      actionId: "review-1",
      sessionId: "terminal",
      status: "failed" as const,
      failure: { code: "TIMED_OUT" as const, message: "Review timed out." },
    };

    source.emit("editor-agent:result", {
      schemaVersion: "1",
      eventId: "terminal-1",
      type: "result",
      result,
    });
    source.emit("editor-agent:result", {
      schemaVersion: "1",
      eventId: "terminal-queued",
      type: "result",
      result: { ...result, status: "queued", failure: undefined },
    });
    source.emit("editor-agent:result", {
      schemaVersion: "1",
      eventId: "terminal-oversized",
      type: "result",
      result: { ...result, message: "x".repeat(1_025) },
    });

    expect(onTerminalResult).toHaveBeenCalledTimes(1);
    expect(onTerminalResult).toHaveBeenCalledWith(result);
    hook.unmount();
  });
});

// ─── GEN-PERF-EDITOR-008 — SSE connection reuse ────────────────────────────────

describe("useEditorAgentBridge — SSE reuse (GEN-PERF-EDITOR-008)", () => {
  it("opens exactly one EventSource across a burst of same-tick subscribes", async () => {
    const registrations = {
      s1: registeredSnapshot(capability("B")),
      s2: registeredSnapshot(capability("C")),
      s3: registeredSnapshot(capability("D")),
    };
    const hooks = [
      renderHook(() =>
        useEditorAgentBridge({
          agentSessionId: "s1",
          controllers: makeControllers(),
          registerSnapshot: registrations.s1,
          onConflict: vi.fn(),
        }),
      ),
      renderHook(() =>
        useEditorAgentBridge({
          agentSessionId: "s2",
          controllers: makeControllers(),
          registerSnapshot: registrations.s2,
          onConflict: vi.fn(),
        }),
      ),
      renderHook(() =>
        useEditorAgentBridge({
          agentSessionId: "s3",
          controllers: makeControllers(),
          registerSnapshot: registrations.s3,
          onConflict: vi.fn(),
        }),
      ),
    ];

    // Flush the microtask-debounced reconcile.
    await flushBridgeMicrotasks();

    expect(createSourceSpy).toHaveBeenCalledTimes(1);
    // The single stream carries all three session ids.
    const url = createSourceSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("sessionId=s1");
    expect(url).toContain("sessionId=s2");
    expect(url).toContain("sessionId=s3");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.getAll("sessionId")).toEqual(["s1", "s2", "s3"]);
    expect(params.getAll("bridgeDecisionCapability")).toEqual([
      capability("B"),
      capability("C"),
      capability("D"),
    ]);

    for (const h of hooks) h.unmount();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("does not reopen the stream when a duplicate handler for an already-subscribed session unsubscribes", async () => {
    const registerSnapshot = registeredSnapshot(capability("E"));
    const first = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "dup",
        controllers: makeControllers(),
        registerSnapshot,
        onConflict: vi.fn(),
      }),
    );
    const second = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "dup",
        controllers: makeControllers(),
        registerSnapshot,
        onConflict: vi.fn(),
      }),
    );
    await flushBridgeMicrotasks();
    // Same session id set => a single connection.
    expect(createSourceSpy).toHaveBeenCalledTimes(1);

    // Unsubscribe one of the two handlers for the same session: the effective set is
    // unchanged, so no additional EventSource is constructed.
    second.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(createSourceSpy).toHaveBeenCalledTimes(1);

    first.unmount();
    await act(async () => {
      await Promise.resolve();
    });
  });
});

describe("useEditorAgentBridge — observed activity state (Issue #2120)", () => {
  it("becomes recently attached from a frame and deterministically expires the recency window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T08:00:00.000Z"));
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "activity",
        controllers: makeControllers(),
        registerSnapshot: registeredSnapshot(capability("K")),
        onConflict: vi.fn(),
      }),
    );
    await flushBridgeMicrotasks();

    expect(hook.result.current.bridgeState).toEqual({
      lastActivityAt: null,
      recentlyAttached: false,
      inFlightActionIds: [],
      inFlightActionCount: 0,
    });
    act(() => {
      emitAction(latestEventSource(), "activity", "action-1");
    });
    expect(hook.result.current.bridgeState).toEqual({
      lastActivityAt: Date.now(),
      recentlyAttached: true,
      inFlightActionIds: ["action-1"],
      inFlightActionCount: 1,
    });

    act(() => {
      vi.advanceTimersByTime(EDITOR_AGENT_ACTIVITY_RECENCY_MS - 1);
    });
    expect(hook.result.current.bridgeState.recentlyAttached).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current.bridgeState).toEqual({
      lastActivityAt: new Date("2026-07-10T08:00:00.000Z").getTime(),
      recentlyAttached: false,
      inFlightActionIds: ["action-1"],
      inFlightActionCount: 1,
    });
    hook.unmount();
  });

  it("keeps queued actions in flight and settles them only on terminal results", async () => {
    vi.useFakeTimers();
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "settlement",
        controllers: makeControllers(),
        registerSnapshot: registeredSnapshot(capability("L")),
        onConflict: vi.fn(),
      }),
    );
    await flushBridgeMicrotasks();
    const source = latestEventSource();

    act(() => {
      emitAction(source, "settlement", "action-1");
      emitAction(source, "settlement", "action-2");
      emitResult(source, "settlement", "action-1", "queued");
    });
    expect(hook.result.current.bridgeState.inFlightActionIds).toEqual(["action-1", "action-2"]);
    expect(hook.result.current.bridgeState.inFlightActionCount).toBe(2);

    act(() => {
      emitResult(source, "settlement", "action-1", "succeeded");
    });
    expect(hook.result.current.bridgeState.inFlightActionIds).toEqual(["action-2"]);
    expect(hook.result.current.bridgeState.inFlightActionCount).toBe(1);
    hook.unmount();
  });

  it("bounds retained in-flight action identifiers and evicts the oldest first", async () => {
    vi.useFakeTimers();
    const hook = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "bounded",
        controllers: makeControllers(),
        registerSnapshot: registeredSnapshot(capability("M")),
        onConflict: vi.fn(),
      }),
    );
    await flushBridgeMicrotasks();
    const source = latestEventSource();

    act(() => {
      for (let index = 0; index <= MAX_EDITOR_AGENT_IN_FLIGHT_ACTIONS; index += 1) {
        emitAction(source, "bounded", `action-${String(index)}`);
      }
    });
    expect(hook.result.current.bridgeState.inFlightActionCount).toBe(
      MAX_EDITOR_AGENT_IN_FLIGHT_ACTIONS,
    );
    expect(hook.result.current.bridgeState.inFlightActionIds[0]).toBe("action-1");
    expect(hook.result.current.bridgeState.inFlightActionIds.at(-1)).toBe(
      `action-${String(MAX_EDITOR_AGENT_IN_FLIGHT_ACTIONS)}`,
    );
    hook.unmount();
  });

  it("resets across session and enabled changes without an old timer expiring new activity", async () => {
    vi.useFakeTimers();
    const hook = renderHook(
      ({ enabled, sessionId }: { enabled: boolean; sessionId: string }) =>
        useEditorAgentBridge({
          agentSessionId: sessionId,
          controllers: makeControllers(),
          enabled,
          registerSnapshot: registeredSnapshot(capability("N")),
          onConflict: vi.fn(),
        }),
      { initialProps: { enabled: true, sessionId: "first" } },
    );
    await flushBridgeMicrotasks();
    act(() => {
      emitAction(latestEventSource(), "first", "first-action");
      vi.advanceTimersByTime(EDITOR_AGENT_ACTIVITY_RECENCY_MS / 2);
    });

    hook.rerender({ enabled: true, sessionId: "second" });
    expect(hook.result.current.bridgeState).toEqual({
      lastActivityAt: null,
      recentlyAttached: false,
      inFlightActionIds: [],
      inFlightActionCount: 0,
    });
    await flushBridgeMicrotasks();
    act(() => {
      emitAction(latestEventSource(), "second", "second-action");
      vi.advanceTimersByTime(EDITOR_AGENT_ACTIVITY_RECENCY_MS / 2);
    });
    expect(hook.result.current.bridgeState.recentlyAttached).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    hook.rerender({ enabled: false, sessionId: "second" });
    expect(hook.result.current.bridgeState).toEqual({
      lastActivityAt: null,
      recentlyAttached: false,
      inFlightActionIds: [],
      inFlightActionCount: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    hook.unmount();
  });
});
