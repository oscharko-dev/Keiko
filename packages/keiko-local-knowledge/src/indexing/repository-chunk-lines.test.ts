import { describe, expect, it } from "vitest";

import { buildDocumentLineIndex, repositoryLineRangeForSpan } from "./repository-chunk-lines.js";

describe("repository chunk line mapping", () => {
  it.each([
    ["", 0, 0, { startLine: 1, endLine: 1, documentLineCount: 1 }],
    ["one line", 0, 8, { startLine: 1, endLine: 1, documentLineCount: 1 }],
    ["one\ntwo\nthree", 4, 7, { startLine: 2, endLine: 2, documentLineCount: 3 }],
    ["one\r\ntwo\r\n", 5, 10, { startLine: 2, endLine: 2, documentLineCount: 3 }],
    ["\uFEFFdef load():\n  pass", 1, 12, { startLine: 1, endLine: 1, documentLineCount: 2 }],
  ])("round-trips adversarial newline offsets", (text, start, end, expected) => {
    expect(repositoryLineRangeForSpan(buildDocumentLineIndex(text), start, end)).toEqual(expected);
  });

  it("keeps ranges monotonic for overlapping chunks and bounds a single overlong line", () => {
    const text = `${"x".repeat(10_000)}\nnext`;
    const index = buildDocumentLineIndex(text);
    const ranges = [
      repositoryLineRangeForSpan(index, 0, 4000),
      repositoryLineRangeForSpan(index, 3500, 8000),
      repositoryLineRangeForSpan(index, 7900, text.length),
    ];
    expect(ranges.map((range) => range.startLine)).toEqual([1, 1, 1]);
    expect(ranges.at(-1)).toEqual({ startLine: 1, endLine: 2, documentLineCount: 2 });
  });
});
