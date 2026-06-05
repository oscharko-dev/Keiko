import { describe, expect, it } from "vitest";

import { RECENCY_HALF_LIFE_MS, recencyScore } from "./recency.js";

describe("recencyScore", () => {
  it("returns 1.0 when updatedAt === nowMs", () => {
    expect(recencyScore(1_000, 1_000)).toBe(1);
  });

  it("returns 0.5 at one half-life of age", () => {
    expect(recencyScore(0, RECENCY_HALF_LIFE_MS)).toBeCloseTo(0.5, 10);
  });

  it("returns 0.25 at two half-lives of age", () => {
    expect(recencyScore(0, RECENCY_HALF_LIFE_MS * 2)).toBeCloseTo(0.25, 10);
  });

  it("returns 1.0 for future-dated memories (clamped)", () => {
    expect(recencyScore(2_000, 1_000)).toBe(1);
  });

  it("approaches 0 for very old memories but never goes negative", () => {
    const v = recencyScore(0, RECENCY_HALF_LIFE_MS * 100);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(0.001);
  });

  it("is monotonically non-increasing as age grows", () => {
    const now = 1_000_000;
    const a = recencyScore(now - 1_000, now);
    const b = recencyScore(now - 10_000, now);
    const c = recencyScore(now - 100_000, now);
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(c);
  });
});
