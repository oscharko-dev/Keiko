import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import {
  CODING_WORKBENCH_EVENT_RETENTION_LIMIT,
  CODING_WORKBENCH_OBSERVATION_BATCH_MS,
  createCodingWorkbenchRuntimeStreamSession,
  isPinnedCodingWorkbenchRuntimeEvent,
  retainCodingWorkbenchRuntimeEvents,
} from "./coding-workbench-event-retention";

afterEach(() => {
  resetClientDiagnosticWriter();
});

function event(
  sequence: number,
  overrides: Partial<CodingWorkbenchRuntimeSseEvent> = {},
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `cursor-${String(sequence)}`,
    sequence,
    occurredAt: "2026-07-13T12:00:00.000Z",
    kind: "status",
    runId: "run-1",
    state: "running",
    revision: sequence,
    ...overrides,
  } as CodingWorkbenchRuntimeSseEvent;
}

function observation(sequence: number): CodingWorkbenchRuntimeSseEvent {
  return {
    ...event(sequence),
    kind: "runtime-event",
    eventKind: "observation-streamed",
  };
}

describe("Coding Workbench event retention", () => {
  it("closes and recreates a runtime stream after bounded inactivity", async () => {
    vi.useFakeTimers();
    try {
      const sources: FakeEventSource[] = [];
      const createEventSource = vi.fn((): EventSource => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      });
      const session = createCodingWorkbenchRuntimeStreamSession(
        "run-1",
        {
          onOpen: vi.fn(),
          onEvents: vi.fn(),
          onError: vi.fn(),
          onReset: vi.fn(() => Promise.resolve()),
        },
        { staleAfterMs: 100, createEventSource },
      );

      await vi.advanceTimersByTimeAsync(99);

      expect(createEventSource).toHaveBeenCalledOnce();
      expect(sources[0]?.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(createEventSource).toHaveBeenCalledTimes(2);
      expect(sources[0]?.close).toHaveBeenCalledOnce();
      session.close();
      expect(sources[1]?.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats observable heartbeat events as stream activity", async () => {
    vi.useFakeTimers();
    try {
      const sources: FakeEventSource[] = [];
      const createEventSource = vi.fn((): EventSource => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      });
      const session = createCodingWorkbenchRuntimeStreamSession(
        "run-1",
        {
          onOpen: vi.fn(),
          onEvents: vi.fn(),
          onError: vi.fn(),
          onReset: vi.fn(() => Promise.resolve()),
        },
        { staleAfterMs: 100, createEventSource },
      );

      await vi.advanceTimersByTimeAsync(99);
      sources[0]?.emit("heartbeat");
      await vi.advanceTimersByTimeAsync(99);
      expect(createEventSource).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(createEventSource).toHaveBeenCalledTimes(2);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches stale source callbacks when the session closes", () => {
    const source = new FakeEventSource();
    const onEvents = vi.fn();
    const onError = vi.fn();
    const onReset = vi.fn(() => Promise.resolve());
    const session = createCodingWorkbenchRuntimeStreamSession(
      "run-1",
      { onOpen: vi.fn(), onEvents, onError, onReset },
      { createEventSource: () => source as unknown as EventSource },
    );

    session.close();
    source.emit("runtime-event", JSON.stringify(event(1)));
    source.emit("reset");
    source.onerror?.(new Event("error"));

    expect(onEvents).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  // Wave 5 of epic #3233 (g6): every EventSource.onerror handler reports a client diagnostic
  // carrying the observed readyState and a closed reason label.
  it("reports a client diagnostic with readyState and a reason label on stream error", () => {
    const reported: string[] = [];
    setClientDiagnosticWriter((message) => reported.push(message));
    const source = new FakeEventSource();
    source.readyState = 0;
    const session = createCodingWorkbenchRuntimeStreamSession(
      "run-1",
      { onOpen: vi.fn(), onEvents: vi.fn(), onError: vi.fn(), onReset: vi.fn() },
      { createEventSource: () => source as unknown as EventSource },
    );

    source.onerror?.(new Event("error"));

    expect(reported).toEqual([
      "[keiko] coding-workbench-runtime sse stream error (kind=sse-error, readyState=0, reason=connecting)",
    ]);
    session.close();
  });

  it("delivers observations before a later state event without bypassing the batch", () => {
    vi.useFakeTimers();
    try {
      const source = new FakeEventSource();
      const onEvents = vi.fn();
      const session = createCodingWorkbenchRuntimeStreamSession(
        "run-1",
        {
          onOpen: vi.fn(),
          onEvents,
          onError: vi.fn(),
          onReset: vi.fn(() => Promise.resolve()),
        },
        { createEventSource: () => source as unknown as EventSource },
      );

      source.emit("runtime-event", JSON.stringify(observation(1)));
      source.emit("status", JSON.stringify(event(2)));
      vi.advanceTimersByTime(CODING_WORKBENCH_OBSERVATION_BATCH_MS);

      expect(onEvents).toHaveBeenCalledWith([observation(1), event(2)], "cursor-2", true);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops pending observations when reset atomically replaces the session", () => {
    const source = new FakeEventSource();
    const onEvents = vi.fn();
    const onReset = vi.fn(() => Promise.resolve());
    createCodingWorkbenchRuntimeStreamSession(
      "run-1",
      { onOpen: vi.fn(), onEvents, onError: vi.fn(), onReset },
      { createEventSource: () => source as unknown as EventSource },
    );

    source.emit("runtime-event", JSON.stringify(observation(1)));
    source.emit("reset");

    expect(onEvents).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("flushes and resumes from the latest cursor before a stale reconnect", async () => {
    vi.useFakeTimers();
    try {
      const sources: FakeEventSource[] = [];
      const onEvents = vi.fn();
      const createEventSource = vi.fn((_runId: string, _cursor?: string): EventSource => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      });
      const session = createCodingWorkbenchRuntimeStreamSession(
        "run-1",
        {
          onOpen: vi.fn(),
          onEvents,
          onError: vi.fn(),
          onReset: vi.fn(() => Promise.resolve()),
        },
        { staleAfterMs: 50, createEventSource },
      );
      sources[0]?.emit("runtime-event", JSON.stringify(observation(1)));

      await vi.advanceTimersByTimeAsync(50);

      expect(onEvents).toHaveBeenCalledWith([observation(1)], "cursor-1", false);
      expect(createEventSource).toHaveBeenLastCalledWith("run-1", "cursor-1");
      expect(sources[0]?.close).toHaveBeenCalledOnce();
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains at most 500 events while preserving incoming critical containment facts", () => {
    const ordinary = Array.from({ length: 1_000 }, (_, index) => event(index + 1));
    const critical = [
      event(1_001, { state: "awaiting-approval" }),
      event(1_002, { state: "succeeded" }),
      event(1_003, { state: "recovery-required" }),
      {
        ...event(1_004),
        kind: "runtime-event" as const,
        eventKind: "permission-requested" as const,
      },
    ];

    const retained = retainCodingWorkbenchRuntimeEvents(ordinary, critical);

    expect(retained).toHaveLength(CODING_WORKBENCH_EVENT_RETENTION_LIMIT);
    expect(retained.map((entry) => entry.cursor)).toEqual(
      expect.arrayContaining(critical.map((entry) => entry.cursor)),
    );
    expect(retained[0]?.sequence).toBe(505);
    expect(retained.at(-1)?.sequence).toBe(1_004);
  });

  it("retains pinned facts over newer ordinary observations at a smaller bound", () => {
    const permission = {
      ...event(2),
      kind: "runtime-event" as const,
      eventKind: "permission-requested" as const,
    };
    const recovery = event(4, { state: "recovery-required" });

    const retained = retainCodingWorkbenchRuntimeEvents(
      [event(1), permission, event(3), recovery, event(5)],
      [event(6)],
      3,
    );

    expect(retained.map((entry) => entry.sequence)).toEqual([2, 4, 6]);
    expect(retained.filter(isPinnedCodingWorkbenchRuntimeEvent)).toHaveLength(2);
  });

  it("deduplicates replayed cursors and preserves monotonic presentation order", () => {
    const retained = retainCodingWorkbenchRuntimeEvents(
      [event(2), event(3)],
      [event(1), event(2, { revision: 8 })],
    );

    expect(retained.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(retained.find((entry) => entry.cursor === "cursor-2")?.revision).toBe(8);
  });

  it("deduplicates only the same run and cursor pair", () => {
    const retained = retainCodingWorkbenchRuntimeEvents(
      [event(1, { cursor: "replayed", runId: "run-1" })],
      [event(1, { cursor: "replayed", runId: "run-2" })],
    );

    expect(retained).toHaveLength(2);
    expect(retained.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
  });
});

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public readonly close = vi.fn();
  // Real EventSource is CLOSED (2) by the time `onerror` typically fires for a fatal failure;
  // tests that care about a different observed state override this before triggering onerror.
  public readyState = 2;
  private readonly listeners = new Map<string, EventListener[]>();

  public addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  public emit(type: string, data?: string): void {
    const emitted = { type, ...(data === undefined ? {} : { data }) } as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(emitted);
  }
}
