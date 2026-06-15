import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSSE } from "./useSSE";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
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

  emit(type: string, data: string): void {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
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
  });

  it("opens encoded run streams, recovers after transient errors, ignores malformed frames, and closes on terminal events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = renderHook(({ runId }: { runId: string | null }) => useSSE(runId), {
      initialProps: { runId: "run 1" },
    });
    const source = FakeEventSource.instances[0];

    expect(source?.url).toBe("/api/runs/run%201/events");

    act(() => {
      source?.onopen?.(new Event("open"));
    });
    await waitFor(() => expect(view.result.current.status).toBe("live"));

    act(() => {
      source?.emit("run:started", event(4, "run:started"));
      source?.emit("run:started", "not-json");
    });
    await waitFor(() => expect(view.result.current.events).toHaveLength(1));
    expect(view.result.current.events[0]?.seq).toBe(4);

    act(() => {
      source?.onerror?.(new Event("error"));
    });
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    expect(view.result.current.error).toContain("Attempting to reconnect");

    act(() => {
      source?.onopen?.(new Event("open"));
    });
    await waitFor(() => expect(view.result.current.error).toBeNull());

    act(() => {
      source?.emit("workflow:completed", event(5, "workflow:completed"));
    });
    await waitFor(() => expect(view.result.current.status).toBe("terminal"));
    expect(source?.close).toHaveBeenCalled();

    view.rerender({ runId: "run 2" });
    expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/run%202/events");
    expect(view.result.current.events).toEqual([]);

    view.unmount();
    expect(FakeEventSource.instances[1]?.close).toHaveBeenCalled();
  });

  it("does not open an EventSource when no run id is selected", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    renderHook(() => useSSE(null));

    expect(FakeEventSource.instances).toEqual([]);
  });
});
