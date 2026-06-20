import { describe, expect, it } from "vitest";
import {
  computeLineStarts,
  offsetToPosition,
  positionToOffset,
  spanToRange,
} from "./textOffsets.js";

describe("computeLineStarts", () => {
  it("records the start of each line for LF, CRLF, and lone CR", () => {
    expect(computeLineStarts("a\nbb\n")).toEqual([0, 2, 5]);
    expect(computeLineStarts("a\r\nbb")).toEqual([0, 3]);
    expect(computeLineStarts("a\rb")).toEqual([0, 2]);
    expect(computeLineStarts("")).toEqual([0]);
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
    // Line 0 content is "const a = 1;" (12 chars); a character of 999 clamps to offset 12.
    expect(positionToOffset(text, starts, { line: 0, character: 999 })).toBe(12);
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
    // Line 0 content is "ab"; the lone CR at offset 2 must not be a valid character offset.
    expect(positionToOffset(loneCr, crStarts, { line: 0, character: 999 })).toBe(2);
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
