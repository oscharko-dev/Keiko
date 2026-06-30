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
    maxRecordsPerRun: 1_000,
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
    expect(result.conflictPairsDetected).toBe(0);
    expect(result.recordsInspected).toBe(0);
    expect(result.truncated).toBe(false);
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

  it("returns state 'failed' when an input record fails contract validation", () => {
    const invalid = { ...makeRecord(), body: "" };
    const result = runConsolidation([invalid], baseOptions());
    expect(result.state).toBe("failed");
  });
});

describe("runConsolidation - two-member duplicate (no negation)", () => {
  it("emits one derived-from edge oldest -> newest and one supersede review item", () => {
    const older = makeRecord({ id: "m-old", body: "use tabs", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "use tabs", createdAt: 200 });
    const result = runConsolidation([older, newer], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.edgesProposed).toHaveLength(3);
    expect(result.edgesProposed.map((edge) => edge.kind).sort()).toEqual([
      "derived-from",
      "related",
      "temporal-precedes",
    ]);
    const lineage = must(result.edgesProposed.find((edge) => edge.kind === "derived-from"));
    expect(lineage.fromMemoryId).toBe("m-old");
    expect(lineage.toMemoryId).toBe("m-new");
    expect(lineage.createdAt).toBe(FIXED_NOW_MS);
    expect(lineage.id).toBe("edge-1");
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
    expect(
      must(result.reviewItems[0])
        .proposedEdges?.map((edge) => edge.kind)
        .sort(),
    ).toEqual(["conflicts-with", "corrects", "supersedes"]);
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
    expect(
      must(result.reviewItems[0])
        .proposedEdges?.map((edge) => edge.kind)
        .sort(),
    ).toEqual(["derived-from", "derived-from", "related", "related", "supersedes", "supersedes"]);
    expect(result.updatesProposed).toHaveLength(1);
    expect(must(result.updatesProposed[0])).toMatchObject({
      memoryId: "m-c",
      bodyPatch: "x",
    });
    expect(result.summaryStatus).toMatchObject({
      kind: "not-configured",
      updatesProposed: 1,
      fallbacksUsed: 1,
      skippedMergeClusters: 0,
    });
  });

  it("uses deterministic union body updates when no summaryGenerator is configured", () => {
    const a = makeRecord({ id: "m-a", body: "use tabs", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "prefer compact diffs", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "keep PR titles short", createdAt: 300 });
    const result = runConsolidation([a, b, c], baseOptions({ jaccardThreshold: 0 }));
    expect(result.updatesProposed).toHaveLength(1);
    const update = must(result.updatesProposed[0]);
    expect(update.bodyPatch).toBe(
      "- use tabs\n- prefer compact diffs\n- keep PR titles short",
    );
    expect(update.reviewerNote).toContain("Deterministic union fallback");
    expect(result.summaryStatus).toMatchObject({
      kind: "not-configured",
      updatesProposed: 1,
      fallbacksUsed: 1,
    });
  });

  it("proposes a source-preserving body update when summaryGenerator is configured", () => {
    const a = makeRecord({ id: "m-a", body: "use tabs", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "prefer compact diffs", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "keep PR titles short", createdAt: 300 });
    const result = runConsolidation(
      [a, b, c],
      baseOptions({
        jaccardThreshold: 0,
        summaryGenerator: ({ sourceBodies }) => sourceBodies.join("; "),
      }),
    );
    expect(result.reviewItems).toHaveLength(1);
    expect(must(result.reviewItems[0]).sourceMemoryIds).toEqual(["m-a", "m-b", "m-c"]);
    expect(result.updatesProposed).toHaveLength(1);
    expect(must(result.updatesProposed[0])).toMatchObject({
      memoryId: "m-c",
      bodyPatch: "use tabs; prefer compact diffs; keep PR titles short",
    });
    expect(must(result.updatesProposed[0]).reviewerNote).toContain("m-a, m-b, m-c");
    expect(result.summaryStatus).toMatchObject({
      kind: "configured",
      updatesProposed: 1,
      fallbacksUsed: 0,
    });
  });

  it("preserves reviewer notes returned by an object summary", () => {
    const a = makeRecord({ id: "m-a", body: "use tabs", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "prefer compact diffs", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "keep PR titles short", createdAt: 300 });
    const result = runConsolidation(
      [a, b, c],
      baseOptions({
        jaccardThreshold: 0,
        summaryGenerator: ({ sourceBodies }) => ({
          body: sourceBodies.join("; "),
          reviewerNote: "model preserved all source claims",
        }),
      }),
    );
    const update = must(result.updatesProposed[0]);
    expect(update.bodyPatch).toBe("use tabs; prefer compact diffs; keep PR titles short");
    expect(update.reviewerNote).toContain("model preserved all source claims");
    expect(result.summaryStatus.fallbacksUsed).toBe(0);
  });

  it("falls back to deterministic union text when a generated summary drops source content", () => {
    const a = makeRecord({ id: "m-a", body: "use tabs", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "prefer compact diffs", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "keep PR titles short", createdAt: 300 });
    const result = runConsolidation(
      [a, b, c],
      baseOptions({
        jaccardThreshold: 0,
        summaryGenerator: () => "use tabs",
      }),
    );
    const update = must(result.updatesProposed[0]);
    expect(update.bodyPatch).toContain("prefer compact diffs");
    expect(update.bodyPatch).toContain("keep PR titles short");
    expect(update.reviewerNote).toContain("Deterministic union fallback");
    expect(result.summaryStatus.fallbacksUsed).toBe(1);
  });

  it("falls back when the summaryGenerator returns null", () => {
    const a = makeRecord({ id: "m-a", body: "use tabs", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "prefer compact diffs", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "keep PR titles short", createdAt: 300 });
    const result = runConsolidation(
      [a, b, c],
      baseOptions({
        jaccardThreshold: 0,
        summaryGenerator: () => null,
      }),
    );
    const update = must(result.updatesProposed[0]);
    expect(update.bodyPatch).toContain("prefer compact diffs");
    expect(update.reviewerNote).toContain("Deterministic union fallback");
    expect(result.summaryStatus.fallbacksUsed).toBe(1);
  });

  it("falls back when the summaryGenerator throws", () => {
    const a = makeRecord({ id: "m-a", body: "use tabs", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "prefer compact diffs", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "keep PR titles short", createdAt: 300 });
    const result = runConsolidation(
      [a, b, c],
      baseOptions({
        jaccardThreshold: 0,
        summaryGenerator: () => {
          throw new Error("summary unavailable");
        },
      }),
    );
    const update = must(result.updatesProposed[0]);
    expect(update.bodyPatch).toContain("keep PR titles short");
    expect(update.reviewerNote).toContain("Deterministic union fallback");
    expect(result.summaryStatus.fallbacksUsed).toBe(1);
  });
});

describe("runConsolidation - updatesProposed without merge summary", () => {
  it("does not emit MemoryUpdate envelopes for two-member auto-edge duplicates", () => {
    const older = makeRecord({ id: "m-old", body: "same", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "same", createdAt: 200 });
    const result = runConsolidation([
      older,
      newer,
    ], baseOptions({
      summaryGenerator: () => "same",
    }));
    expect(result.updatesProposed).toEqual([]);
  });
});

describe("runConsolidation - explicit status scope", () => {
  it("includes proposed/conflicted records by default but routes them to review instead of auto edges", () => {
    const accepted = makeRecord({ id: "m-a", body: "same body", createdAt: 100 });
    const proposed = makeRecord({
      id: "m-p",
      body: "same body",
      status: "proposed",
      createdAt: 200,
    });
    const result = runConsolidation([accepted, proposed], baseOptions());
    expect(result.state).toBe("completed");
    expect(result.edgesProposed).toEqual([]);
    expect(result.reviewItems).toHaveLength(1);
    expect(must(result.reviewItems[0]).reason).toBe("duplicate-review");
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
    expect(result.edgesProposed.length + result.reviewItems.length).toBeLessThanOrEqual(3);
  });
});

describe("runConsolidation - maxRecordsPerRun bound", () => {
  it("admits only maxRecordsPerRun records before duplicate and conflict scans", () => {
    const records = Array.from({ length: 2_000 }, (_, index) =>
      makeRecord({
        id: `m-${index.toString().padStart(4, "0")}`,
        body: `unique memory body ${index.toString()}`,
        createdAt: index,
      }),
    );
    const result = runConsolidation(records, baseOptions({ maxRecordsPerRun: 200 }));
    expect(result.state).toBe("completed");
    expect(result.recordsInspected).toBe(200);
    expect(result.truncated).toBe(true);
  });

  it("rejects attempts to exceed the hard record cap", () => {
    const result = runConsolidation([makeRecord()], baseOptions({ maxRecordsPerRun: 1_001 }));
    expect(result.state).toBe("failed");
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

  it("returns state 'canceled' with bounded partial progress once cancellation starts firing", () => {
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
          return calls > 5;
        },
      }),
    );
    expect(result.state).toBe("canceled");
    expect(result.clustersInspected).toBeLessThanOrEqual(1);
    expect(result.edgesProposed.length + result.reviewItems.length).toBeLessThanOrEqual(1);
  });
});

describe("runConsolidation - stale flag integration", () => {
  it("emits stale flags independently from cluster processing", () => {
    const stale = makeRecord({
      id: "m-stale",
      body: "old fact",
      validFrom: FIXED_NOW_MS - 10_000,
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

  it("skips non-accepted records instead of producing stale or review output for them", () => {
    const archived = makeRecord({
      id: "m-archived",
      body: "old fact",
      status: "archived",
      validFrom: FIXED_NOW_MS - 10_000,
      validUntil: FIXED_NOW_MS - 1,
    });
    const result = runConsolidation([archived], baseOptions());
    expect(result.state).toBe("skipped");
    expect(result.staleFlags).toEqual([]);
    expect(result.reviewItems).toEqual([]);
    expect(result.edgesProposed).toEqual([]);
  });
});

describe("runConsolidation - end-to-end mixed input", () => {
  it("populates all three result categories in one run and reports counters independently", () => {
    const stale = makeRecord({
      id: "m-stale",
      body: "stale fact",
      validFrom: FIXED_NOW_MS - 10_000,
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
    // RED reason (before fix): clustersInspected was computed as
    // `consumed.clustersInspected + conflictPairs.length`, mixing units. The dup pair
    // (m-da, m-db) forms 1 cluster; the conflict pair (m-co, m-cn) yields 1 conflictPair.
    // The old code inflated clustersInspected to 2. After the fix the two counters are separate.
    expect(result.clustersInspected).toBe(1);
    expect(result.conflictPairsDetected).toBe(1);
  });
});

describe("runConsolidation - elapsedMs is always 0 (pure layer)", () => {
  it("never computes wall-clock elapsed; caller does this at job-transition site", () => {
    const result = runConsolidation([], baseOptions());
    expect(result.elapsedMs).toBe(0);
  });
});

describe("runConsolidation - reserved summaryGenerator seam", () => {
  it("does not invoke summaryGenerator for two-member auto-edge duplicates", () => {
    let calls = 0;
    const older = makeRecord({ id: "m-old", body: "use tabs", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "use tabs", createdAt: 200 });
    const result = runConsolidation(
      [older, newer],
      baseOptions({
        summaryGenerator: () => {
          calls += 1;
          return "summary";
        },
      }),
    );
    expect(result.state).toBe("completed");
    expect(calls).toBe(0);
  });
});
