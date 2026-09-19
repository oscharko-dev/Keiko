import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "../../../../../lib/client-diagnostics";
import {
  resetSharedEventSourcesForTests,
  sharedEventSourceGeneration,
  subscribeSharedEventSource,
} from "./sharedEventSource";

const ensureLocalSession = vi.hoisted(() =>
  vi.fn((_stream: string, _streakCorrelationId: string) => Promise.resolve(false)),
);

vi.mock("../../../../../lib/coding-app-session-client", () => ({
  repairLocalCodingAppSessionForStream: ensureLocalSession,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static immediateEventType: string | undefined;
  readonly url: string;
  readonly listeners = new Map<string, Set<EventListener>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  // Real EventSource is CLOSED (2) by the time `onerror` typically fires for a fatal failure; tests
  // that care about a different observed state override this before triggering onerror.
  readyState = 2;

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
  resetClientDiagnosticWriter();
  ensureLocalSession.mockClear();
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

  it("keeps the shared stream alive when one subscriber's cleanup runs twice", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const first = subscribeSharedEventSource("/api/commands/events", ["command:run"], () => {});
    subscribeSharedEventSource("/api/commands/events", ["command:run"], () => {});

    // React effect cleanups can run more than once; a non-idempotent unsubscribe used to
    // underflow the ref counts and tear down the stream under the remaining subscriber.
    first();
    first();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
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

  // Wave 5 of epic #3233 (g6): every EventSource.onerror handler reports a client diagnostic
  // carrying the observed readyState and a closed reason label.
  it("reports a client diagnostic with readyState and a reason label on stream error", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const reported: string[] = [];
    setClientDiagnosticWriter((message) => reported.push(message));

    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/debug/events?workspaceId=workspace-1",
      ["editor-debug:output"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("Expected stream.");
    first.readyState = 0;

    first.onerror?.();

    expect(reported).toEqual([
      "[keiko] shared-event-source sse stream error (kind=sse-error, readyState=0, reason=connecting)",
    ]);
    unsubscribe();
    vi.useRealTimers();
  });

  // A restarted BFF invalidates its in-memory app session (ADR-0141 D5), so every reconnect after
  // that was denied again forever, with nothing ever re-establishing one (the defect a live dev
  // Activity Log caught: 35 `workspace.root.denied` warn lines, one per backoff attempt). The
  // repair must run before the reconnect timer opens a new stream, at most once IN FLIGHT per
  // failure streak — not on every error, or a persistent outage would hammer the local pairing
  // endpoint — and a SUCCESSFUL repair must not be repeated again until a fresh streak starts. See
  // the next test for what happens when the repair itself fails (#3557 review).
  it("repairs the app session once per failure streak once the repair succeeds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    ensureLocalSession.mockResolvedValueOnce(true);
    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/workspace-watch/events?root=workspace-1",
      ["editor-watch:changed"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("Expected stream.");

    first.onerror?.();
    // Repaired synchronously inside the onerror handler, strictly before the reconnect timer (whose
    // minimum delay is 1s) has any chance to fire.
    expect(ensureLocalSession).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(1);
    // Let the mocked repair's promise settle — the streak's attempt is only re-armed or consumed
    // once it resolves.
    await Promise.resolve();

    vi.advanceTimersByTime(1_500);
    const second = FakeEventSource.instances[1];
    if (second === undefined) throw new Error("Expected reconnected stream.");

    second.onerror?.();
    await Promise.resolve();
    // Same failure streak (no successful open landed between the two errors), and the first repair
    // SUCCEEDED above: no second repair.
    expect(ensureLocalSession).toHaveBeenCalledOnce();

    unsubscribe();
    vi.useRealTimers();
  });

  // #3557 review (P1): a failed repair used to permanently consume the streak's only repair
  // attempt — `sessionRepairAttempted` was set unconditionally and reset only by a successful
  // open, so a repair that raced a restarting BFF and legitimately returned `false` left every
  // later reconnect in the same streak receiving 403 with no further repair ever attempted, stuck
  // until a full page reload. Without the fix this assertion sees only ONE call, not two.
  it("retries the app session repair on the next onerror after a failed repair in the same streak", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    ensureLocalSession.mockResolvedValueOnce(false);
    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/workspace-watch/events?root=workspace-1",
      ["editor-watch:changed"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("Expected stream.");

    first.onerror?.();
    expect(ensureLocalSession).toHaveBeenCalledOnce();
    await Promise.resolve();

    vi.advanceTimersByTime(1_500);
    const second = FakeEventSource.instances[1];
    if (second === undefined) throw new Error("Expected reconnected stream.");

    second.onerror?.();
    await Promise.resolve();
    // The first repair FAILED, so this onerror — still inside the same failure streak, no
    // successful open landed in between — must retry it rather than being permanently locked out
    // for the rest of the streak.
    expect(ensureLocalSession).toHaveBeenCalledTimes(2);

    unsubscribe();
    vi.useRealTimers();
  });

  it("repairs again after a successful reconnect resets the failure streak", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/workspace-watch/events?root=workspace-1",
      ["editor-watch:changed"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("Expected stream.");

    first.onerror?.();
    expect(ensureLocalSession).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_500);

    const second = FakeEventSource.instances[1];
    if (second === undefined) throw new Error("Expected reconnected stream.");
    second.onopen?.();
    second.onerror?.();

    // The successful open in between started a new streak, so this failure repairs again.
    expect(ensureLocalSession).toHaveBeenCalledTimes(2);
    // Each repair reports under its own streak's id, for this stream (#3557 review).
    const calls = ensureLocalSession.mock.calls;
    expect(calls.map(([stream]) => stream)).toEqual(["shared-event-source", "shared-event-source"]);
    expect(calls[1]?.[1]).not.toBe(calls[0]?.[1]);

    unsubscribe();
    vi.useRealTimers();
  });

  // #3557 review: the streak's error diagnostics and its repair share the streak's id, so the log
  // reads the retry sequence as one timeline even though an EventSource exposes no request id.
  it("carries the failure streak's id on every stream error of the streak and on its repair", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const reported: (ClientDiagnosticMeta | undefined)[] = [];
    setClientDiagnosticWriter((_message, meta) => reported.push(meta));
    const unsubscribe = subscribeSharedEventSource(
      "/api/editor/workspace-watch/events?root=workspace-1",
      ["editor-watch:changed"],
      () => {},
    );
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("Expected stream.");

    first.onerror?.();
    await Promise.resolve();
    vi.advanceTimersByTime(1_500);
    const second = FakeEventSource.instances[1];
    if (second === undefined) throw new Error("Expected reconnected stream.");
    second.onerror?.();
    await Promise.resolve();

    const streaks = reported.map((meta) => meta?.correlationId);
    expect(streaks).toHaveLength(2);
    expect(streaks[0]).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    expect(streaks[1]).toBe(streaks[0]);
    for (const [stream, streak] of ensureLocalSession.mock.calls) {
      expect([stream, streak]).toEqual(["shared-event-source", streaks[0]]);
    }
    unsubscribe();
    vi.useRealTimers();
  });
});
