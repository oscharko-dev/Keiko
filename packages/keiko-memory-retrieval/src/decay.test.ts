import { describe, expect, it } from "vitest";

import { exponentialDecay } from "./decay.js";

describe("exponentialDecay (#204, O-P2)", () => {
  const HL = 1000;
  it("is 1 at age 0 and clamps future-dated (negative age) to 1", () => {
    expect(exponentialDecay(0, HL)).toBe(1);
    expect(exponentialDecay(-500, HL)).toBe(1);
  });
  it("halves every half-life", () => {
    expect(exponentialDecay(HL, HL)).toBeCloseTo(0.5, 10);
    expect(exponentialDecay(2 * HL, HL)).toBeCloseTo(0.25, 10);
    expect(exponentialDecay(3 * HL, HL)).toBeCloseTo(0.125, 10);
  });
  it("stays within [0,1] for very large ages", () => {
    const v = exponentialDecay(1e12, HL);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
