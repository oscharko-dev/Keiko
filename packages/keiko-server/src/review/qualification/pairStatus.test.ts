// The pair status belongs to exactly one pair (Issue #4137, AC5): changing a role or the gateway
// configuration generation never carries a previous pair's status over to the new pair.

import { describe, expect, it } from "vitest";

import type { ReviewSeedScore } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { ReviewPairStatusRegistry } from "./pairStatus.js";

const SCORE: ReviewSeedScore = {
  defectCaseCount: 9,
  cleanControlCount: 3,
  found: 9,
  missed: 0,
  stale: 0,
  falseAlarms: 0,
  requiredCount: 9,
  requiredFound: 9,
  unmatchedResults: 0,
};
const PAIR = { reviewerModelId: "model-a", counterCheckerModelId: "model-b", generation: 7 };
const RECORD = {
  status: "seed-qualified",
  qualificationId: "pair-qualification-1",
  recordedAt: "2026-10-31T12:00:00.000Z",
  score: SCORE,
} as const;

describe("review pair status (AC5)", () => {
  it("reads unmeasured until the exact pair is qualified", () => {
    const registry = new ReviewPairStatusRegistry();
    expect(registry.status(PAIR)).toEqual({ status: "unmeasured" });
    registry.record(PAIR, RECORD);
    expect(registry.status(PAIR)).toEqual({ ...RECORD });
  });

  it.each([
    ["the Reviewer", { ...PAIR, reviewerModelId: "model-c" }],
    ["the Counter-checker", { ...PAIR, counterCheckerModelId: "model-c" }],
    [
      "the swapped roles",
      { ...PAIR, reviewerModelId: "model-b", counterCheckerModelId: "model-a" },
    ],
    ["the configuration generation", { ...PAIR, generation: 8 }],
    ["an unknown generation", { ...PAIR, generation: undefined }],
  ])("never carries the status over when %s changes", (_change, other) => {
    const registry = new ReviewPairStatusRegistry();
    registry.record(PAIR, RECORD);
    expect(registry.status(other)).toEqual({ status: "unmeasured" });
  });

  it("keeps the latest record of a pair and forgets the oldest pairs beyond its bound", () => {
    const registry = new ReviewPairStatusRegistry();
    registry.record(PAIR, RECORD);
    registry.record(PAIR, {
      ...RECORD,
      status: "seed-failed",
      qualificationId: "pair-qualification-2",
    });
    expect(registry.status(PAIR)).toMatchObject({ status: "seed-failed" });
    for (let generation = 100; generation < 170; generation += 1) {
      registry.record({ ...PAIR, generation }, RECORD);
    }
    expect(registry.status(PAIR)).toEqual({ status: "unmeasured" });
    expect(registry.status({ ...PAIR, generation: 169 }).status).toBe("seed-qualified");
  });
});
