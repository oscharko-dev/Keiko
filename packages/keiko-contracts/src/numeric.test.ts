import { describe, expect, it } from "vitest";
import { clampUnit } from "./numeric.js";

describe("clampUnit (GEN-DUP-SEMANTIC-003)", () => {
  it("collapses NaN / -Infinity / negatives to 0", () => {
    expect(clampUnit(Number.NaN)).toBe(0);
    expect(clampUnit(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampUnit(-0.5)).toBe(0);
  });

  it("collapses Infinity and values >= 1 to 1", () => {
    expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampUnit(1.5)).toBe(1);
  });

  it("returns the boundary values 0 and 1 unchanged", () => {
    expect(clampUnit(0)).toBe(0);
    expect(clampUnit(1)).toBe(1);
  });

  it("returns interior values unchanged", () => {
    expect(clampUnit(0.37)).toBe(0.37);
  });
});
