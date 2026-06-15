// Unit tests for stripUnsafeFormatChars and normaliseCandidateText (Issue #724).
//
// Each test kills a specific real mutant: removing one code-point range from the
// strip set would leave at least one assertion RED. Tautology check: every unsafe
// code point is constructed from String.fromCodePoint so the test literally embeds
// the character it wants stripped — the assertion fails RED if that character
// survives.

import { describe, expect, it } from "vitest";

import {
  isUnsafeFormatCodePoint,
  normaliseCandidateText,
  stripUnsafeFormatChars,
} from "../domain/assertions.js";

// ─── Helper ────────────────────────────────────────────────────────────────────

/** Build a one-char string from a code point; fail fast if the point is invalid. */
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

/** True when no code point in `s` is in the unsafe set. */
const hasNoUnsafeChar = (s: string): boolean => {
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isUnsafeFormatCodePoint(code)) return false;
  }
  return true;
};

// ─── stripUnsafeFormatChars — bidi overrides ─────────────────────────────────

describe("stripUnsafeFormatChars — bidi overrides", () => {
  it("strips RLO U+202E (kills: omit 0x202A-0x202E range)", () => {
    // Mutant: remove the 0x202a–0x202e range check → RLO survives → test RED.
    const dirty = `before${cp(0x202e)}after`;
    const result = stripUnsafeFormatChars(dirty);
    expect(result).toBe("beforeafter");
    expect(result).not.toContain(cp(0x202e));
  });

  it("strips LRE U+202A (kills: swap range boundary to 0x202B)", () => {
    const dirty = `a${cp(0x202a)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips PDF U+202C (kills: off-by-one on range end)", () => {
    const dirty = `a${cp(0x202c)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips LRO U+202D (kills: narrow range to 202A–202C only)", () => {
    const dirty = `a${cp(0x202d)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips all four bidi isolates U+2066–U+2069 (kills: omit isolate range)", () => {
    for (let code = 0x2066; code <= 0x2069; code++) {
      const dirty = `x${cp(code)}y`;
      const result = stripUnsafeFormatChars(dirty);
      expect(result, `U+${code.toString(16).toUpperCase()} must be stripped`).toBe("xy");
    }
  });

  it("strips LRM U+200E and RLM U+200F (kills: omit LRM/RLM check)", () => {
    expect(stripUnsafeFormatChars(`a${cp(0x200e)}b`)).toBe("ab");
    expect(stripUnsafeFormatChars(`a${cp(0x200f)}b`)).toBe("ab");
  });

  it("strips Arabic letter mark U+061C (kills: omit ALM check)", () => {
    const dirty = `a${cp(0x061c)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });
});

// ─── stripUnsafeFormatChars — zero-width and BOM ─────────────────────────────

describe("stripUnsafeFormatChars — zero-width and BOM", () => {
  it("strips ZWSP U+200B (kills: omit 0x200B-0x200D range)", () => {
    const dirty = `a${cp(0x200b)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips ZWNJ U+200C (kills: narrow range to 200B only)", () => {
    const dirty = `a${cp(0x200c)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips ZWJ U+200D (kills: narrow range to 200B–200C only)", () => {
    const dirty = `a${cp(0x200d)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips BOM / ZWNBSP U+FEFF (kills: omit BOM check)", () => {
    const dirty = `${cp(0xfeff)}hello`;
    expect(stripUnsafeFormatChars(dirty)).toBe("hello");
  });
});

// ─── stripUnsafeFormatChars — C0/C1/DEL controls ─────────────────────────────

describe("stripUnsafeFormatChars — C0/C1/DEL controls", () => {
  it("strips NUL U+0000 (kills: omit C0 range entirely)", () => {
    const dirty = `a${cp(0x0000)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips BEL U+0007 (kills: C0 check starts at 0x0008)", () => {
    const dirty = `a${cp(0x0007)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips DEL U+007F (kills: omit DEL check)", () => {
    const dirty = `a${cp(0x007f)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips a C1 control U+0085 (NEL) (kills: omit C1 range)", () => {
    const dirty = `a${cp(0x0085)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips first C1 control U+0080 (kills: C1 range starts at 0x0081)", () => {
    const dirty = `a${cp(0x0080)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });

  it("strips last C1 control U+009F (kills: C1 range ends at 0x009E)", () => {
    const dirty = `a${cp(0x009f)}b`;
    expect(stripUnsafeFormatChars(dirty)).toBe("ab");
  });
});

// ─── stripUnsafeFormatChars — legitimate characters preserved ─────────────────

describe("stripUnsafeFormatChars — legitimate characters preserved", () => {
  it("preserves TAB U+0009 (kills: accidentally strip TAB)", () => {
    expect(stripUnsafeFormatChars("a\tb")).toBe("a\tb");
  });

  it("preserves LF U+000A (kills: accidentally strip LF)", () => {
    expect(stripUnsafeFormatChars("a\nb")).toBe("a\nb");
  });

  it("preserves CR U+000D (kills: accidentally strip CR)", () => {
    expect(stripUnsafeFormatChars("a\rb")).toBe("a\rb");
  });

  it("preserves accented Latin text (kills: overly broad strip of non-ASCII)", () => {
    expect(stripUnsafeFormatChars("café résumé naïve")).toBe("café résumé naïve");
  });

  it("preserves CJK characters (kills: overly broad non-ASCII strip)", () => {
    expect(stripUnsafeFormatChars("日本語テスト")).toBe("日本語テスト");
  });

  it("preserves emoji with surrogate pairs (kills: broken code-unit iteration)", () => {
    // U+1F600 GRINNING FACE — encoded as a surrogate pair in UTF-16
    const emoji = "\u{1F600}";
    expect(stripUnsafeFormatChars(`hello ${emoji}`)).toBe(`hello ${emoji}`);
  });

  it("returns the empty string unchanged", () => {
    expect(stripUnsafeFormatChars("")).toBe("");
  });

  it("returns clean ASCII text unchanged", () => {
    const text = "Navigate to /login and submit the form.";
    expect(stripUnsafeFormatChars(text)).toBe(text);
  });
});

// ─── normaliseCandidateText ──────────────────────────────────────────────────

describe("normaliseCandidateText", () => {
  it("returns empty string for undefined (kills: remove undefined guard)", () => {
    expect(normaliseCandidateText(undefined)).toBe("");
  });

  it("applies NFKC: fullwidth '１' → '1' (kills: omit NFKC normalisation)", () => {
    // U+FF11 FULLWIDTH DIGIT ONE normalises to '1' under NFKC.
    expect(normaliseCandidateText("１２３")).toBe("123");
  });

  it("strips bidi override after NFKC (kills: strip before NFKC so NFKC reintroduces)", () => {
    // RLO inserted between NFKC-stable chars — survives NFKC, must be stripped after.
    const dirty = `hello${cp(0x202e)}world`;
    expect(normaliseCandidateText(dirty)).toBe("helloworld");
  });

  it("trims leading/trailing whitespace (kills: omit trim call)", () => {
    expect(normaliseCandidateText("  hello  ")).toBe("hello");
  });

  it("result contains no unsafe code points end-to-end (kills: omit stripUnsafeFormatChars)", () => {
    const dirty = [
      cp(0x202e), // RLO
      cp(0x200b), // ZWSP
      cp(0x0000), // NUL
      cp(0x007f), // DEL
      cp(0xfeff), // BOM
      cp(0x2066), // LRI
    ].join("hello");
    expect(hasNoUnsafeChar(normaliseCandidateText(dirty))).toBe(true);
  });
});
