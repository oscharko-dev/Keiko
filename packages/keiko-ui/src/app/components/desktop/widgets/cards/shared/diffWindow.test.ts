import { describe, expect, it } from "vitest";
import type { GitEditorDiffFile, GitEditorDiffHunk } from "@oscharko-dev/keiko-contracts";

import {
  DIFF_WINDOW_PAGE_ROWS,
  DIFF_WINDOW_THRESHOLD_ROWS,
  diffFileMetrics,
  diffPageCount,
  isWindowedDiff,
  sliceDiffPage,
} from "./diffWindow";

function hunk(lineCount: number, header = "@@ -1 +1 @@", truncated = false): GitEditorDiffHunk {
  return {
    header,
    oldStart: 1,
    oldCount: lineCount,
    newStart: 1,
    newCount: lineCount,
    truncated,
    lines: Array.from({ length: lineCount }, (_, index) => ({
      kind: "add" as const,
      text: `line ${String(index)}`,
      oldLine: null,
      newLine: index + 1,
    })),
  };
}

function file(hunks: readonly GitEditorDiffHunk[], truncated = false): GitEditorDiffFile {
  return {
    path: "src/a.ts",
    layer: "worktree",
    status: "modified",
    binary: false,
    hunks,
    addedLines: hunks.reduce((sum, item) => sum + item.lines.length, 0),
    removedLines: 0,
    truncated,
  };
}

describe("diff window plan (#4108)", () => {
  it("measures rows and UTF-8 bytes of every line, one newline each", () => {
    const multibyte: GitEditorDiffHunk = {
      ...hunk(0, "@@ x"),
      lines: ["a", "é", "€", "😀"].map((text, index) => ({
        kind: "ctx" as const,
        text,
        oldLine: index + 1,
        newLine: index + 1,
      })),
    };
    // header "@@ x" = 4 bytes + newline, then (1 + 2 + 3 + 4) text bytes + 4 newlines.
    expect(diffFileMetrics(file([multibyte]))).toEqual({ rows: 4, bytes: 5 + 10 + 4 });
  });

  it("counts a hunk without lines as one reachable row", () => {
    expect(diffFileMetrics(file([hunk(0)])).rows).toBe(1);
  });

  it("windows a diff only above the threshold", () => {
    expect(isWindowedDiff([file([hunk(DIFF_WINDOW_THRESHOLD_ROWS)])])).toBe(false);
    expect(isWindowedDiff([file([hunk(DIFF_WINDOW_THRESHOLD_ROWS + 1)])])).toBe(true);
    expect(isWindowedDiff([file([hunk(1_200)]), file([hunk(1_200)])])).toBe(true);
  });

  it("puts every row on exactly one page and never drops a line", () => {
    const sizes = [1, 999, 0, 1_000, 1_001, 2_500, 7];
    const source = file(sizes.map((size, index) => hunk(size, `@@ -${String(index)} @@`)));
    const { rows } = diffFileMetrics(source);
    const pageCount = diffPageCount(rows);
    const seen: string[] = [];
    let covered = 0;
    for (let page = 0; page < pageCount; page += 1) {
      const view = sliceDiffPage(source, page);
      expect(view.page).toBe(page);
      expect(view.fromRow).toBe(page * DIFF_WINDOW_PAGE_ROWS + 1);
      covered += view.toRow - view.fromRow + 1;
      const pageLines = view.hunks.reduce((sum, item) => sum + Math.max(item.lines.length, 1), 0);
      expect(pageLines).toBe(view.toRow - view.fromRow + 1);
      expect(pageLines).toBeLessThanOrEqual(DIFF_WINDOW_PAGE_ROWS);
      for (const item of view.hunks) {
        for (const line of item.lines) seen.push(`${item.header}|${line.text}`);
      }
    }
    expect(covered).toBe(rows);
    const original = source.hunks.flatMap((item) =>
      item.lines.map((line) => `${item.header}|${line.text}`),
    );
    expect(seen).toEqual(original);
  });

  it("repeats the header of a hunk that continues on the next page", () => {
    const view = sliceDiffPage(file([hunk(1_500, "@@ big @@")]), 1);
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0]?.header).toBe("@@ big @@");
    expect(view.hunks[0]?.lines).toHaveLength(500);
  });

  it("marks only the last page of a truncated hunk as incomplete", () => {
    const source = file([hunk(1_500, "@@ t @@", true)]);
    expect(sliceDiffPage(source, 0).hunks[0]?.truncated).toBe(false);
    expect(sliceDiffPage(source, 1).hunks[0]?.truncated).toBe(true);
  });

  it("clamps the page into the file's range and reports an empty file", () => {
    const source = file([hunk(1_500)]);
    expect(sliceDiffPage(source, 99).page).toBe(1);
    expect(sliceDiffPage(source, -4).page).toBe(0);
    const empty = sliceDiffPage(file([]), 3);
    expect(empty).toMatchObject({ page: 0, fromRow: 0, toRow: 0, pageCount: 1, hunks: [] });
  });
});
