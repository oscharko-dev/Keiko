import { describe, expect, it } from "vitest";

import {
  applyTextEditsToText,
  isOverlappingPatchEditError,
  OverlappingPatchEditError,
} from "./apply-text-edits.js";
import type { EditorTextEdit } from "./types.js";

function edit(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  newText: string,
): EditorTextEdit {
  return {
    range: {
      start: { line: startLine, column: startColumn },
      end: { line: endLine, column: endColumn },
    },
    newText,
  };
}

describe("applyTextEditsToText", () => {
  it("returns the original unchanged when there are no edits", () => {
    expect(applyTextEditsToText("a\nb\n", [])).toBe("a\nb\n");
  });

  it("inserts text at a zero-width range", () => {
    // Insert "X" at line 0, column 1 of "ab".
    expect(applyTextEditsToText("ab", [edit(0, 1, 0, 1, "X")])).toBe("aXb");
  });

  it("replaces a single-line span", () => {
    expect(applyTextEditsToText("const a = 1;", [edit(0, 10, 0, 11, "2")])).toBe("const a = 2;");
  });

  it("replaces a multi-line span with multi-line text", () => {
    const original = "line0\nline1\nline2\n";
    // Replace from line 1 col 0 to line 2 col 0 (the whole "line1\n") with two new lines.
    const result = applyTextEditsToText(original, [edit(1, 0, 2, 0, "new1\nnew1b\n")]);
    expect(result).toBe("line0\nnew1\nnew1b\nline2\n");
  });

  it("applies multiple non-overlapping edits left-to-right regardless of input order", () => {
    const original = "aaa\nbbb\nccc";
    const edits = [edit(2, 0, 2, 3, "CCC"), edit(0, 0, 0, 3, "AAA")];
    expect(applyTextEditsToText(original, edits)).toBe("AAA\nbbb\nCCC");
  });

  it("deletes text when newText is empty", () => {
    expect(applyTextEditsToText("abcdef", [edit(0, 2, 0, 4, "")])).toBe("abef");
  });

  it("appends onto an empty original (new-file case)", () => {
    expect(applyTextEditsToText("", [edit(0, 0, 0, 0, "hello\nworld\n")])).toBe("hello\nworld\n");
  });

  it("clamps a column past the end of a line to the line end", () => {
    // Column 99 on line 0 ("ab") clamps to the newline boundary, not into line 1.
    expect(applyTextEditsToText("ab\ncd", [edit(0, 99, 0, 99, "Z")])).toBe("abZ\ncd");
  });

  it("clamps a line past the end of the text to the text end", () => {
    expect(applyTextEditsToText("ab", [edit(5, 0, 5, 0, "Z")])).toBe("abZ");
  });

  it("collapses an inverted range to an insertion at its start rather than slicing backwards", () => {
    expect(applyTextEditsToText("abcdef", [edit(0, 4, 0, 2, "Z")])).toBe("abcdZef");
  });

  it("throws OverlappingPatchEditError for overlapping edits", () => {
    const edits = [edit(0, 0, 0, 3, "X"), edit(0, 2, 0, 5, "Y")];
    expect(() => applyTextEditsToText("abcdef", edits)).toThrow(OverlappingPatchEditError);
  });

  it("applies adjacent (touching, non-overlapping) edits without throwing", () => {
    // Boundary guard: edit B starts exactly where edit A ends. This must NOT be treated as an overlap
    // (the guard is `start < cursor`, not `<=`); replacing two consecutive tokens is very common.
    const edits = [edit(0, 0, 0, 1, "X"), edit(0, 1, 0, 2, "Y")];
    expect(applyTextEditsToText("abcdef", edits)).toBe("XYcdef");
  });

  it("treats columns as UTF-16 code units across an astral character", () => {
    // "a😀b": 😀 (U+1F600) is two UTF-16 code units, so 'b' sits at column 3.
    expect(applyTextEditsToText("a😀b", [edit(0, 3, 0, 4, "X")])).toBe("a😀X");
  });

  it("splits lines on \\n only, leaving a CRLF carriage return as part of the line (documented contract)", () => {
    // The helper consumes Monaco-normalised (\n) content; if a host passes CRLF, the \r occupies a
    // column on its line. Line 1 starts just after the \n, so replacing its first column hits 'b'.
    expect(applyTextEditsToText("a\r\nb", [edit(1, 0, 1, 1, "X")])).toBe("a\r\nX");
  });

  it("does not mutate the input edits array", () => {
    const edits = [edit(2, 0, 2, 3, "CCC"), edit(0, 0, 0, 3, "AAA")];
    const snapshot = JSON.stringify(edits);
    applyTextEditsToText("aaa\nbbb\nccc", edits);
    expect(JSON.stringify(edits)).toBe(snapshot);
  });

  it("exposes a type guard for the overlap error", () => {
    expect(isOverlappingPatchEditError(new OverlappingPatchEditError("x"))).toBe(true);
    expect(isOverlappingPatchEditError(new Error("x"))).toBe(false);
  });
});
