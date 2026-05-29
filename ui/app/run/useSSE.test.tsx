/**
 * Tests for useSSE (ui/lib/useSSE.ts).
 *
 * Covers:
 *   FIX C — workflow:started + workflow:completed + bug:completed events are
 *            received and accumulated (not silently dropped).
 *   FIX D — changing runId resets accumulated events and prior cursor.
 *   FIX E — workflow:completed and bug:completed drive terminal status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSSE } from "@/lib/useSSE";
import type { HarnessEvent } from "@/lib/types";

// ---------------------------------------------------------------------------
// Minimal EventSource mock
// ---------------------------------------------------------------------------

type Handler = (ev: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private handlers: Map<string, Handler[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const fn = typeof handler === "function" ? handler : handler.handleEvent.bind(handler);
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(fn as Handler);
  }

  removeEventListener(): void {
    // not needed for tests
  }

  close(): void {
    // mark closed — no-op for tests
  }

  /** Simulate the server emitting a named SSE event. */
  emit(type: string, data: HarnessEvent): void {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    const fns = this.handlers.get(type) ?? [];
    for (const fn of fns) fn(ev);
  }

  /** Simulate the server opening the connection. */
  open(): void {
    this.onopen?.();
  }
}

// ---------------------------------------------------------------------------
// Helper — build a minimal BaseEvent shell
// ---------------------------------------------------------------------------

function base(seq: number, runId = "run-test"): { schemaVersion: "1"; runId: string; fingerprint: string; seq: number; ts: string } {
  return { schemaVersion: "1", runId, fingerprint: "fp", seq, ts: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// FIX C — named workflow/bug events are received (not dropped)
// ---------------------------------------------------------------------------

describe("FIX C — all SSE event types are received", () => {
  it("receives workflow:started event", async () => {
    const { result } = renderHook(() => useSSE("run-wf-1"));

    await waitFor(() => MockEventSource.instances.length > 0);
    const es = MockEventSource.instances[0]!;
    act(() => { es.open(); });

    const event: HarnessEvent = {
      ...base(0, "run-wf-1"),
      type: "workflow:started",
      workflowId: "unit-test-generation",
      modelId: "claude-3-5-sonnet",
      applyEnabled: false,
      limits: { maxContextBytes: 512000 },
    };

    act(() => { es.emit("workflow:started", event); });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]!.type).toBe("workflow:started");
    });
  });

  it("receives workflow:completed event and sets terminal status (FIX E)", async () => {
    const { result } = renderHook(() => useSSE("run-wf-2"));

    await waitFor(() => MockEventSource.instances.length > 0);
    const es = MockEventSource.instances[0]!;
    act(() => { es.open(); });

    const startEvent: HarnessEvent = {
      ...base(0, "run-wf-2"),
      type: "workflow:started",
      workflowId: "unit-test-generation",
      modelId: "claude-3-5-sonnet",
      applyEnabled: false,
      limits: {},
    };
    const doneEvent: HarnessEvent = {
      ...base(1, "run-wf-2"),
      type: "workflow:completed",
      status: "completed",
      durationMs: 12000,
    };

    act(() => {
      es.emit("workflow:started", startEvent);
      es.emit("workflow:completed", doneEvent);
    });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[1]!.type).toBe("workflow:completed");
      // FIX E: terminal status must be set for workflow runs
      expect(result.current.status).toBe("terminal");
    });
  });

  it("receives bug:completed event and sets terminal status (FIX E)", async () => {
    const { result } = renderHook(() => useSSE("run-bug-1"));

    await waitFor(() => MockEventSource.instances.length > 0);
    const es = MockEventSource.instances[0]!;
    act(() => { es.open(); });

    const startEvent: HarnessEvent = {
      ...base(0, "run-bug-1"),
      type: "bug:started",
      workflowId: "bug-investigation",
      modelId: "claude-3-5-sonnet",
      applyEnabled: false,
      limits: {},
    };
    const doneEvent: HarnessEvent = {
      ...base(1, "run-bug-1"),
      type: "bug:completed",
      status: "investigation-only",
      durationMs: 8000,
    };

    act(() => {
      es.emit("bug:started", startEvent);
      es.emit("bug:completed", doneEvent);
    });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[1]!.type).toBe("bug:completed");
      // FIX E: terminal status must be set for bug runs
      expect(result.current.status).toBe("terminal");
    });
  });

  it("receives workflow:failed event and sets terminal status (FIX E)", async () => {
    const { result } = renderHook(() => useSSE("run-wf-fail"));

    await waitFor(() => MockEventSource.instances.length > 0);
    const es = MockEventSource.instances[0]!;
    act(() => { es.open(); });

    const failEvent: HarnessEvent = {
      ...base(0, "run-wf-fail"),
      type: "workflow:failed",
      errorCode: "CONTEXT_TOO_LARGE",
      message: "[redacted]",
    };

    act(() => { es.emit("workflow:failed", failEvent); });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
      expect(result.current.status).toBe("terminal");
    });
  });

  it("receives bug:failed event and sets terminal status (FIX E)", async () => {
    const { result } = renderHook(() => useSSE("run-bug-fail"));

    await waitFor(() => MockEventSource.instances.length > 0);
    const es = MockEventSource.instances[0]!;
    act(() => { es.open(); });

    const failEvent: HarnessEvent = {
      ...base(0, "run-bug-fail"),
      type: "bug:failed",
      errorCode: "MODEL_ERROR",
      message: "[redacted]",
    };

    act(() => { es.emit("bug:failed", failEvent); });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
      expect(result.current.status).toBe("terminal");
    });
  });
});

// ---------------------------------------------------------------------------
// FIX D — changing runId resets events, status, and cursor
// ---------------------------------------------------------------------------

describe("FIX D — runId change clears prior state", () => {
  it("resets events when runId changes", async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSSE(id), {
      initialProps: { id: "run-first" },
    });

    await waitFor(() => MockEventSource.instances.length > 0);
    const es1 = MockEventSource.instances[0]!;
    act(() => { es1.open(); });

    // Emit one event into run-first
    act(() => {
      es1.emit("run:started", {
        ...base(0, "run-first"),
        type: "run:started",
        taskType: "explain-plan",
        modelId: "claude-3-5-sonnet",
        limits: {},
      });
    });

    await waitFor(() => expect(result.current.events).toHaveLength(1));

    // Navigate to a different run
    rerender({ id: "run-second" });

    // FIX D: events must be cleared immediately after runId changes
    await waitFor(() => {
      expect(result.current.events).toHaveLength(0);
      expect(result.current.status).toBe("connecting");
    });
  });

  it("does not mix events between runs after runId change", async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSSE(id), {
      initialProps: { id: "run-a" },
    });

    await waitFor(() => MockEventSource.instances.length >= 1);
    const es1 = MockEventSource.instances[0]!;
    act(() => { es1.open(); });

    act(() => {
      es1.emit("run:started", {
        ...base(0, "run-a"),
        type: "run:started",
        taskType: "explain-plan",
        modelId: "claude-3-5-sonnet",
        limits: {},
      });
    });

    await waitFor(() => expect(result.current.events).toHaveLength(1));

    // Switch to run-b
    rerender({ id: "run-b" });

    await waitFor(() => MockEventSource.instances.length >= 2);
    const es2 = MockEventSource.instances[1]!;
    act(() => { es2.open(); });

    act(() => {
      es2.emit("workflow:started", {
        ...base(0, "run-b"),
        type: "workflow:started",
        workflowId: "unit-test-generation",
        modelId: "claude-3-5-sonnet",
        applyEnabled: false,
        limits: {},
      });
    });

    await waitFor(() => {
      // Only the run-b event should appear — no leftover run-a events
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]!.type).toBe("workflow:started");
    });
  });
});
