import { describe, expect, it } from "vitest";

import {
  comparePositions,
  isEmptyRange,
  mapPositionAfterEdit,
  mapRangeAfterEdit,
  rangeContainsPosition,
} from "./range.js";
import type { EditorPosition, EditorRange, EditorTextEdit } from "./types.js";

const pos = (line: number, column: number): EditorPosition => ({ line, column });
const range = (sl: number, sc: number, el: number, ec: number): EditorRange => ({
  start: pos(sl, sc),
  end: pos(el, ec),
});

describe("comparePositions", () => {
  it("orders by line first, then column", () => {
    expect(comparePositions(pos(1, 5), pos(2, 0))).toBe(-1);
    expect(comparePositions(pos(2, 0), pos(1, 5))).toBe(1);
    expect(comparePositions(pos(3, 1), pos(3, 9))).toBe(-1);
    expect(comparePositions(pos(3, 9), pos(3, 1))).toBe(1);
    expect(comparePositions(pos(4, 7), pos(4, 7))).toBe(0);
  });
});

describe("isEmptyRange", () => {
  it("is true only when start equals end", () => {
    expect(isEmptyRange(range(2, 3, 2, 3))).toBe(true);
    expect(isEmptyRange(range(2, 3, 2, 4))).toBe(false);
    expect(isEmptyRange(range(2, 3, 3, 3))).toBe(false);
  });
});

describe("rangeContainsPosition", () => {
  const r = range(1, 2, 3, 4);

  it("includes both boundaries", () => {
    expect(rangeContainsPosition(r, pos(1, 2))).toBe(true);
    expect(rangeContainsPosition(r, pos(3, 4))).toBe(true);
  });

  it("includes interior positions", () => {
    expect(rangeContainsPosition(r, pos(2, 0))).toBe(true);
  });

  it("excludes positions outside the range", () => {
    expect(rangeContainsPosition(r, pos(1, 1))).toBe(false);
    expect(rangeContainsPosition(r, pos(3, 5))).toBe(false);
    expect(rangeContainsPosition(r, pos(0, 9))).toBe(false);
    expect(rangeContainsPosition(r, pos(4, 0))).toBe(false);
  });
});

describe("mapPositionAfterEdit", () => {
  it("leaves a position at or before the edit start unchanged", () => {
    const edit: EditorTextEdit = { range: range(2, 4, 2, 8), newText: "abc" };
    expect(mapPositionAfterEdit(pos(0, 0), edit)).toEqual(pos(0, 0));
    expect(mapPositionAfterEdit(pos(2, 4), edit)).toEqual(pos(2, 4));
    expect(mapPositionAfterEdit(pos(2, 3), edit)).toEqual(pos(2, 3));
  });

  it("collapses a position inside the edit to the end of the inserted text", () => {
    // newText is 3 chars so insertedEnd (col 4+3=7) diverges from every probed input: a deleted
    // collapse branch that fell through to the shift path would return a different value.
    const edit: EditorTextEdit = { range: range(2, 4, 2, 10), newText: "xyz" };
    expect(mapPositionAfterEdit(pos(2, 6), edit)).toEqual(pos(2, 7));
    expect(mapPositionAfterEdit(pos(2, 10), edit)).toEqual(pos(2, 7));
  });

  it("treats a zero-width (caret) insertion: position at the caret is unchanged, after it shifts", () => {
    const edit: EditorTextEdit = { range: range(2, 5, 2, 5), newText: "hello" };
    expect(mapPositionAfterEdit(pos(2, 5), edit)).toEqual(pos(2, 5));
    expect(mapPositionAfterEdit(pos(2, 6), edit)).toEqual(pos(2, 11));
  });

  it("shifts a position after the edit on the same line as the edit end", () => {
    const edit: EditorTextEdit = { range: range(2, 4, 2, 8), newText: "ab" };
    // replaced columns 4..8 (width 4) with 2 chars => columns after shift left by 2.
    expect(mapPositionAfterEdit(pos(2, 12), edit)).toEqual(pos(2, 10));
  });

  it("shifts a position on a later line by the inserted line delta", () => {
    const edit: EditorTextEdit = { range: range(2, 4, 2, 8), newText: "ab" };
    expect(mapPositionAfterEdit(pos(5, 3), edit)).toEqual(pos(5, 3));
  });

  it("handles a multi-line insertion for same-line and later-line positions", () => {
    const edit: EditorTextEdit = { range: range(1, 2, 1, 5), newText: "aa\nbbbb" };
    // newText adds 1 line; inserted end is (line 2, column 4).
    expect(mapPositionAfterEdit(pos(1, 9), edit)).toEqual(pos(2, 8));
    expect(mapPositionAfterEdit(pos(4, 0), edit)).toEqual(pos(5, 0));
  });

  it("grows lines when newText adds more lines than the replaced span", () => {
    const edit: EditorTextEdit = { range: range(1, 2, 1, 5), newText: "aa\nbb\ncc" };
    // newText adds 2 lines; inserted end is (line 3, column 2).
    expect(mapPositionAfterEdit(pos(1, 9), edit)).toEqual(pos(3, 6));
    expect(mapPositionAfterEdit(pos(4, 7), edit)).toEqual(pos(6, 7));
  });

  it("handles a deletion (empty newText)", () => {
    const edit: EditorTextEdit = { range: range(3, 2, 3, 7), newText: "" };
    expect(mapPositionAfterEdit(pos(3, 10), edit)).toEqual(pos(3, 5));
    expect(mapPositionAfterEdit(pos(3, 4), edit)).toEqual(pos(3, 2));
  });

  it("handles a multi-line deletion collapsing later lines", () => {
    const edit: EditorTextEdit = { range: range(2, 1, 4, 3), newText: "" };
    // delete spans 2 lines; later positions move up by 2 lines.
    expect(mapPositionAfterEdit(pos(4, 9), edit)).toEqual(pos(2, 7));
    expect(mapPositionAfterEdit(pos(6, 0), edit)).toEqual(pos(4, 0));
  });

  // KEIKO-0590: apply-text-edits.ts renders the same EditorTextEdit into a buffer through the
  // shared CRLF/lone-CR-aware `computeLineStarts` primitive; measureNewText previously split only
  // on "\n", so a lone-CR (old-Mac) inserted newText silently counted zero added lines. Delegating
  // to the same primitive keeps both sides of the same edit in step.
  it("counts a lone-CR (old-Mac) newline in an inserted newText (KEIKO-0590)", () => {
    const edit: EditorTextEdit = { range: range(1, 2, 1, 5), newText: "aa\rbb" };
    // A later-line position shifts by +1 line because the inserted newText adds one line via CR.
    expect(mapPositionAfterEdit(pos(4, 7), edit)).toEqual(pos(5, 7));
    // A same-line position after the edit end drops to the inserted last-line ("bb") column plus
    // its distance past edit.end (both 0 here — column 5 is edit.end).
    expect(mapPositionAfterEdit(pos(1, 9), edit)).toEqual(pos(2, 6));
  });
});

describe("mapRangeAfterEdit", () => {
  it("maps both endpoints", () => {
    const edit: EditorTextEdit = { range: range(0, 0, 0, 2), newText: "abcd" };
    expect(mapRangeAfterEdit(range(0, 5, 0, 9), edit)).toEqual(range(0, 7, 0, 11));
  });
});
