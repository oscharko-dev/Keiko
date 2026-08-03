import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_EVENT_RETENTION_LIMIT,
  createCodingWorkbenchRuntimeStreamSession,
  isPinnedCodingWorkbenchRuntimeEvent,
  retainCodingWorkbenchRuntimeEvents,
} from "./coding-workbench-event-retention";

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

      await vi.advanceTimersByTimeAsync(100);

      expect(createEventSource).toHaveBeenCalledTimes(2);
      expect(sources[0]?.close).toHaveBeenCalledOnce();
      session.close();
      expect(sources[1]?.close).toHaveBeenCalledOnce();
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

  public addEventListener(_type: string, _listener: EventListener): void {}
}
