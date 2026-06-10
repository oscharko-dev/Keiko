// Tests for testQualityRubric domain helpers (Epic #736, Issue #746).

import { describe, expect, it } from "vitest";

import {
  scoreFromDimensions,
  verdictFromScore,
  TEST_QUALITY_WEAK_THRESHOLD,
} from "../domain/testQualityRubric.js";
import type { TestQualityRubricDimension } from "@oscharko-dev/keiko-contracts";

function makeDim(
  name: TestQualityRubricDimension["name"],
  score: number,
): TestQualityRubricDimension {
  return { name, score, rationale: "test rationale" };
}

describe("scoreFromDimensions", () => {
  it("returns 0 for an empty dimensions array", () => {
    expect(scoreFromDimensions([])).toBe(0);
  });

  it("returns the single score for a one-dimension array", () => {
    expect(scoreFromDimensions([makeDim("verifiability", 70)])).toBe(70);
  });

  it("returns the mean of four equal scores", () => {
    const dims = [
      makeDim("verifiability", 80),
      makeDim("atomicity", 80),
      makeDim("determinism", 80),
      makeDim("ac-fidelity", 80),
    ];
    expect(scoreFromDimensions(dims)).toBe(80);
  });

  it("returns the correct mean for unequal scores", () => {
    const dims = [
      makeDim("verifiability", 100),
      makeDim("atomicity", 0),
      makeDim("determinism", 50),
      makeDim("ac-fidelity", 50),
    ];
    expect(scoreFromDimensions(dims)).toBe(50);
  });

  it("is deterministic regardless of iteration order", () => {
    const dims1 = [makeDim("verifiability", 40), makeDim("atomicity", 80)];
    const dims2 = [makeDim("atomicity", 80), makeDim("verifiability", 40)];
    expect(scoreFromDimensions(dims1)).toBe(scoreFromDimensions(dims2));
  });
});

describe("verdictFromScore", () => {
  it("returns 'weak' for score strictly below threshold (59)", () => {
    expect(verdictFromScore(59)).toBe("weak");
  });

  it("returns 'strong' for score at the threshold (60)", () => {
    expect(verdictFromScore(TEST_QUALITY_WEAK_THRESHOLD)).toBe("strong");
  });

  it("returns 'strong' for score above threshold (61)", () => {
    expect(verdictFromScore(61)).toBe("strong");
  });

  it("returns 'weak' for score 0", () => {
    expect(verdictFromScore(0)).toBe("weak");
  });

  it("returns 'strong' for score 100", () => {
    expect(verdictFromScore(100)).toBe("strong");
  });

  it("returns 'weak' for score 1 below threshold", () => {
    expect(verdictFromScore(TEST_QUALITY_WEAK_THRESHOLD - 1)).toBe("weak");
  });
});
