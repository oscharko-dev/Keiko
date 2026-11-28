import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOriginLocksFixture } from "../test-utils/origin-locks-fixture";

// #4573: finite requests (a status read, a snapshot) need a free HTTP/1.1 connection. A browser
// allows six per origin, so at most four long-lived streams may be open at once across every
// document of the origin. This suite drives only the public consumers (`useSSE`, the shared event
// source pool) in two simulated documents that share one origin-wide Web Locks manager, and counts
// the EventSources that are open at the same time. It uses no capacity API, so the same file runs
// against the sources before and after the fix.

vi.mock("./coding-app-session-client", () => ({
  repairLocalCodingAppSessionForStream: vi.fn(() =>
    Promise.resolve({ acknowledged: false, repairCorrelationId: "ui_repair-0000" }),
  ),
  reportStreamSessionRecovered: vi.fn(),
}));

const ORIGIN_CEILING = 4;

class CountingEventSource {
  static open = 0;
  static peak = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 1;
  private closed = false;
  constructor(readonly url: string) {
    CountingEventSource.open += 1;
    CountingEventSource.peak = Math.max(CountingEventSource.peak, CountingEventSource.open);
  }
  addEventListener(): void {
    // No frames are delivered; the suite only counts connections.
  }
  removeEventListener(): void {
    // See addEventListener.
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    CountingEventSource.open -= 1;
  }
}

interface StartedDocument {
  readonly stop: () => void;
}

// A second document has its own module state and its own React copy, but the origin's lock manager
// is shared, exactly as two tabs of one origin share it.
async function startDocument(runId: string): Promise<StartedDocument> {
  vi.resetModules();
  const { renderHook, act } = await import("@testing-library/react");
  const { useSSE } = await import("./useSSE");
  const { subscribeSharedEventSource } =
    await import("../app/components/desktop/widgets/cards/sharedEventSource");
  const view = renderHook(() => useSSE(runId));
  const pool = Array.from({ length: 3 }, (_, index) =>
    subscribeSharedEventSource(
      `/api/editor/watch/events?root=${runId}-${String(index)}`,
      ["change"],
      vi.fn(),
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return {
    stop: (): void => {
      pool.forEach((release) => release());
      view.unmount();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  CountingEventSource.open = 0;
  CountingEventSource.peak = 0;
  vi.stubGlobal("EventSource", CountingEventSource);
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: createOriginLocksFixture(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("origin-wide long-lived stream ceiling", () => {
  it("keeps at most four streams open across two documents so a finite request has a connection", async () => {
    const first = await startDocument("run-a");
    const second = await startDocument("run-b");
    for (let step = 0; step < 12; step += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(CountingEventSource.open).toBeLessThanOrEqual(ORIGIN_CEILING);
    }
    expect(CountingEventSource.peak).toBeGreaterThan(0);
    expect(CountingEventSource.peak).toBeLessThanOrEqual(ORIGIN_CEILING);
    first.stop();
    second.stop();
  });
});
