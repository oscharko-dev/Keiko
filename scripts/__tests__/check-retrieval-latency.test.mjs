import { describe, expect, it } from "vitest";

import { evaluateLatencyBudget, percentile } from "../check-retrieval-latency.mjs";

describe("percentile", () => {
  it("returns 0 for an empty sample set", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("computes the nearest-rank percentile (order-independent)", () => {
    const samples = [50, 10, 40, 20, 30];
    expect(percentile(samples, 100)).toBe(50);
    expect(percentile(samples, 95)).toBe(50);
    expect(percentile(samples, 50)).toBe(30);
    expect(percentile(samples, 1)).toBe(10);
  });

  it("clamps the rank into range", () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2], 0)).toBe(1);
  });
});

describe("evaluateLatencyBudget", () => {
  it("passes when observed is at or under the budget", () => {
    expect(evaluateLatencyBudget({ observedMs: 600, budgetMs: 3000 })).toEqual({
      ok: true,
      observedMs: 600,
      budgetMs: 3000,
    });
    expect(evaluateLatencyBudget({ observedMs: 3000, budgetMs: 3000 }).ok).toBe(true);
  });

  it("fails when observed exceeds the budget", () => {
    expect(evaluateLatencyBudget({ observedMs: 3001, budgetMs: 3000 }).ok).toBe(false);
  });
});
