import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import { useSSE } from "./useSSE";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly close = vi.fn();
  // Real EventSource is CLOSED (2) by the time `onerror` typically fires for a fatal failure;
  // tests that care about a different observed state override this before triggering onerror.
  readyState = 2;
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.length;
    return count;
  }

  emit(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  dispatch(type: string, data = "{}"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener({ data } as MessageEvent);
      } else {
        listener.handleEvent({ data } as MessageEvent);
      }
    }
  }
}

function event(seq: number, type: string): string {
  return JSON.stringify({
    schemaVersion: "1",
    runId: "run 1",
    fingerprint: "fp-1",
    seq,
    ts: seq,
    type,
  });
}

describe("useSSE", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetClientDiagnosticWriter();
  });

  it("opens encoded run streams, recovers after transient errors, ignores malformed frames, and closes on terminal events", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = renderHook(({ runId }: { runId: string | null }) => useSSE(runId), {
      initialProps: { runId: "run 1" },
    });
    const source = FakeEventSource.instances[0];

    expect(source?.url).toBe("/api/runs/events");
    expect(source?.listenerCount()).toBe(1);

    act(() => {
      source?.onopen?.(new Event("open"));
    });
    expect(view.result.current.status).toBe("live");

    act(() => {
      source?.emit(event(4, "run:started"));
      source?.emit("not-json");
    });
    expect(view.result.current.events).toHaveLength(1);
    expect(view.result.current.events[0]?.seq).toBe(4);

    act(() => {
      source?.onerror?.(new Event("error"));
    });
    expect(view.result.current.status).toBe("error");
    expect(view.result.current.error).toContain("Attempting to reconnect");

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(501);
    });
    const reconnected = FakeEventSource.instances[1];
    act(() => {
      reconnected?.onopen?.(new Event("open"));
    });
    expect(view.result.current.error).toBeNull();

    act(() => {
      reconnected?.emit(event(5, "workflow:completed"));
    });
    expect(view.result.current.status).toBe("terminal");
    expect(reconnected?.close).not.toHaveBeenCalled();

    view.rerender({ runId: "run 2" });
    expect(reconnected?.close).toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(view.result.current.events).toEqual([]);

    view.unmount();
    expect(FakeEventSource.instances[2]?.close).toHaveBeenCalled();
  });

  it("shares one EventSource across run subscribers and filters events by run id", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const first = renderHook(() => useSSE("run 1"));
    const second = renderHook(() => useSSE("run 2"));
    const source = FakeEventSource.instances[0];

    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => {
      source?.dispatch("ready");
      source?.emit(event(1, "run:started"));
      source?.emit(
        JSON.stringify({
          schemaVersion: "1",
          runId: "run 2",
          fingerprint: "fp-2",
          seq: 1,
          ts: 1,
          type: "run:started",
        }),
      );
    });

    await waitFor(() => expect(first.result.current.events).toHaveLength(1));
    await waitFor(() => expect(second.result.current.events).toHaveLength(1));
    expect(first.result.current.events[0]?.runId).toBe("run 1");
    expect(second.result.current.events[0]?.runId).toBe("run 2");

    first.unmount();
    expect(source?.close).not.toHaveBeenCalled();
    second.unmount();
    expect(source?.close).toHaveBeenCalled();
  });

  it("does not open an EventSource when no run id is selected", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    renderHook(() => useSSE(null));

    expect(FakeEventSource.instances).toEqual([]);
  });

  // GEN-PERF-SSE-001 — an event burst must not cost one React commit per event. The
  // frame scheduler is controlled explicitly so coverage/runtime slowness cannot let
  // requestAnimationFrame fire halfway through the synthetic burst and turn one logical
  // frame into several frame windows.
  it("coalesces an event burst into a leading commit plus one frame flush", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let queuedFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
      queuedFrame = callback;
      return 1;
    });
    const cancelFrame = vi.fn((handle: number): void => {
      if (handle === 1) queuedFrame = undefined;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const renders = { count: 0 };
    const view = renderHook(() => {
      renders.count += 1;
      return useSSE("run 1");
    });
    const source = FakeEventSource.instances[0];
    act(() => {
      source?.onopen?.(new Event("open"));
    });
    const before = renders.count;
    for (let seq = 1; seq <= 30; seq++) {
      // eslint-disable-next-line no-await-in-loop -- each event must be its own task to model real SSE delivery
      await act(async () => {
        source?.emit(event(seq, "run:started"));
        await Promise.resolve();
      });
    }
    await waitFor(() => expect(view.result.current.events).toHaveLength(1));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(renders.count - before).toBeLessThanOrEqual(3);
    const flushFrame = queuedFrame;
    expect(flushFrame).toBeDefined();
    act(() => {
      flushFrame?.(16);
    });
    await waitFor(() => expect(view.result.current.events).toHaveLength(30));
    expect(renders.count - before).toBeLessThanOrEqual(5);
    view.unmount();
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it("caps retained events so long-running streams do not grow unbounded", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = renderHook(() => useSSE("run 1"));
    const source = FakeEventSource.instances[0];

    act(() => {
      for (let seq = 0; seq < 520; seq += 1) {
        source?.emit(event(seq, "run:started"));
      }
    });

    await waitFor(() => expect(view.result.current.events).toHaveLength(500));
    expect(view.result.current.events[0]?.seq).toBe(20);
    expect(view.result.current.events[499]?.seq).toBe(519);
  });

  // User finding #2456 — the wake-up replay burst. Reopening the shared stream after a
  // hidden→visible cycle names the runs still subscribed (with the last seq observed for each) in
  // a `resume` query parameter, so the server replays only what the client has not seen instead of
  // every run's entire ring buffer. RunIds are percent-encoded ("run 1" → "run%201") so a reserved
  // character can never corrupt the comma/colon pair framing.
  describe("resume cursors (user finding #2456)", () => {
    function eventFor(runId: string, seq: number): string {
      return JSON.stringify({
        schemaVersion: "1",
        runId,
        fingerprint: `fp-${runId}`,
        seq,
        ts: seq,
        type: "run:started",
      });
    }

    function setVisibility(state: DocumentVisibilityState): void {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: (): DocumentVisibilityState => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }

    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    it("opens the first connection with no resume parameter", () => {
      vi.stubGlobal("EventSource", FakeEventSource);

      const view = renderHook(() => useSSE("run 1"));

      expect(FakeEventSource.instances[0]?.url).toBe("/api/runs/events");
      view.unmount();
    });

    it("reopens after a hidden→visible cycle with cursors for the subscribed runs", () => {
      vi.stubGlobal("EventSource", FakeEventSource);
      const first = renderHook(() => useSSE("run 1"));
      const second = renderHook(() => useSSE("run 2"));
      const source = FakeEventSource.instances[0];
      act(() => {
        source?.emit(eventFor("run 1", 4));
        source?.emit(eventFor("run 2", 7));
      });

      act(() => {
        setVisibility("hidden");
      });
      expect(source?.close).toHaveBeenCalled();
      act(() => {
        setVisibility("visible");
      });

      expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/events?resume=run%201:4,run%202:7");
      first.unmount();
      second.unmount();
    });

    it("resumes at full replay when a second subscriber joins an already-live run behind the first", () => {
      // Two hooks subscribed to the SAME run: A has been receiving events (cursor 4). B mounts
      // while the shared stream is already open, so subscribeRunEvents does not reopen it and B
      // starts with no cursor of its own (open guards on `sharedEventSource !== null`, so no
      // second EventSource is created either). The next reopen must resume "run 1" from B's
      // missing history (full replay), never from A's higher cursor — resuming past B's minimum
      // would permanently withhold events B still needs, including a terminal event, leaving B's
      // hook stuck below "terminal" forever.
      vi.stubGlobal("EventSource", FakeEventSource);
      const subscriberA = renderHook(() => useSSE("run 1"));
      const source = FakeEventSource.instances[0];
      act(() => {
        source?.emit(eventFor("run 1", 4));
      });
      expect(FakeEventSource.instances).toHaveLength(1);

      const subscriberB = renderHook(() => useSSE("run 1"));
      // B joined the already-live shared stream — no second EventSource was opened for it.
      expect(FakeEventSource.instances).toHaveLength(1);

      act(() => {
        setVisibility("hidden");
      });
      act(() => {
        setVisibility("visible");
      });

      expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/events?resume=run%201:*");
      subscriberA.unmount();
      subscriberB.unmount();
    });

    it("names a subscribed run with no observed event for full replay, never live-only", () => {
      // Under-delivery guard: a run subscribed but not yet seen (subscribed while hidden, or
      // during a reconnect gap) has no cursor. Leaving it OUT of the parameter would make the
      // server attach it live-only and its buffered history would be lost for good — the exact
      // opposite of the burst this fix removes. It must be named with the full-replay marker.
      vi.stubGlobal("EventSource", FakeEventSource);
      const first = renderHook(() => useSSE("run 1"));
      const source = FakeEventSource.instances[0];
      act(() => {
        source?.emit(eventFor("run 1", 4));
      });
      const second = renderHook(() => useSSE("run 2"));

      act(() => {
        setVisibility("hidden");
      });
      act(() => {
        setVisibility("visible");
      });

      expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/events?resume=run%201:4,run%202:*");
      first.unmount();
      second.unmount();
    });

    it("drops a run's cursor from the reopen URL once its last subscriber unsubscribed", () => {
      vi.stubGlobal("EventSource", FakeEventSource);
      const first = renderHook(() => useSSE("run 1"));
      const second = renderHook(() => useSSE("run 2"));
      const source = FakeEventSource.instances[0];
      act(() => {
        source?.emit(eventFor("run 1", 4));
        source?.emit(eventFor("run 2", 7));
      });
      second.unmount();

      act(() => {
        setVisibility("hidden");
      });
      act(() => {
        setVisibility("visible");
      });

      expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/events?resume=run%201:4");
      first.unmount();
    });

    it("never regresses the resume cursor when a later event arrives with a lower seq", () => {
      // The buffered ring can replay/interleave during a reconnect, so notifyRun tracks the
      // MAX seq observed, not simply the last one delivered. A naive "always overwrite" would
      // shrink the cursor back down and cause the next reopen to re-replay events the client
      // already rendered — the exact burst #2456 exists to remove, just re-introduced on the
      // next reconnect instead of the first.
      vi.stubGlobal("EventSource", FakeEventSource);
      const first = renderHook(() => useSSE("run 1"));
      const source = FakeEventSource.instances[0];
      act(() => {
        source?.emit(eventFor("run 1", 9));
        source?.emit(eventFor("run 1", 3));
      });

      act(() => {
        setVisibility("hidden");
      });
      act(() => {
        setVisibility("visible");
      });

      expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/events?resume=run%201:9");
      first.unmount();
    });

    it("does not resurrect a stale cursor for a run re-subscribed after its last unsubscribe", () => {
      // "drops a run's cursor from the reopen URL" above only shows the unsubscribed run
      // disappearing from the resume parameter. Cursors are tracked per SUBSCRIBER object
      // (#3305), so a fresh re-subscription is a brand-new subscriber with no entry of its own —
      // it can never inherit a stale cursor by construction, regardless of whether the old
      // subscriber's entry was cleaned up. This proves that structural guarantee: re-subscribing
      // to the SAME runId while the shared connection stays open (a second run keeps the
      // subscriber count above zero) must resume from full replay, not the seq the FIRST,
      // now-gone subscription observed — silently skipping whatever the server buffered in
      // between would be exactly the under-delivery this fix exists to prevent.
      // subscribeRunEvents' cleanup still deletes the old subscriber's entry from
      // lastSeqBySubscriber on unmount so the map does not grow without bound; that deletion just
      // is not what this particular assertion distinguishes.
      vi.stubGlobal("EventSource", FakeEventSource);
      const keepAlive = renderHook(() => useSSE("run 2"));
      const firstSubscription = renderHook(() => useSSE("run 1"));
      const source = FakeEventSource.instances[0];
      act(() => {
        // "run 2" gets a real cursor too, so the reopen still takes the resume path
        // (runEventsUrl falls back to the plain, cursor-free URL only when NO
        // subscribed run has any known cursor at all).
        source?.emit(eventFor("run 2", 11));
        source?.emit(eventFor("run 1", 4));
      });
      firstSubscription.unmount();

      const secondSubscription = renderHook(() => useSSE("run 1"));
      // No new "run 1" event observed by this fresh subscription.

      act(() => {
        setVisibility("hidden");
      });
      act(() => {
        setVisibility("visible");
      });

      expect(FakeEventSource.instances[1]?.url).toBe(
        "/api/runs/events?resume=run%202:11,run%201:*",
      );
      keepAlive.unmount();
      secondSubscription.unmount();
    });

    it("starts a fresh, resume-free session once every subscriber has gone and a new one arrives", () => {
      // The "everObservedEvent" gate is deliberately sticky WITHIN a session so a run losing and
      // regaining its subscriber doesn't fall back to the plain (safe but noisier) URL — but once
      // the LAST subscriber anywhere unmounts, nobody is tracking anything, and that stickiness
      // must not leak into an unrelated later session that has never seen an event of its own.
      vi.stubGlobal("EventSource", FakeEventSource);
      const first = renderHook(() => useSSE("run 1"));
      const source = FakeEventSource.instances[0];
      act(() => {
        source?.emit(eventFor("run 1", 4));
      });
      first.unmount();

      const second = renderHook(() => useSSE("run 1"));

      expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/events");
      second.unmount();
    });
  });

  // Wave 5 of epic #3233 (g6): every EventSource.onerror handler reports a client diagnostic
  // carrying the observed readyState and a closed reason label.
  it("reports a client diagnostic with readyState and a reason label on stream error", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const reported: string[] = [];
    setClientDiagnosticWriter((message) => reported.push(message));
    const view = renderHook(({ runId }: { runId: string | null }) => useSSE(runId), {
      initialProps: { runId: "run 1" },
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("Expected stream.");
    source.readyState = 2;

    act(() => {
      source.onerror?.(new Event("error"));
    });

    expect(reported).toEqual([
      "[keiko] run-events sse stream error (kind=sse-error, readyState=2, reason=closed)",
    ]);
    view.unmount();
  });
});
