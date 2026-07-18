import { describe, expect, it } from "vitest";

import {
  computeLineStarts,
  lineContentEnd,
  offsetToPosition,
  positionToOffset,
  spanToRange,
} from "./line-offsets.js";

describe("computeLineStarts", () => {
  it("records the start of each line for LF, CRLF, and lone CR", () => {
    expect(computeLineStarts("a\nbb\n")).toEqual([0, 2, 5]);
    expect(computeLineStarts("a\r\nbb")).toEqual([0, 3]);
    expect(computeLineStarts("a\rb")).toEqual([0, 2]);
    expect(computeLineStarts("")).toEqual([0]);
  });

  it("treats CRLF as a single terminator, not two line breaks", () => {
    // Two CRLF-terminated lines produce three conceptual lines, not four.
    expect(computeLineStarts("ab\r\ncd\r\n")).toEqual([0, 4, 8]);
  });
});

describe("positionToOffset", () => {
  const text = "const a = 1;\nconst b = 2;\n";
  const starts = computeLineStarts(text);

  it("maps a line/character to the absolute offset", () => {
    expect(positionToOffset(text, starts, { line: 0, character: 6 })).toBe(6);
    expect(positionToOffset(text, starts, { line: 1, character: 6 })).toBe(19);
  });

  it("clamps a character past the line content end onto the line, not the newline", () => {
    expect(positionToOffset(text, starts, { line: 0, character: 999 })).toBe(12);
  });

  it("clamps a negative character to the line start", () => {
    expect(positionToOffset(text, starts, { line: 1, character: -5 })).toBe(13);
  });

  it("clamps an out-of-range line into the buffer", () => {
    expect(positionToOffset(text, starts, { line: 99, character: 0 })).toBe(text.length);
  });

  it("clamps onto content, not the terminator, for CRLF and lone-CR line endings", () => {
    const crlf = "ab\r\ncde\r\n";
    const crlfStarts = computeLineStarts(crlf);
    // Line 0 content is "ab" (offsets 0-1); a past-content character clamps to 2, not the CR at 2.
    expect(positionToOffset(crlf, crlfStarts, { line: 0, character: 2 })).toBe(2);
    expect(positionToOffset(crlf, crlfStarts, { line: 0, character: 999 })).toBe(2);

    const loneCr = "ab\rcde\r";
    const crStarts = computeLineStarts(loneCr);
    expect(positionToOffset(loneCr, crStarts, { line: 0, character: 999 })).toBe(2);
  });
});

describe("lineContentEnd", () => {
  it("excludes an LF, a CRLF, and a lone CR terminator from the line content", () => {
    const lf = "ab\ncd";
    expect(lineContentEnd(lf, computeLineStarts(lf), 0)).toBe(2);
    const crlf = "ab\r\ncd";
    expect(lineContentEnd(crlf, computeLineStarts(crlf), 0)).toBe(2);
    const cr = "ab\rcd";
    expect(lineContentEnd(cr, computeLineStarts(cr), 0)).toBe(2);
  });
});

describe("offsetToPosition", () => {
  const text = "ab\ncde\nf";
  const starts = computeLineStarts(text);

  it("is the inverse of positionToOffset at line starts and mid-line", () => {
    expect(offsetToPosition(text, starts, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, starts, 3)).toEqual({ line: 1, character: 0 });
    expect(offsetToPosition(text, starts, 5)).toEqual({ line: 1, character: 2 });
    expect(offsetToPosition(text, starts, 7)).toEqual({ line: 2, character: 0 });
  });

  it("clamps a negative or oversized offset", () => {
    expect(offsetToPosition(text, starts, -5)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, starts, 999)).toEqual({ line: 2, character: 1 });
  });
});

describe("supplementary-plane characters (surrogate pairs)", () => {
  // A realistic multi-line buffer where a supplementary-plane character (😀, U+1F600 — two UTF-16
  // code units) sits mid-line, followed by more content and another line. LSP/editor positions are
  // always UTF-16-code-unit offsets, never codepoint indices, so every mapping here must treat the
  // emoji as occupying two `character` slots, exactly as `charCodeAt`-based scanning always did.
  const text = 'const a = 1;\nconst emoji = "😀";\nconst b = 2;\n';
  const starts = computeLineStarts(text);
  // Line 1 (`const emoji = "😀";`) starts at absolute offset 13. The opening quote is at character
  // 14, the emoji's two code units occupy characters 15-16, and the closing quote is at character 17.
  const emojiOffset = text.indexOf("😀");

  it("finds the correct line starts across a line that contains a surrogate pair", () => {
    expect(starts).toEqual([0, 13, 33, 46]);
    expect(emojiOffset).toBe(28);
  });

  it("maps a position landing right before the surrogate pair to its absolute offset", () => {
    expect(positionToOffset(text, starts, { line: 1, character: 15 })).toBe(emojiOffset);
  });

  it("maps a position landing right after the surrogate pair to its absolute offset", () => {
    // The closing quote follows the two-code-unit emoji, so it sits two characters past character 15.
    expect(positionToOffset(text, starts, { line: 1, character: 17 })).toBe(emojiOffset + 2);
    expect(text[emojiOffset + 2]).toBe('"');
  });

  it("round-trips offsets that land before, inside, and after the surrogate pair", () => {
    expect(offsetToPosition(text, starts, emojiOffset)).toEqual({ line: 1, character: 15 });
    // Landing between the two surrogate code units is still a valid UTF-16 offset; the mapping must
    // not skip it or collapse the pair into a single character slot.
    expect(offsetToPosition(text, starts, emojiOffset + 1)).toEqual({ line: 1, character: 16 });
    expect(offsetToPosition(text, starts, emojiOffset + 2)).toEqual({ line: 1, character: 17 });
  });

  it("excludes only the line terminator from content end on a line carrying a surrogate pair", () => {
    // Line 1 is `const emoji = "😀";` (19 UTF-16 code units, offsets 13-31), followed by "\n" at 32.
    expect(lineContentEnd(text, starts, 1)).toBe(32);
  });
});

describe("spanToRange", () => {
  const text = "ab\ncde\n";
  const starts = computeLineStarts(text);

  it("maps a start+length span to a range", () => {
    expect(spanToRange(text, starts, 4, 2)).toEqual({
      start: { line: 1, character: 1 },
      end: { line: 1, character: 3 },
    });
  });

  it("collapses a missing start to the buffer origin", () => {
    expect(spanToRange(text, starts, undefined, undefined)).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  });
});
