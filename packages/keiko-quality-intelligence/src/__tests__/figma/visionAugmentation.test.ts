// Unit tests for vision-hint merge (Epic #750, Issue #754).
// The load-bearing invariant: vision augments, it NEVER overrides the structural baseline. These
// tests assert the baseline text is preserved verbatim and garbage hints are dropped.

import { describe, expect, it } from "vitest";

import { mergeVisionHints } from "../../domain/figma/visionAugmentation.js";

const BASELINE = "Screen: Login [s1]\nStructural test baseline:\n- (screen-render) renders";

describe("mergeVisionHints", () => {
  it("returns the baseline unchanged when there are no hints", () => {
    const result = mergeVisionHints(BASELINE, []);

    expect(result.text).toBe(BASELINE);
    expect(result.augmentedCount).toBe(0);
  });

  it("appends hints additively while preserving the baseline as a prefix (never overrides)", () => {
    const result = mergeVisionHints(BASELINE, ["The primary CTA is emphasised in brand colour"]);

    expect(result.text.startsWith(BASELINE)).toBe(true);
    expect(result.text).toContain("The primary CTA is emphasised in brand colour");
    expect(result.augmentedCount).toBe(1);
  });

  it("drops empty, whitespace-only, and over-long garbage hints", () => {
    const result = mergeVisionHints(BASELINE, ["", "   ", "x".repeat(10_000), "valid hint"]);

    expect(result.augmentedCount).toBe(1);
    expect(result.text).toContain("valid hint");
    expect(result.text).not.toContain("x".repeat(10_000));
  });

  it("returns the baseline unchanged when every hint is garbage", () => {
    const result = mergeVisionHints(BASELINE, ["", "  ", "y".repeat(9_999)]);

    expect(result.text).toBe(BASELINE);
    expect(result.augmentedCount).toBe(0);
  });

  it("de-duplicates hints and bounds the appended count", () => {
    const many = Array.from({ length: 100 }, (_, i) => `hint ${String(i % 3)}`);

    const result = mergeVisionHints(BASELINE, many);

    expect(result.augmentedCount).toBe(3);
  });

  it("never lets a hint remove or rewrite a baseline line", () => {
    const result = mergeVisionHints(BASELINE, ["- (screen-render) renders"]);

    // Even a hint that mimics a baseline line is appended below, leaving the baseline intact.
    expect(result.text.startsWith(BASELINE)).toBe(true);
  });

  // ─── MAX_HINT_CHARS boundary (mutation-robustness, Issue #754) ────────────────────────────────
  //
  // The existing tests feed 10 000-char hints, which kill the guard trivially (any threshold < 10 000
  // passes or fails together). These three cases pin the EXACT boundary so the mutation `>` → `>=`
  // or `>=` → `>` on the sanitiseHints length guard is caught immediately.

  it("keeps a hint of exactly MAX_HINT_CHARS (500) chars — pins the > boundary", () => {
    // A 500-char hint is at the limit and MUST be kept. If `>` were mutated to `>=`, this hint
    // would be dropped and augmentedCount would be 0, making both assertions fail.
    const atLimit = "a".repeat(500);

    const result = mergeVisionHints(BASELINE, [atLimit]);

    expect(result.augmentedCount).toBe(1);
    expect(result.text).toContain(atLimit);
  });

  it("drops a hint of exactly MAX_HINT_CHARS + 1 (501) chars — pins the strict > threshold", () => {
    // A 501-char hint is one over the limit and MUST be dropped. If `>` were mutated to `<`,
    // this hint would be kept and the baseline would no longer equal the result.
    const overLimit = "a".repeat(501);

    const result = mergeVisionHints(BASELINE, [overLimit]);

    expect(result.augmentedCount).toBe(0);
    expect(result.text).toBe(BASELINE);
  });

  it("caps output at exactly MAX_HINTS (24) items when 25 distinct valid hints are supplied", () => {
    // 25 unique short hints saturate the dedup/cap loop. If the `>= MAX_HINTS` guard were mutated
    // to `>`, 25 hints would pass (the break fires one iteration late) and augmentedCount would be
    // 25, not 24. If it were mutated to `> MAX_HINTS`, all 25 would pass and the cap is lost.
    const distinctHints = Array.from({ length: 25 }, (_, i) => `distinct hint ${String(i + 1)}`);

    const result = mergeVisionHints(BASELINE, distinctHints);

    expect(result.augmentedCount).toBe(24);
  });
});
