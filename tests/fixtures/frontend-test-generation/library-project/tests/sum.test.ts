// Expected unit-test patch shape for the `unit` style: a plain Vitest test of a library function,
// covering the empty, single, and multi-value paths. No DOM, no component idioms.
import { describe, expect, it } from "vitest";
import { sum } from "../src/sum.js";

describe("sum", () => {
  it("returns 0 for an empty list", () => {
    expect(sum([])).toBe(0);
  });

  it("returns the single value for a one-element list", () => {
    expect(sum([42])).toBe(42);
  });

  it("adds several values", () => {
    expect(sum([1, 2, 3])).toBe(6);
  });
});
