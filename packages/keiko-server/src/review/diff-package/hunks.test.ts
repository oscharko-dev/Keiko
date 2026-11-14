// Hunk context shaping of the review diff package (Issue #4134).

import { describe, expect, it } from "vitest";
import type { PatchHunk } from "@oscharko-dev/keiko-contracts";
import { numberedBody } from "./diffPackageAssertions.test-support.js";
import { addedFileHunk, shapeReviewHunks, splitReviewHunk } from "./hunks.js";

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

// #4130: a hunk that no diff package part can hold is shown as consecutive windows.
describe("splitReviewHunk", () => {
  /** A hunk fits when it has at most `max` body lines. */
  const atMost =
    (max: number) =>
    (hunk: PatchHunk): boolean =>
      hunk.lines.filter((line) => !line.startsWith("\\")).length <= max;

  const replaced: PatchHunk = {
    oldStart: 10,
    oldLines: 4,
    newStart: 10,
    newLines: 6,
    lines: [
      " keep 10",
      "-old 11",
      "-old 12",
      "+new 11",
      "+new 12",
      "+new 13",
      "+new 14",
      " keep 13",
    ],
  };

  it("returns a hunk that fits whole unchanged, as the same object", () => {
    const [only, ...rest] = splitReviewHunk(replaced, { whole: atMost(8), window: atMost(1) });
    expect(only).toBe(replaced);
    expect(rest).toEqual([]);
  });

  it("cuts a hunk into the longest windows that fit, every line once and on its own numbers", () => {
    const windows = splitReviewHunk(replaced, { whole: atMost(7), window: atMost(3) });

    expect(windows.map((window) => window.lines.length)).toEqual([3, 3, 2]);
    expect(numberedBody(windows)).toEqual(numberedBody([replaced]));
    expect(windows).toEqual([
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 1,
        lines: [" keep 10", "-old 11", "-old 12"],
      },
      {
        oldStart: 12,
        oldLines: 0,
        newStart: 11,
        newLines: 3,
        lines: ["+new 11", "+new 12", "+new 13"],
      },
      { oldStart: 13, oldLines: 1, newStart: 14, newLines: 2, lines: ["+new 14", " keep 13"] },
    ]);
  });

  it("numbers the windows of an added file from its first line on", () => {
    const added = addedFileHunk("a\nb\nc\nd\ne");
    if (added === undefined) throw new TypeError("expected a hunk");

    const windows = splitReviewHunk(added, { whole: () => false, window: atMost(2) });

    expect(windows.map((window) => [window.oldStart, window.oldLines])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(windows.map((window) => [window.newStart, window.newLines])).toEqual([
      [1, 2],
      [3, 2],
      [5, 1],
    ]);
    // The missing final newline stays with the last line.
    expect(windows.at(-1)?.lines).toEqual(["+e", String.raw`\ No newline at end of file`]);
    expect(numberedBody(windows)).toEqual(numberedBody([added]));
  });

  it("gives a line that fits no window a window of its own", () => {
    const windows = splitReviewHunk(replaced, { whole: () => false, window: () => false });
    expect(windows).toHaveLength(8);
    expect(numberedBody(windows)).toEqual(numberedBody([replaced]));
  });
});
