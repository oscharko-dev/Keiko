import { describe, expect, it } from "vitest";

import { binaryNdcgAtK, mean } from "./metrics.js";

describe("evaluation metrics", () => {
  it("computes a deterministic mean with a zero-valued empty case", () => {
    expect(mean([])).toBe(0);
    expect(mean([0, 0.5, 1])).toBe(0.5);
  });

  it("normalizes binary nDCG and preserves the no-relevance convention", () => {
    expect(binaryNdcgAtK(["a", "b"], ["a", "b"], 2)).toBe(1);
    expect(binaryNdcgAtK(["x", "a"], ["a"], 2)).toBeCloseTo(1 / Math.log2(3), 6);
    expect(binaryNdcgAtK(["x"], [], 5)).toBe(1);
  });

  it("bounds nDCG to the requested prefix", () => {
    expect(binaryNdcgAtK(["x", "a"], ["a"], 1)).toBe(0);
    expect(binaryNdcgAtK(["a"], ["a"], 0)).toBe(1);
  });
});
