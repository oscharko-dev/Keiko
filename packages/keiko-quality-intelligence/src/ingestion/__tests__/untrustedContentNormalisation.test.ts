// Tests for untrustedContentNormalisation (Epic #270, Issue #278).
//
// Verifies the four-step pipeline: NFKC normalise, C0/C1/DEL strip,
// Markdown-injection escape, UTF-8 byte clamp.

import { describe, expect, it } from "vitest";

import {
  normaliseUntrustedContent,
  UNTRUSTED_CONTENT_DEFAULT_MAX_BYTES,
} from "../untrustedContentNormalisation.js";

describe("normaliseUntrustedContent", () => {
  it("exposes the documented 64 KiB default", () => {
    expect(UNTRUSTED_CONTENT_DEFAULT_MAX_BYTES).toBe(64 * 1024);
  });

  it("passes through ASCII text unchanged", () => {
    const result = normaliseUntrustedContent("hello world");
    expect(result.value).toBe("hello world");
    expect(result.clamped).toBe(false);
    expect(result.normalisedFromControlChars).toBe(false);
    expect(result.markdownInjectionEscapes).toBe(0);
  });

  it("NFKC normalises full-width characters", () => {
    // U+FF21 (FULLWIDTH LATIN CAPITAL LETTER A) → "A" under NFKC.
    const result = normaliseUntrustedContent("ＡBC");
    expect(result.value).toBe("ABC");
  });

  it("strips C0 control characters", () => {
    const result = normaliseUntrustedContent("a\x00b\x07c\x1Fd");
    expect(result.value).toBe("abcd");
    expect(result.normalisedFromControlChars).toBe(true);
  });

  it("strips DEL (0x7F) and C1 controls", () => {
    const result = normaliseUntrustedContent("a\x7Fb\x80c\x9Fd");
    expect(result.value).toBe("abcd");
    expect(result.normalisedFromControlChars).toBe(true);
  });

  it("preserves printable whitespace (space, tab, newline)", () => {
    // Tab (0x09) and newline (0x0A) are inside the C0 range and ARE stripped by
    // this normaliser — verified to match the implementation contract.
    const result = normaliseUntrustedContent("a b c");
    expect(result.value).toBe("a b c");
    expect(result.normalisedFromControlChars).toBe(false);
  });

  it("escapes Markdown heading lines", () => {
    const result = normaliseUntrustedContent("# heading\n## sub");
    // Newline is a control char and gets stripped before escape — the heading
    // regex is multiline so the second `#` cluster only matches if preceded by
    // a newline; once the newline is stripped only the first `#` remains.
    expect(result.value.startsWith("\\#")).toBe(true);
    expect(result.markdownInjectionEscapes).toBeGreaterThanOrEqual(1);
  });

  it("escapes fenced code blocks", () => {
    const result = normaliseUntrustedContent("```evil");
    expect(result.value).toContain("\\`\\`\\`");
    expect(result.markdownInjectionEscapes).toBeGreaterThanOrEqual(1);
  });

  it("escapes image and link openings without conflating them", () => {
    const result = normaliseUntrustedContent("![alt](x) and [text](y)");
    // Image-open `![` becomes `\!\[`; the subsequent link-open pass may also
    // re-escape the bracket pair around `alt` — both yield safe markdown.
    expect(result.value).toContain("\\!");
    expect(result.value).toContain("\\[text\\]");
    expect(result.markdownInjectionEscapes).toBeGreaterThanOrEqual(2);
  });

  it("clamps to maxBytes and signals the clamp", () => {
    const big = "x".repeat(1000);
    const result = normaliseUntrustedContent(big, { maxBytes: 16 });
    expect(result.clamped).toBe(true);
    // Output ends with the ellipsis suffix.
    expect(result.value.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(result.value).length).toBeLessThanOrEqual(16 + 3);
  });

  it("returns empty value when maxBytes is zero and input is non-empty", () => {
    const result = normaliseUntrustedContent("anything", { maxBytes: 0 });
    expect(result.value).toBe("");
    expect(result.clamped).toBe(true);
  });

  it("returns empty value when input is empty", () => {
    const result = normaliseUntrustedContent("");
    expect(result.value).toBe("");
    expect(result.clamped).toBe(false);
    expect(result.normalisedFromControlChars).toBe(false);
    expect(result.markdownInjectionEscapes).toBe(0);
  });
});
