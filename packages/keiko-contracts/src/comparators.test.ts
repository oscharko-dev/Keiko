import { describe, expect, it } from "vitest";

import { compareStrings } from "./comparators.js";
import { compareStrings as compareStringsFromEntrypoint } from "@oscharko-dev/keiko-contracts";

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

// Entrypoint coverage (Qodo #3655429860, issue #2723): the tests above exercise the
// implementation module directly. This proves compareStrings is actually reachable through the
// package's public export surface (`@oscharko-dev/keiko-contracts`), not just internally. The
// entrypoint resolves to the built `dist/` output rather than this `src/` module, so the two
// imports are distinct function instances by design — this asserts behavioral equivalence rather
// than reference equality.
describe("compareStrings (public entrypoint)", () => {
  it("is exported from the package entrypoint and orders strings the same way", () => {
    expect(compareStringsFromEntrypoint("a", "b")).toBe(-1);
    expect(compareStringsFromEntrypoint("b", "a")).toBe(1);
    expect(compareStringsFromEntrypoint("same", "same")).toBe(0);
  });

  it("agrees with the implementation-module export across representative inputs", () => {
    for (const [left, right] of [
      ["a", "b"],
      ["b", "a"],
      ["same", "same"],
      ["", ""],
      ["", "a"],
      ["b2", "b10"],
    ] as const) {
      expect(compareStringsFromEntrypoint(left, right)).toBe(compareStrings(left, right));
    }
  });
});
