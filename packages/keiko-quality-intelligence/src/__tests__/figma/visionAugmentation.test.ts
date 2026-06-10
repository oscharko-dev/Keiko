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
});
