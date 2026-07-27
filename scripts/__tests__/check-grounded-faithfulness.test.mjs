import { describe, expect, it } from "vitest";

import { evaluateFaithfulnessFloors } from "../check-grounded-faithfulness.mjs";

function scorecard(overrides = {}) {
  return {
    fixtures: 1,
    unsupportedDetectionRate: 1,
    citationPrecision: 1,
    abstentionOnEmptyRate: 1,
    failures: [],
    ...overrides,
  };
}

const BUDGET = {
  minUnsupportedDetectionRate: 1,
  minCitationPrecision: 1,
  minAbstentionOnEmptyRate: 1,
};

describe("grounded-faithfulness floors", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails closed for a non-finite score (%s)",
    (value) => {
      expect(
        evaluateFaithfulnessFloors(scorecard({ unsupportedDetectionRate: value }), BUDGET),
      ).toEqual({
        ok: false,
        failures: ["unsupportedDetectionRate"],
      });
    },
  );

  it("retains scorer failures even when every numeric floor clears", () => {
    expect(
      evaluateFaithfulnessFloors(scorecard({ failures: ["bad-output-escaped"] }), BUDGET),
    ).toEqual({
      ok: false,
      failures: ["bad-output-escaped"],
    });
  });
});
