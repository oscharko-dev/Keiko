import { describe, expect, it } from "vitest";

import { JACCARD_DEFAULT, MAX_AGE_MS_DEFAULT, STALE_CONFIDENCE_DEFAULT } from "./_constants.js";
import { FIXED_NOW_MS, makeEdgeIdFactory, makeIdFactory, makeRecord, must } from "./_support.js";
import { runConsolidation } from "./consolidate.js";
import type { ConsolidationOptions } from "./types.js";

function baseOptions(overrides: Partial<ConsolidationOptions> = {}): ConsolidationOptions {
  return {
    nowMs: FIXED_NOW_MS,
    newEdgeId: makeEdgeIdFactory(),
    newReviewItemId: makeIdFactory("rv"),
    jaccardThreshold: JACCARD_DEFAULT,
    staleConfidenceThreshold: STALE_CONFIDENCE_DEFAULT,
    maxAgeMs: MAX_AGE_MS_DEFAULT,
    maxClustersPerRun: 100,
    ...overrides,
  };
}

describe("runConsolidation - skip and empty cases", () => {
  it("returns state 'skipped' for an empty input", () => {
    const result = runConsolidation([], baseOptions());
    expect(result.state).toBe("skipped");
    expect(result.edgesProposed).toEqual([]);
    expect(result.updatesProposed).toEqual([]);
    expect(result.staleFlags).toEqual([]);
    expect(result.reviewItems).toEqual([]);
    expect(result.clustersInspected).toBe(0);
    expect(result.elapsedMs).toBe(0);
  });

  it("returns state 'skipped' when maxClustersPerRun is 0", () => {
    const r = makeRecord();
    const result = runConsolidation([r], baseOptions({ maxClustersPerRun: 0 }));
    expect(result.state).toBe("skipped");
  });
});

describe("runConsolidation - invalid options", () => {
  it("returns state 'failed' when jaccardThreshold is < 0", () => {
    const result = runConsolidation([makeRecord()], baseOptions({ jaccardThreshold: -0.1 }));
    expect(result.state).toBe("failed");
  });

  it("returns state 'failed' when jaccardThreshold is > 1", () => {
    const result = runConsolidation([makeRecord()], baseOptions({ jaccardThreshold: 1.1 }));
    expect(result.state).toBe("failed");
  });

  it("returns state 'failed' when staleConfidenceThreshold is NaN", () => {
    const result = runConsolidation(
      [makeRecord()],
      baseOptions({ staleConfidenceThreshold: Number.NaN }),
    );
    expect(result.state).toBe("failed");
  });

  it("returns state 'failed' when maxAgeMs is negative", () => {
    const result = runConsolidation([makeRecord()], baseOptions({ maxAgeMs: -1 }));
    expect(result.state).toBe("failed");
  });
});

describe("runConsolidation - two-member duplicate (no negation)", () => {
  it("emits one derived-from edge oldest -> newest and one supersede review item", () => {
    const older = makeRecord({ id: "m-old", body: "use tabs", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "use tabs", createdAt: 200 });
    const result = runConsolidation([older, newer], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.edgesProposed).toHaveLength(1);
    const edge = must(result.edgesProposed[0]);
    expect(edge.kind).toBe("derived-from");
    expect(edge.fromMemoryId).toBe("m-old");
    expect(edge.toMemoryId).toBe("m-new");
    expect(edge.createdAt).toBe(FIXED_NOW_MS);
    expect(edge.id).toBe("edge-1");
    // Two-member non-conflicting cluster: edge ONLY, no review item. Supersede review items
    // are reserved for polarity-flip pairs (see "two-member negation pair" below).
    expect(result.reviewItems).toEqual([]);
    expect(result.clustersInspected).toBe(1);
  });
});

describe("runConsolidation - two-member negation pair", () => {
  it("emits one supersede review item and NO auto edge", () => {
    const older = makeRecord({ id: "m-old", body: "we use tabs", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "we do not use tabs", createdAt: 200 });
    const result = runConsolidation([older, newer], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.edgesProposed).toEqual([]);
    expect(result.reviewItems).toHaveLength(1);
    expect(must(result.reviewItems[0]).reason).toBe("potential-conflict");
  });
});

describe("runConsolidation - multi-way duplicate (3+ members)", () => {
  it("emits one merge review item and NO auto edges", () => {
    const a = makeRecord({ id: "m-a", body: "x", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "x", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "x", createdAt: 300 });
    const result = runConsolidation([a, b, c], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.edgesProposed).toEqual([]);
    expect(result.reviewItems).toHaveLength(1);
    expect(must(result.reviewItems[0]).reason).toBe("multi-way-duplicate");
    expect(must(result.reviewItems[0]).proposedAction).toEqual({
      kind: "merge",
      winner: "m-c",
      losers: ["m-a", "m-b"],
    });
  });
});

describe("runConsolidation - updatesProposed reserved for v1", () => {
  it("never emits MemoryUpdate envelopes in v1 (port-only design)", () => {
    const older = makeRecord({ id: "m-old", body: "same", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "same", createdAt: 200 });
    const result = runConsolidation([older, newer], baseOptions());
    expect(result.updatesProposed).toEqual([]);
  });
});

describe("runConsolidation - maxClustersPerRun bound", () => {
  it("inspects only up to maxClustersPerRun clusters", () => {
    const a = makeRecord({ id: "m-1a", body: "alpha alpha", createdAt: 100 });
    const b = makeRecord({ id: "m-1b", body: "alpha alpha", createdAt: 200 });
    const c = makeRecord({ id: "m-2a", body: "beta beta", createdAt: 100 });
    const d = makeRecord({ id: "m-2b", body: "beta beta", createdAt: 200 });
    const result = runConsolidation([a, b, c, d], baseOptions({ maxClustersPerRun: 1 }));
    expect(result.clustersInspected).toBe(1);
    expect(result.edgesProposed.length + result.reviewItems.length).toBeLessThanOrEqual(2);
  });
});

describe("runConsolidation - cancellation", () => {
  it("returns state 'canceled' when the signal fires before the first cluster", () => {
    const a = makeRecord({ id: "m-a", body: "x", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "x", createdAt: 200 });
    const result = runConsolidation([a, b], baseOptions({ cancellationSignal: () => true }));
    expect(result.state).toBe("canceled");
    expect(result.clustersInspected).toBe(0);
  });

  it("returns state 'canceled' with partial results after the first cluster", () => {
    const a = makeRecord({ id: "m-1a", body: "alpha alpha", createdAt: 100 });
    const b = makeRecord({ id: "m-1b", body: "alpha alpha", createdAt: 200 });
    const c = makeRecord({ id: "m-2a", body: "beta beta", createdAt: 100 });
    const d = makeRecord({ id: "m-2b", body: "beta beta", createdAt: 200 });
    let calls = 0;
    const result = runConsolidation(
      [a, b, c, d],
      baseOptions({
        cancellationSignal: () => {
          calls += 1;
          return calls > 1;
        },
      }),
    );
    expect(result.state).toBe("canceled");
    expect(result.clustersInspected).toBe(1);
    expect(result.edgesProposed.length + result.reviewItems.length).toBeGreaterThan(0);
  });
});

describe("runConsolidation - stale flag integration", () => {
  it("emits stale flags independently from cluster processing", () => {
    const stale = makeRecord({
      id: "m-stale",
      body: "old fact",
      validUntil: FIXED_NOW_MS - 1,
    });
    const result = runConsolidation([stale], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.staleFlags).toHaveLength(1);
    expect(must(result.staleFlags[0])).toMatchObject({
      memoryId: "m-stale",
      reason: "expired",
      detectedAt: FIXED_NOW_MS,
    });
  });
});

describe("runConsolidation - end-to-end mixed input", () => {
  it("populates all three result categories in one run", () => {
    const stale = makeRecord({
      id: "m-stale",
      body: "stale fact",
      validUntil: FIXED_NOW_MS - 1,
    });
    const dupA = makeRecord({ id: "m-da", body: "same body", createdAt: 100 });
    const dupB = makeRecord({ id: "m-db", body: "same body", createdAt: 200 });
    const conflictOld = makeRecord({
      id: "m-co",
      body: "we deploy on Friday",
      createdAt: 100,
      type: "decision",
    });
    const conflictNew = makeRecord({
      id: "m-cn",
      body: "we do not deploy on Friday",
      createdAt: 200,
      type: "decision",
    });
    const result = runConsolidation([stale, dupA, dupB, conflictOld, conflictNew], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.staleFlags.length).toBeGreaterThan(0);
    expect(result.edgesProposed.length).toBeGreaterThan(0);
    expect(result.reviewItems.length).toBeGreaterThan(0);
  });
});

describe("runConsolidation - elapsedMs is always 0 (pure layer)", () => {
  it("never computes wall-clock elapsed; caller does this at job-transition site", () => {
    const result = runConsolidation([], baseOptions());
    expect(result.elapsedMs).toBe(0);
  });
});
