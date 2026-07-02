import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSSE } from "./useSSE";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly close = vi.fn();
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
  });

  it("opens encoded run streams, recovers after transient errors, ignores malformed frames, and closes on terminal events", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
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
      vi.advanceTimersByTime(1000);
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
});
