import { describe, expect, it } from "vitest";
import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_EVENT_RETENTION_LIMIT,
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
