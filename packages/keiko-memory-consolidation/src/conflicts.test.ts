import { describe, expect, it } from "vitest";

import { FIXED_NOW_MS, makeIdFactory, makeRecord, must } from "./_support.js";
import { detectConflicts, type ConflictsOptions } from "./conflicts.js";
import type { DuplicateCluster } from "./dedupe.js";

function options(): ConflictsOptions {
  return {
    nowMs: FIXED_NOW_MS,
    newReviewItemId: makeIdFactory("rv"),
  };
}

function cluster(canonicalId: string, members: ReturnType<typeof makeRecord>[]): DuplicateCluster {
  return { canonicalId, members };
}

describe("detectConflicts - multi-way duplicate (cluster size > 2)", () => {
  it("emits exactly one merge review item per 3+ member cluster", () => {
    const a = makeRecord({ id: "m-a", body: "same body", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "same body", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "same body", createdAt: 300 });
    const items = detectConflicts([cluster("m-a", [a, b, c])], options());
    expect(items).toHaveLength(1);
    const item = must(items[0]);
    expect(item.reason).toBe("multi-way-duplicate");
    expect(item.relatedMemoryIds).toEqual(["m-a", "m-b", "m-c"]);
    // Winner is the newest (c, createdAt 300); losers are the older ones.
    expect(item.proposedAction).toEqual({ kind: "merge", winner: "m-c", losers: ["m-a", "m-b"] });
  });

  it("does NOT emit a multi-way review item for a 2-member cluster (handled as edge)", () => {
    const a = makeRecord({ id: "m-a", body: "x", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "x", createdAt: 200 });
    const items = detectConflicts([cluster("m-a", [a, b])], options());
    expect(items.filter((i) => i.reason === "multi-way-duplicate")).toEqual([]);
  });
});

describe("detectConflicts - potential conflict (2-member negation pair)", () => {
  it("emits one supersede review item when older affirms and newer negates the same subject", () => {
    const older = makeRecord({ id: "m-old", body: "the build uses tabs", createdAt: 100 });
    const newer = makeRecord({
      id: "m-new",
      body: "the build does not use tabs",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, newer])], options());
    const conflicts = items.filter((i) => i.reason === "potential-conflict");
    expect(conflicts).toHaveLength(1);
    expect(must(conflicts[0]).proposedAction).toEqual({
      kind: "supersede",
      newer: "m-new",
      older: "m-old",
    });
  });

  it("detects contraction negation (n't)", () => {
    const older = makeRecord({ id: "m-old", body: "we deploy on Friday", createdAt: 100 });
    const newer = makeRecord({
      id: "m-new",
      body: "we don't deploy on Friday",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, newer])], options());
    expect(items.map((i) => i.reason)).toContain("potential-conflict");
  });

  it("does NOT emit a conflict review item for a 2-member non-negating cluster", () => {
    const a = makeRecord({ id: "m-a", body: "user likes tabs", createdAt: 100 });
    const b = makeRecord({
      id: "m-b",
      body: "user likes tabs in the build",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-a", [a, b])], options());
    expect(items.filter((i) => i.reason === "potential-conflict")).toEqual([]);
  });

  it("does NOT emit a conflict for a multi-way cluster (multi-way takes precedence)", () => {
    const older = makeRecord({ id: "m-old", body: "we use tabs", createdAt: 100 });
    const middle = makeRecord({ id: "m-mid", body: "we use tabs", createdAt: 150 });
    const newer = makeRecord({
      id: "m-new",
      body: "we do not use tabs",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, middle, newer])], options());
    expect(items.map((i) => i.reason)).toEqual(["multi-way-duplicate"]);
  });

  it("does NOT emit a conflict when both members carry the same negation polarity", () => {
    const a = makeRecord({ id: "m-a", body: "we do not deploy on Friday", createdAt: 100 });
    const b = makeRecord({
      id: "m-b",
      body: "we do not deploy on Friday at all",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-a", [a, b])], options());
    expect(items.filter((i) => i.reason === "potential-conflict")).toEqual([]);
  });
});

describe("detectConflicts - deterministic output", () => {
  it("emits ids drawn from the newReviewItemId factory in order", () => {
    const a = makeRecord({ id: "m-a", body: "x", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "x", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "x", createdAt: 300 });
    const d = makeRecord({ id: "m-d", body: "y", createdAt: 100 });
    const e = makeRecord({ id: "m-e", body: "y", createdAt: 200 });
    const f = makeRecord({ id: "m-f", body: "y", createdAt: 300 });
    const items = detectConflicts(
      [cluster("m-a", [a, b, c]), cluster("m-d", [d, e, f])],
      options(),
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["rv-1", "rv-2"]);
  });

  it("returns the same items for the same input twice", () => {
    const older = makeRecord({ id: "m-old", body: "uses tabs", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "does not use tabs", createdAt: 200 });
    const input = [cluster("m-old", [older, newer])];
    expect(detectConflicts(input, options())).toEqual(detectConflicts(input, options()));
  });
});
