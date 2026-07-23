import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSharedEventSourcesForTests,
  sharedEventSourceGeneration,
  subscribeSharedEventSource,
} from "./sharedEventSource";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static immediateEventType: string | undefined;
  readonly url: string;
  readonly listeners = new Map<string, Set<EventListener>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    if (type === FakeEventSource.immediateEventType) {
      listener(new MessageEvent(type, { data: "immediate" }));
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  resetSharedEventSourcesForTests();
  FakeEventSource.instances = [];
  FakeEventSource.immediateEventType = undefined;
  vi.unstubAllGlobals();
});

describe("subscribeSharedEventSource", () => {
  it("opens same-origin API streams", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const unsubscribe = subscribeSharedEventSource(
      "/api/commands/events",
      ["command:run"],
      () => {},
    );

    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(["/api/commands/events"]);
    unsubscribe();
  });

  it("rejects off-origin stream URLs before constructing EventSource", () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const unsubscribe = subscribeSharedEventSource(
      "https://evil.example/api/commands/events",
      ["command:run"],
      () => {},
    );

    expect(FakeEventSource.instances).toHaveLength(0);
    unsubscribe();
  });

  it("delivers an event emitted while the first typed listener is registered", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.immediateEventType = "editor-debug:stopped";
    const received: string[] = [];

    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/debug/events?workspaceId=workspace-1",
      ["editor-debug:stopped"],
      (event) => received.push(event.data),
    );

    expect(received).toEqual(["immediate"]);
    unsubscribe();
  });

  it("preserves the highest event id across an owned reconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/debug/events?workspaceId=workspace-1",
      ["editor-debug:output"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    const listeners = first?.listeners.get("editor-debug:output");
    if (first === undefined || listeners === undefined) throw new Error("Expected stream.");

    for (const listener of listeners) {
      listener(new MessageEvent("editor-debug:output", { data: "{}", lastEventId: "7" }));
    }
    first.onerror?.();
    vi.advanceTimersByTime(1_500);

    expect(FakeEventSource.instances[1]?.url).toBe(
      "/api/editor/debug/events?workspaceId=workspace-1&lastEventId=7",
    );
    unsubscribe();
    vi.useRealTimers();
  });

  it("resets a stale resume cursor to a snapshot-required event id", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/debug/events?workspaceId=workspace-1",
      ["editor-debug:output", "editor-debug:snapshot-required"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    const output = first?.listeners.get("editor-debug:output");
    if (first === undefined || output === undefined) throw new Error("Expected first stream.");
    for (const listener of output) {
      listener(new MessageEvent("editor-debug:output", { data: "{}", lastEventId: "7" }));
    }
    first.onerror?.();
    vi.advanceTimersByTime(1_500);
    const second = FakeEventSource.instances[1];
    const required = second?.listeners.get("editor-debug:snapshot-required");
    if (second === undefined || required === undefined) throw new Error("Expected resumed stream.");
    for (const listener of required) {
      listener(
        new MessageEvent("editor-debug:snapshot-required", { data: "{}", lastEventId: "2" }),
      );
    }
    second.onerror?.();
    vi.advanceTimersByTime(2_500);

    expect(FakeEventSource.instances[2]?.url).toBe(
      "/api/editor/debug/events?workspaceId=workspace-1&lastEventId=2",
    );
    unsubscribe();
    vi.useRealTimers();
  });

  it("shares one source generation per dispatch and advances it after reconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const generations: number[] = [];
    const subscribe = (): (() => void) =>
      subscribeSharedEventSource(
        "/api/editor/debug/events?workspaceId=workspace-1",
        ["editor-debug:output"],
        (event) => generations.push(sharedEventSourceGeneration(event)),
      );
    const unsubscribeFirst = subscribe();
    const unsubscribeSecond = subscribe();
    const first = FakeEventSource.instances[0];
    const firstOutput = first?.listeners.get("editor-debug:output");
    if (first === undefined || firstOutput === undefined) throw new Error("Expected first stream.");
    for (const listener of firstOutput) {
      listener(new MessageEvent("editor-debug:output", { data: "{}", lastEventId: "1" }));
    }
    expect(generations).toEqual([1, 1]);

    first.onerror?.();
    vi.advanceTimersByTime(1_500);
    const secondOutput = FakeEventSource.instances[1]?.listeners.get("editor-debug:output");
    if (secondOutput === undefined) throw new Error("Expected reconnected stream.");
    for (const listener of secondOutput) {
      listener(new MessageEvent("editor-debug:output", { data: "{}", lastEventId: "2" }));
    }
    expect(generations).toEqual([1, 1, 2, 2]);

    unsubscribeFirst();
    unsubscribeSecond();
    vi.useRealTimers();
  });

  it("yields recoverable background streams while interactive capacity is reserved", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { reserveInteractiveBrowserStreamCapacity } =
      await import("../../../../../lib/browser-stream-capacity");
    const unsubscribeBackground = subscribeSharedEventSource(
      "/api/editor/settings/events",
      ["editor-settings:changed"],
      () => {},
      { priority: "background" },
    );
    const unsubscribeEssential = subscribeSharedEventSource(
      "/api/editor/workspace-watch/events",
      ["editor-watch:changed"],
      () => {},
    );
    const background = FakeEventSource.instances[0];
    const essential = FakeEventSource.instances[1];
    const release = reserveInteractiveBrowserStreamCapacity();

    expect(background?.closed).toBe(true);
    expect(essential?.closed).toBe(false);

    release();
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      "/api/editor/settings/events",
      "/api/editor/workspace-watch/events",
      "/api/editor/settings/events",
    ]);
    unsubscribeBackground();
    unsubscribeEssential();
  });
});
