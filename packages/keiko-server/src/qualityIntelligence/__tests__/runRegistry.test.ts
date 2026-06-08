// Unit tests for QiRunRegistry (Epic #270, Issue #273/#280).
//
// Mutation-robust: every assertion is paired against an inversion that would cause it to
// fail. Deterministic — no async, no network, no filesystem.

import { describe, expect, it } from "vitest";
import { QiRunRegistry } from "../runRegistry.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const TS = "2026-06-01T12:00:00.000Z";

function registry(): QiRunRegistry {
  return new QiRunRegistry();
}

// ─── register ────────────────────────────────────────────────────────────────

describe("QiRunRegistry.register", () => {
  it("returns an AbortController", () => {
    const r = registry();
    const ctrl = r.register("run-1", TS);
    expect(ctrl).toBeInstanceOf(AbortController);
  });

  it("returned controller is not yet aborted", () => {
    const r = registry();
    const ctrl = r.register("run-1", TS);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("each registration returns a distinct AbortController", () => {
    const r = registry();
    const ctrl1 = r.register("run-a", TS);
    const ctrl2 = r.register("run-b", TS);
    expect(ctrl1).not.toBe(ctrl2);
  });

  it("makes the run active immediately after registration", () => {
    const r = registry();
    r.register("run-1", TS);
    expect(r.isActive("run-1")).toBe(true);
  });

  it("re-registering the same id overwrites the previous record", () => {
    const r = registry();
    const ctrl1 = r.register("run-1", TS);
    const ctrl2 = r.register("run-1", TS);
    expect(ctrl1).not.toBe(ctrl2);
    expect(r.isActive("run-1")).toBe(true);
  });
});

// ─── isActive ────────────────────────────────────────────────────────────────

describe("QiRunRegistry.isActive", () => {
  it("returns false for an unknown run id", () => {
    const r = registry();
    expect(r.isActive("not-registered")).toBe(false);
  });

  it("returns true while the run is registered", () => {
    const r = registry();
    r.register("run-x", TS);
    expect(r.isActive("run-x")).toBe(true);
  });

  it("returns false after complete() is called", () => {
    const r = registry();
    r.register("run-x", TS);
    r.complete("run-x", "succeeded");
    expect(r.isActive("run-x")).toBe(false);
  });
});

// ─── updateTotals ────────────────────────────────────────────────────────────

describe("QiRunRegistry.updateTotals", () => {
  it("updates candidates total", () => {
    const r = registry();
    r.register("run-1", TS);
    r.updateTotals("run-1", { candidates: 5 });
    const summaries = r.listActiveSummaries();
    expect(summaries[0]?.totals.candidates).toBe(5);
  });

  it("updates findings total", () => {
    const r = registry();
    r.register("run-1", TS);
    r.updateTotals("run-1", { findings: 3 });
    const summaries = r.listActiveSummaries();
    expect(summaries[0]?.totals.findings).toBe(3);
  });

  it("merges partial totals — existing fields not in the patch are preserved", () => {
    const r = registry();
    r.register("run-1", TS);
    r.updateTotals("run-1", { candidates: 4 });
    r.updateTotals("run-1", { findings: 2 });
    const summary = r.listActiveSummaries()[0];
    expect(summary?.totals.candidates).toBe(4);
    expect(summary?.totals.findings).toBe(2);
  });

  it("ignores updates for an unknown run id without throwing", () => {
    const r = registry();
    expect(() => {
      r.updateTotals("ghost-run", { candidates: 99 });
    }).not.toThrow();
  });

  it("starts with all totals at 0", () => {
    const r = registry();
    r.register("run-1", TS);
    const summary = r.listActiveSummaries()[0];
    expect(summary?.totals).toEqual({ candidates: 0, findings: 0, exports: 0 });
  });
});

// ─── complete ────────────────────────────────────────────────────────────────

describe("QiRunRegistry.complete", () => {
  it("removes the run from active set on success", () => {
    const r = registry();
    r.register("run-1", TS);
    r.complete("run-1", "succeeded");
    expect(r.isActive("run-1")).toBe(false);
  });

  it("removes the run from active set on failure", () => {
    const r = registry();
    r.register("run-1", TS);
    r.complete("run-1", "failed");
    expect(r.isActive("run-1")).toBe(false);
  });

  it("removes the run from active set on cancellation", () => {
    const r = registry();
    r.register("run-1", TS);
    r.complete("run-1", "cancelled");
    expect(r.isActive("run-1")).toBe(false);
  });

  it("is a no-op for an unknown run id without throwing", () => {
    const r = registry();
    expect(() => {
      r.complete("ghost-run", "succeeded");
    }).not.toThrow();
  });

  it("completed run no longer appears in listActiveSummaries", () => {
    const r = registry();
    r.register("run-a", TS);
    r.register("run-b", TS);
    r.complete("run-a", "succeeded");
    const ids = r.listActiveSummaries().map((s) => s.id);
    expect(ids).not.toContain("run-a");
    expect(ids).toContain("run-b");
  });
});

// ─── cancel ──────────────────────────────────────────────────────────────────

describe("QiRunRegistry.cancel", () => {
  it("returns false for an unknown run id", () => {
    const r = registry();
    expect(r.cancel("not-here")).toBe(false);
  });

  it("returns true for a known active run", () => {
    const r = registry();
    r.register("run-1", TS);
    expect(r.cancel("run-1")).toBe(true);
  });

  it("aborts the AbortController when cancel is called", () => {
    const r = registry();
    const ctrl = r.register("run-1", TS);
    r.cancel("run-1");
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("leaves the run in the active set after cancel (complete must be called separately)", () => {
    const r = registry();
    r.register("run-1", TS);
    r.cancel("run-1");
    // Run is still tracked — the executor drives complete() once execution terminates.
    expect(r.isActive("run-1")).toBe(true);
  });

  it("returns false for a run id that was never registered", () => {
    const r = registry();
    r.register("run-other", TS);
    expect(r.cancel("run-1")).toBe(false);
  });
});

// ─── listActiveSummaries ─────────────────────────────────────────────────────

describe("QiRunRegistry.listActiveSummaries", () => {
  it("returns an empty array when no runs are registered", () => {
    const r = registry();
    expect(r.listActiveSummaries()).toEqual([]);
  });

  it("returns a summary with status always 'running'", () => {
    const r = registry();
    r.register("run-1", TS);
    const [summary] = r.listActiveSummaries();
    expect(summary?.status).toBe("running");
  });

  it("summary id matches the registered run id", () => {
    const r = registry();
    r.register("run-abc", TS);
    const [summary] = r.listActiveSummaries();
    expect(summary?.id).toBe("run-abc");
  });

  it("summary requestedAt matches the registration timestamp", () => {
    const r = registry();
    r.register("run-1", "2026-01-15T08:30:00.000Z");
    const [summary] = r.listActiveSummaries();
    expect(summary?.requestedAt).toBe("2026-01-15T08:30:00.000Z");
  });

  it("summary completedAt is null for running runs", () => {
    const r = registry();
    r.register("run-1", TS);
    const [summary] = r.listActiveSummaries();
    expect(summary?.completedAt).toBeNull();
  });

  it("returns all active runs", () => {
    const r = registry();
    r.register("run-a", TS);
    r.register("run-b", TS);
    r.register("run-c", TS);
    const ids = r.listActiveSummaries().map((s) => s.id);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("run-a");
    expect(ids).toContain("run-b");
    expect(ids).toContain("run-c");
  });

  it("reflects live totals after updateTotals", () => {
    const r = registry();
    r.register("run-1", TS);
    r.updateTotals("run-1", { candidates: 7, findings: 2 });
    const [summary] = r.listActiveSummaries();
    expect(summary?.totals.candidates).toBe(7);
    expect(summary?.totals.findings).toBe(2);
  });

  it("returns a snapshot copy of totals — prior snapshots are not mutated", () => {
    const r = registry();
    r.register("run-1", TS);
    const [summary1] = r.listActiveSummaries();
    r.updateTotals("run-1", { candidates: 10 });
    // The previously captured summary object must not change.
    expect(summary1?.totals.candidates).toBe(0);
  });
});

// ─── reset ───────────────────────────────────────────────────────────────────

describe("QiRunRegistry.reset", () => {
  it("empties the active run set", () => {
    const r = registry();
    r.register("run-a", TS);
    r.register("run-b", TS);
    r.reset();
    expect(r.listActiveSummaries()).toEqual([]);
  });

  it("aborts all registered controllers", () => {
    const r = registry();
    const ctrl1 = r.register("run-a", TS);
    const ctrl2 = r.register("run-b", TS);
    r.reset();
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
  });

  it("isActive returns false for all previous runs after reset", () => {
    const r = registry();
    r.register("run-a", TS);
    r.reset();
    expect(r.isActive("run-a")).toBe(false);
  });

  it("allows re-registration after reset with a fresh (non-aborted) controller", () => {
    const r = registry();
    r.register("run-a", TS);
    r.reset();
    const ctrl = r.register("run-a", TS);
    expect(ctrl.signal.aborted).toBe(false);
    expect(r.isActive("run-a")).toBe(true);
  });

  it("is a no-op on an already-empty registry without throwing", () => {
    const r = registry();
    expect(() => {
      r.reset();
    }).not.toThrow();
  });
});
