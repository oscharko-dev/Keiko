import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LspLifecycleEvent } from "@oscharko-dev/keiko-contracts";

import {
  _resetLspLifecycleLedgerForTests,
  listAllLspLifecycleEvents,
  listLspLifecycleEvents,
  recordLspLifecycleEvent,
} from "./lspLifecycleLedger.js";

function event(overrides: Partial<LspLifecycleEvent> = {}): LspLifecycleEvent {
  return {
    schemaVersion: "1",
    managerId: "mgr-1",
    status: "READY",
    timestampMs: 1_000,
    pendingRequestCount: 0,
    restartCount: 0,
    stderrBytesSeen: 0,
    ...overrides,
  };
}

describe("lspLifecycleLedger", () => {
  beforeEach(() => {
    _resetLspLifecycleLedgerForTests();
  });
  afterEach(() => {
    _resetLspLifecycleLedgerForTests();
  });

  it("records an event and returns the stored copy", () => {
    const stored = recordLspLifecycleEvent(event({ status: "STARTING" }));

    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("STARTING");
    expect(listLspLifecycleEvents()).toHaveLength(1);
  });

  it("preserves chronological order (newest last)", () => {
    recordLspLifecycleEvent(event({ status: "STARTING", timestampMs: 1 }));
    recordLspLifecycleEvent(event({ status: "INITIALIZING", timestampMs: 2 }));
    recordLspLifecycleEvent(event({ status: "READY", timestampMs: 3 }));

    expect(listLspLifecycleEvents().map((entry) => entry.status)).toEqual([
      "STARTING",
      "INITIALIZING",
      "READY",
    ]);
  });

  it("caps the ledger at 200 entries with FIFO eviction", () => {
    for (let i = 0; i < 250; i += 1) {
      recordLspLifecycleEvent(event({ timestampMs: i }));
    }
    const events = listLspLifecycleEvents();

    expect(events).toHaveLength(200);
    expect(events[0]?.timestampMs).toBe(50);
    expect(events[199]?.timestampMs).toBe(249);
  });

  it("applies the redactor to string leaves before storing", () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    recordLspLifecycleEvent(event({ managerId: secret }));

    const stored = listLspLifecycleEvents()[0];
    expect(stored?.managerId).not.toBe(secret);
    expect(JSON.stringify(listLspLifecycleEvents())).not.toContain(secret);
  });

  it("returns the error code when present", () => {
    recordLspLifecycleEvent(event({ status: "CRASHED", errorCode: "CRASHED" }));

    expect(listLspLifecycleEvents()[0]?.errorCode).toBe("CRASHED");
  });

  it("returns an empty list before any event is recorded", () => {
    expect(listLspLifecycleEvents()).toEqual([]);
  });

  it("resets to empty for tests", () => {
    recordLspLifecycleEvent(event());
    _resetLspLifecycleLedgerForTests();

    expect(listLspLifecycleEvents()).toEqual([]);
  });

  it("partitions events by workspace key so two roots stay disjoint (KEIKO-0556)", () => {
    // Two workspace partitions running the same managerId (language) must produce disjoint
    // per-partition views yet remain observable through the union projection the status route
    // uses. Before the fix, a single module-level FIFO interleaved both partitions with nothing
    // in the wire shape to tell them apart.
    recordLspLifecycleEvent(event({ status: "STARTING", timestampMs: 1 }), "partition-A");
    recordLspLifecycleEvent(event({ status: "READY", timestampMs: 2 }), "partition-A");
    recordLspLifecycleEvent(event({ status: "CRASHED", timestampMs: 3 }), "partition-B");

    expect(listLspLifecycleEvents("partition-A").map((e) => e.status)).toEqual([
      "STARTING",
      "READY",
    ]);
    expect(listLspLifecycleEvents("partition-B").map((e) => e.status)).toEqual(["CRASHED"]);
    expect(listAllLspLifecycleEvents()).toHaveLength(3);
  });

  it("KEIKO-0556-r3: bounds the number of retained partitions under high root-cardinality churn", () => {
    // Regression for the round-3 finding: before the fix, `partitions` was an unbounded Map keyed
    // by workspacePartitionKey -- a long-running server that opened/closed many distinct workspace
    // roots over its lifetime would retain a 200-entry FIFO per root forever. Drive well past
    // MAX_PARTITIONS (64) and prove the map stays bounded, with the least-recently-touched
    // partitions evicted first.
    for (let i = 0; i < 100; i += 1) {
      recordLspLifecycleEvent(event({ status: "READY", timestampMs: i }), `root-${String(i)}`);
    }

    // The union view is proportional to real recent activity (64 partitions x 1 event), never to
    // the cumulative 100 roots ever seen.
    expect(listAllLspLifecycleEvents()).toHaveLength(64);
    // The earliest-touched partitions (root-0..root-35) aged out; the most recent 64 survive.
    expect(listLspLifecycleEvents("root-0")).toEqual([]);
    expect(listLspLifecycleEvents("root-35")).toEqual([]);
    expect(listLspLifecycleEvents("root-36")).toHaveLength(1);
    expect(listLspLifecycleEvents("root-99")).toHaveLength(1);
  });

  it("KEIKO-0556-r3: re-touching an existing partition keeps it alive instead of aging it out", () => {
    // A partition that is genuinely still active (repeatedly recorded to) must not be evicted just
    // because many OTHER partitions were created after it -- only genuinely idle partitions age out.
    recordLspLifecycleEvent(event({ status: "READY", timestampMs: 0 }), "hot-root");
    for (let i = 0; i < 80; i += 1) {
      recordLspLifecycleEvent(
        event({ status: "READY", timestampMs: i + 1 }),
        `filler-${String(i)}`,
      );
      // Touch hot-root on every iteration so it is never the least-recently-touched partition.
      recordLspLifecycleEvent(event({ status: "READY", timestampMs: i + 1 }), "hot-root");
    }

    expect(listLspLifecycleEvents("hot-root").length).toBeGreaterThan(0);
  });

  it("KEIKO-0556-r3: the union view is in true chronological order, not per-partition-then-Map-order", () => {
    // Regression for the round-3 finding: the pre-fix union simply concatenated each partition's
    // FIFO in Map insertion order. Insert partition "z" first with a LATER timestamp, then
    // partition "a" with an EARLIER timestamp -- Map insertion order would put "z"'s event first;
    // true chronology must put "a"'s event first.
    recordLspLifecycleEvent(event({ status: "CRASHED", timestampMs: 100 }), "z-partition");
    recordLspLifecycleEvent(event({ status: "STARTING", timestampMs: 10 }), "a-partition");
    recordLspLifecycleEvent(event({ status: "READY", timestampMs: 50 }), "a-partition");

    const merged = listAllLspLifecycleEvents();

    expect(merged.map((e) => e.timestampMs)).toEqual([10, 50, 100]);
    expect(merged.map((e) => e.status)).toEqual(["STARTING", "READY", "CRASHED"]);
  });

  it("KEIKO-0556-r3: each union event carries its own workspacePartitionKey, distinguishing equal managerIds", () => {
    // Regression for the round-3 finding: `LspLifecycleEvent` carries no partition identifier, so
    // two roots running the same language provider under an identical managerId were previously
    // indistinguishable once flattened.
    recordLspLifecycleEvent(event({ managerId: "python", timestampMs: 1 }), "root-x");
    recordLspLifecycleEvent(event({ managerId: "python", timestampMs: 2 }), "root-y");

    const merged = listAllLspLifecycleEvents();

    expect(merged).toEqual([
      expect.objectContaining({ managerId: "python", workspacePartitionKey: "root-x" }),
      expect.objectContaining({ managerId: "python", workspacePartitionKey: "root-y" }),
    ]);
  });

  it("KEIKO-0556-r3: ties at the same timestamp break deterministically by partition key", () => {
    recordLspLifecycleEvent(event({ status: "READY", timestampMs: 5 }), "b-partition");
    recordLspLifecycleEvent(event({ status: "CRASHED", timestampMs: 5 }), "a-partition");

    const merged = listAllLspLifecycleEvents();

    // Both events share timestampMs=5; the deterministic tie-break is lexicographic partition key.
    expect(merged.map((e) => e.workspacePartitionKey)).toEqual(["a-partition", "b-partition"]);
  });
});
