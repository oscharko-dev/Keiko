// Hunk context shaping of the review diff package (Issue #4134).

import { describe, expect, it } from "vitest";
import type { PatchHunk } from "@oscharko-dev/keiko-contracts";
import { addedFileHunk, shapeReviewHunks } from "./hunks.js";

const OPTIONS = { before: 5, after: 1, dynamicMax: 10, language: "typescript" } as const;

function context(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => ` line ${String(from + index)}`);
}

describe("shapeReviewHunks", () => {
  it("trims a -U10 hunk to five lines before and one after", () => {
    const hunk: PatchHunk = {
      oldStart: 5,
      oldLines: 21,
      newStart: 5,
      newLines: 21,
      lines: [...context(5, 14), "-line 15", "+line fifteen", ...context(16, 25)],
    };
    expect(shapeReviewHunks([hunk], OPTIONS)).toEqual([
      {
        oldStart: 10,
        oldLines: 7,
        newStart: 10,
        newLines: 7,
        lines: [...context(10, 14), "-line 15", "+line fifteen", " line 16"],
      },
    ]);
  });

  it("keeps a pure insertion's header position when it has no old lines", () => {
    const hunk: PatchHunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ["+only"],
    };
    expect(shapeReviewHunks([hunk], OPTIONS)).toEqual([hunk]);
  });

  it("starts at the nearest enclosing header within the dynamic window", () => {
    const hunk: PatchHunk = {
      oldStart: 1,
      oldLines: 11,
      newStart: 1,
      newLines: 11,
      lines: [
        " class Outer {",
        "   method(): void {",
        ...context(3, 10),
        "-  return 1;",
        "+  return 2;",
        " }",
      ],
    };
    const [shaped] = shapeReviewHunks([hunk], OPTIONS);
    expect(shaped?.lines[0]).toBe("   method(): void {");
    expect(shaped?.newStart).toBe(2);
  });

  it("moves the no-newline marker with its line", () => {
    const hunk: PatchHunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [" a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"],
    };
    expect(shapeReviewHunks([hunk], OPTIONS)[0]?.lines).toEqual(hunk.lines);
  });
});

describe("addedFileHunk", () => {
  it("numbers every line from 1 and marks a missing final newline", () => {
    expect(addedFileHunk("a\nb")).toEqual({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: ["+a", "+b", "\\ No newline at end of file"],
    });
    expect(addedFileHunk("a\n")?.lines).toEqual(["+a"]);
    expect(addedFileHunk("")).toBeUndefined();
  });
});
