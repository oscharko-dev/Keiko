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

// The single-owner pin for run-digest ordering. The fixtures are the pairs that motivated the shared
// comparator: distinct strings a locale-aware collation is liable to report as equal (NFC vs NFD, a
// zero-width space, a soft hyphen), which leaves them in input order and cost two of the three run
// digests their order-independence.
//
// What is asserted is deliberately only the comparator's own contract — a strict total order, never
// 0 for distinct input. Whether THIS host's `localeCompare` actually collides on a given pair is a
// property of the runtime's ICU build and default locale, not of the contract under test, so
// measuring it here would make the suite fail on a small-icu Node while the production code stayed
// correct. That is the same host-dependence this comparator exists to remove (Qodo finding on
// PR #2756).
//
// Fixtures are escapes, not literal characters, so an editor or formatter that normalizes on save
// cannot quietly make them vacuous.
describe("compareFingerprintKeys", () => {
  it.each([
    ["NFC vs NFD", "caf\u00e9", "cafe\u0301"],
    ["zero-width space", "a\u200bb", "ab"],
    ["soft hyphen", "a\u00adb", "ab"],
  ])("separates %s regardless of host collation", (_case, left, right) => {
    expect(left).not.toBe(right);
    expect(compareFingerprintKeys(left, right)).not.toBe(0);
    // Antisymmetry: a comparator that is not strictly ordered here would let `sort` depend on the
    // order the pair arrived in, which is exactly the digest defect.
    expect(Math.sign(compareFingerprintKeys(right, left))).toBe(
      -Math.sign(compareFingerprintKeys(left, right)),
    );
  });

  it("is a total order agreeing with the default code-unit sort", () => {
    const values = ["b", "A", "a", "B", "0"];
    expect([...values].sort(compareFingerprintKeys)).toEqual([...values].sort());
    expect(compareFingerprintKeys("a", "a")).toBe(0);
  });

  // Pins the limit of the claim above rather than leaving it to be over-read later: code-unit order
  // is NOT byte order. `U+10000` encodes to four UTF-8 bytes and sorts above `U+E000` under SQLite's
  // BINARY collation, but below it here, because its UTF-16 form starts in the surrogate range.
  // Harmless for the digests — they re-sort their input, so no code path requires the two orderings
  // to coincide — and worth pinning so nobody "simplifies" the comparator toward a byte comparison
  // on the strength of an agreement that was never there.
  it("does not claim byte order: supplementary-plane keys invert against UTF-8", () => {
    expect(compareFingerprintKeys("\u{10000}", "\uE000")).toBeLessThan(0);
    expect(Buffer.compare(Buffer.from("\u{10000}", "utf8"), Buffer.from("\uE000", "utf8"))).toBe(1);
  });
});
