import { describe, expect, it } from "vitest";

import { compareStrings } from "./comparators.js";

describe("compareStrings", () => {
  it("returns -1 when left sorts before right", () => {
    expect(compareStrings("a", "b")).toBe(-1);
  });

  it("returns 1 when left sorts after right", () => {
    expect(compareStrings("b", "a")).toBe(1);
  });

  it("returns 0 for equal strings", () => {
    expect(compareStrings("same", "same")).toBe(0);
  });

  it("returns 0 for two empty strings", () => {
    expect(compareStrings("", "")).toBe(0);
  });

  it("orders the empty string before any non-empty string", () => {
    expect(compareStrings("", "a")).toBe(-1);
    expect(compareStrings("a", "")).toBe(1);
  });

  it("compares by UTF-16 code unit, not locale collation", () => {
    // Locale-aware comparison would sort "b2" before "b10"; plain code-unit comparison must not.
    expect(compareStrings("b2", "b10")).toBe(1);
    expect(compareStrings("b10", "b2")).toBe(-1);
  });

  it("produces a stable total order when used to sort an array", () => {
    const input = ["banana", "apple", "cherry", "apple"];
    expect([...input].sort(compareStrings)).toEqual(["apple", "apple", "banana", "cherry"]);
  });
});
