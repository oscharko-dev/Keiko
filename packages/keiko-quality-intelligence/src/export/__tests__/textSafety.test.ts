// Inline-field sanitiser tests (Epic #711, Issue #720).
//
// `inlineField` is the shared structural folder the Markdown and plain-text serializers depend on:
// it collapses every line-breaking / tab whitespace run to a single space so a field renders as one
// logical unit. The adapter tests only exercise CR/LF/TAB; this file pins EVERY whitespace class the
// folding regex claims, so dropping any single class from the character class fails a test.

import { describe, expect, it } from "vitest";
import { inlineField, inlineFields } from "../textSafety.js";

describe("inlineField", () => {
  // One row per code point in the LINE_BREAKING_RUN character class. A mutation that drops any
  // single class from the regex makes its row fail (folded value would still contain the raw char).
  it.each([
    ["CR (U+000D)", "\r"],
    ["LF (U+000A)", "\n"],
    ["TAB (U+0009)", "\t"],
    ["VT (U+000B)", "\u000b"],
    ["FF (U+000C)", "\f"],
    ["NEL (U+0085)", "\u0085"],
    ["LS (U+2028)", "\u2028"],
    ["PS (U+2029)", "\u2029"],
  ])("folds a single %s into one space", (_label, ch) => {
    expect(inlineField(`a${ch}b`)).toBe("a b");
  });

  it("collapses a MIXED run of line-breaks to exactly one space (run-collapse, not per-char)", () => {
    // Pins the `+` quantifier: without it each char would fold separately → "a    b".
    expect(inlineField("a\r\n\t  \fb")).toBe("a b");
  });

  it("folds multiple separate runs each to a single space", () => {
    expect(inlineField("a\nb\tc")).toBe("a b c");
  });

  it("leaves ordinary spaces and non-ASCII text untouched", () => {
    // Pins that the replacement target is a space, not empty, and that the class does not
    // over-match ordinary spaces or accented / em-dash characters.
    expect(inlineField("a b  café — naïve")).toBe("a b  café — naïve");
  });

  it("returns an empty string unchanged", () => {
    expect(inlineField("")).toBe("");
  });

  it("preserves a value with no line-breaking whitespace verbatim", () => {
    expect(inlineField("Login succeeds with valid credentials")).toBe(
      "Login succeeds with valid credentials",
    );
  });
});

describe("inlineFields", () => {
  it("applies inlineField across every element of the list", () => {
    expect(inlineFields(["a\nb", "c\td", "plain"])).toEqual(["a b", "c d", "plain"]);
  });

  it("returns an empty array for an empty list", () => {
    expect(inlineFields([])).toEqual([]);
  });
});
