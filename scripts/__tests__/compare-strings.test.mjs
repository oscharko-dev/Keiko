import { describe, expect, it } from "vitest";

import { compareStrings } from "../lib/compare-strings.mjs";

describe("compareStrings", () => {
  it("returns -1, 0, 1 for less-than, equal, and greater-than", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "b")).toBe(0);
    expect(compareStrings("b", "a")).toBe(1);
  });

  it("reproduces the default Array#sort code-unit order exactly", () => {
    // Digit-bearing keys are the case a locale-aware comparator would reorder; the explicit
    // comparator must match a bare sort so canonical key-set equality checks keep passing.
    const keys = ["b10Bytes", "b2Bytes", "b1Bytes", "candidate", "baseline", "B", "a"];
    expect([...keys].sort(compareStrings)).toEqual([...keys].sort());
  });

  it("orders digit-bearing keys by code unit, not numerically", () => {
    expect(["b1", "b10", "b2"].sort(compareStrings)).toEqual(["b1", "b10", "b2"]);
  });
});
