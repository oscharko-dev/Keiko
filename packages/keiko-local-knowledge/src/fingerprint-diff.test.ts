// Shared fingerprint-diff engine tests (Issue #2242): the single change-classification
// implementation behind both the #1856 manual refresh (moves on) and connector sync (moves off).

import { describe, expect, it } from "vitest";
import { compareFingerprintKeys, diffFingerprintSets } from "./fingerprint-diff.js";

function fingerprintMap(entries: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe("diffFingerprintSets", () => {
  it("classifies added, changed, removed, and unchanged keys", () => {
    const prior = fingerprintMap({ a: "f1", b: "f2", c: "f3" });
    const next = fingerprintMap({ a: "f1", b: "f2-changed", d: "f4" });
    expect(diffFingerprintSets(prior, next, { detectMoves: false })).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      moved: 0,
      unchanged: 1,
    });
  });

  it("handles empty prior (all added) and empty next (all removed)", () => {
    expect(
      diffFingerprintSets(fingerprintMap({}), fingerprintMap({ a: "f1" }), { detectMoves: true }),
    ).toEqual({ added: 1, changed: 0, removed: 0, moved: 0, unchanged: 0 });
    expect(
      diffFingerprintSets(fingerprintMap({ a: "f1" }), fingerprintMap({}), { detectMoves: true }),
    ).toEqual({ added: 0, changed: 0, removed: 1, moved: 0, unchanged: 0 });
  });

  it("correlates a same-content relocation as one move when detectMoves is on", () => {
    const prior = fingerprintMap({ "old/path": "same" });
    const next = fingerprintMap({ "new/path": "same" });
    expect(diffFingerprintSets(prior, next, { detectMoves: true })).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      moved: 1,
      unchanged: 0,
    });
  });

  it("counts the same relocation as removed + added when detectMoves is off (stable provider ids)", () => {
    const prior = fingerprintMap({ "confluence:c:1": "same" });
    const next = fingerprintMap({ "confluence:c:2": "same" });
    expect(diffFingerprintSets(prior, next, { detectMoves: false })).toEqual({
      added: 1,
      changed: 0,
      removed: 1,
      moved: 0,
      unchanged: 0,
    });
  });

  it("never lets two new keys claim the same removed key as a move", () => {
    const prior = fingerprintMap({ gone: "dup" });
    const next = fingerprintMap({ "new-1": "dup", "new-2": "dup" });
    expect(diffFingerprintSets(prior, next, { detectMoves: true })).toEqual({
      added: 1,
      changed: 0,
      removed: 0,
      moved: 1,
      unchanged: 0,
    });
  });
});

// The single-owner pin for run-digest ordering. Every case below is a pair of DISTINCT strings that
// `String.localeCompare` reports as equal (0); a comparator that returns 0 leaves the pair in input
// order, which is what made two of the three run digests order-sensitive. Fixtures are escapes, not
// literal characters, so an editor or formatter that normalizes on save cannot quietly make them
// vacuous.
describe("compareFingerprintKeys", () => {
  it.each([
    ["NFC vs NFD", "caf\u00e9", "cafe\u0301"],
    ["zero-width space", "a\u200bb", "ab"],
    ["soft hyphen", "a\u00adb", "ab"],
  ])("separates %s, which locale collation reports as equal", (_case, left, right) => {
    expect(left.localeCompare(right)).toBe(0);
    expect(compareFingerprintKeys(left, right)).not.toBe(0);
  });

  it("is a total order agreeing with the default sort and SQLite BINARY collation", () => {
    const values = ["b", "A", "a", "B", "0"];
    expect([...values].sort(compareFingerprintKeys)).toEqual([...values].sort());
    expect(compareFingerprintKeys("a", "a")).toBe(0);
  });
});
