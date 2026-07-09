/**
 * Hook-level tests for useEditorAgentBridge (GEN-PERF-EDITOR-002 + GEN-PERF-EDITOR-008).
 *
 * Mocks createSameOriginApiEventSource so we can count how many EventSources are opened as
 * panes subscribe/unsubscribe, and uses fake timers to prove the snapshot-register POST is
 * debounced across a cursor/selection burst.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_SNAPSHOT_DEBOUNCE_MS,
  useEditorAgentBridge,
  type EditorAgentActionControllers,
} from "./editorAgentBridge";

const createSourceSpy = vi.fn();

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
}

function makeControllers(): EditorAgentActionControllers {
  return {
    paneId: "pane-1",
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
  createSourceSpy.mockReset();
  createSourceSpy.mockImplementation((url: string) => new FakeEventSource(url));
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

// ─── GEN-PERF-EDITOR-002 — snapshot POST debounce ──────────────────────────────

describe("useEditorAgentBridge — snapshot debounce (GEN-PERF-EDITOR-002)", () => {
  it("collapses a burst of registerSnapshot identity changes into a bounded number of calls", () => {
    vi.useFakeTimers();
    const registerSnapshot = vi.fn();
    const { rerender } = renderHook(
      ({ rs }: { rs: () => void }) =>
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
    act(() => {
      vi.advanceTimersByTime(EDITOR_SNAPSHOT_DEBOUNCE_MS);
    });
    // At most the trailing edge fires — far fewer than 30.
    expect(registerSnapshot.mock.calls.length).toBeLessThanOrEqual(2);
    expect(registerSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── GEN-PERF-EDITOR-008 — SSE connection reuse ────────────────────────────────

describe("useEditorAgentBridge — SSE reuse (GEN-PERF-EDITOR-008)", () => {
  it("opens exactly one EventSource across a burst of same-tick subscribes", async () => {
    const hooks = [
      renderHook(() =>
        useEditorAgentBridge({
          agentSessionId: "s1",
          controllers: makeControllers(),
          registerSnapshot: vi.fn(),
          onConflict: vi.fn(),
        }),
      ),
      renderHook(() =>
        useEditorAgentBridge({
          agentSessionId: "s2",
          controllers: makeControllers(),
          registerSnapshot: vi.fn(),
          onConflict: vi.fn(),
        }),
      ),
      renderHook(() =>
        useEditorAgentBridge({
          agentSessionId: "s3",
          controllers: makeControllers(),
          registerSnapshot: vi.fn(),
          onConflict: vi.fn(),
        }),
      ),
    ];

    // Flush the microtask-debounced reconcile.
    await act(async () => {
      await Promise.resolve();
    });

    expect(createSourceSpy).toHaveBeenCalledTimes(1);
    // The single stream carries all three session ids.
    const url = createSourceSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("sessionId=s1");
    expect(url).toContain("sessionId=s2");
    expect(url).toContain("sessionId=s3");

    for (const h of hooks) h.unmount();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("does not reopen the stream when a duplicate handler for an already-subscribed session unsubscribes", async () => {
    const first = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "dup",
        controllers: makeControllers(),
        registerSnapshot: vi.fn(),
        onConflict: vi.fn(),
      }),
    );
    const second = renderHook(() =>
      useEditorAgentBridge({
        agentSessionId: "dup",
        controllers: makeControllers(),
        registerSnapshot: vi.fn(),
        onConflict: vi.fn(),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
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
