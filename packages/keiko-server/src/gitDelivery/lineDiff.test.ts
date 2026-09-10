import { describe, expect, it } from "vitest";
import {
  lineChangeBlocks,
  lineChangeCounts,
  lineDiffSide,
  unifiedDiffHunks,
  type LineChangeBlock,
  type LineDiffSide,
} from "./lineDiff.js";

function side(lines: readonly string[]): LineDiffSide {
  return { lines, missingFinalNewline: false };
}

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${String(index)}`);
}

// Rebuilds the new side from the old one and the blocks: proves the blocks are a correct edit script.
function applyBlocks(
  before: readonly string[],
  after: readonly string[],
  blocks: readonly LineChangeBlock[],
): string[] {
  const rebuilt: string[] = [];
  let position = 0;
  for (const block of blocks) {
    rebuilt.push(
      ...before.slice(position, block.oldStart),
      ...after.slice(block.newStart, block.newEnd),
    );
    position = block.oldEnd;
  }
  rebuilt.push(...before.slice(position));
  return rebuilt;
}

// An independent oracle for minimality: the classic dynamic-programming longest common subsequence.
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i * width + j] =
        a[i - 1] === b[j - 1]
          ? (table[(i - 1) * width + j - 1] ?? 0) + 1
          : Math.max(table[(i - 1) * width + j] ?? 0, table[i * width + j - 1] ?? 0);
    }
  }
  return table[a.length * width + b.length] ?? 0;
}

// A deterministic generator over a three-letter alphabet, so collisions (and long snakes) are common.
function generated(seed: number, length: number): string[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return "abc"[state % 3] ?? "a";
  });
}

describe("lineChangeBlocks", () => {
  it("finds nothing between identical sides", () => {
    expect(lineChangeBlocks(side(numbered(5)), side(numbered(5)))).toEqual([]);
    expect(unifiedDiffHunks(side(numbered(5)), side(numbered(5)))).toEqual([]);
    expect(lineChangeCounts(side([]), side([]))).toEqual({ added: 0, deleted: 0 });
  });

  // CodeRabbit review, PR #3452: a one-line edit in unchanged context is one changed line, not the
  // whole file on both sides.
  it("isolates one modified line inside unchanged context", () => {
    const before = numbered(40);
    const after = [...before];
    after[20] = "line 20 changed";

    expect(lineChangeBlocks(side(before), side(after))).toEqual([
      { oldStart: 20, oldEnd: 21, newStart: 20, newEnd: 21 },
    ]);
    expect(lineChangeCounts(side(before), side(after))).toEqual({ added: 1, deleted: 1 });
    expect(unifiedDiffHunks(side(before), side(after))).toEqual([
      "@@ -18,7 +18,7 @@",
      " line 17",
      " line 18",
      " line 19",
      "-line 20",
      "+line 20 changed",
      " line 21",
      " line 22",
      " line 23",
    ]);
  });

  it("finds the minimal script of Myers' own example", () => {
    const before = ["A", "B", "C", "A", "B", "B", "A"];
    const after = ["C", "B", "A", "B", "A", "C"];

    expect(applyBlocks(before, after, lineChangeBlocks(side(before), side(after)))).toEqual(after);
    expect(lineChangeCounts(side(before), side(after))).toEqual({ added: 2, deleted: 3 });
  });

  it("is a correct and minimal edit script on generated inputs", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const before = generated(seed, seed % 17);
      const after = generated(seed * 7 + 3, (seed * 5) % 13);
      const common = lcsLength(before, after);

      expect(applyBlocks(before, after, lineChangeBlocks(side(before), side(after)))).toEqual(
        after,
      );
      expect(lineChangeCounts(side(before), side(after))).toEqual({
        added: after.length - common,
        deleted: before.length - common,
      });
    }
  });

  it("reports the region between prefix and suffix as one block past the search bound", () => {
    const before = ["head", "a", "b", "c", "d", "tail"];
    const after = ["head", "b", "x", "d", "y", "tail"];

    expect(lineChangeBlocks(side(before), side(after), 1)).toEqual([
      { oldStart: 1, oldEnd: 5, newStart: 1, newEnd: 5 },
    ]);
    expect(lineChangeBlocks(side(before), side(after))).toHaveLength(3);
  });
});

describe("unifiedDiffHunks", () => {
  it("shares one hunk between edits whose context touches and splits distant ones", () => {
    const before = numbered(30);
    const near = [...before];
    near[5] = "five";
    near[11] = "eleven";
    const far = [...before];
    far[5] = "five";
    far[20] = "twenty";
    const headers = (lines: readonly string[]): readonly string[] =>
      lines.filter((line) => line.startsWith("@@"));

    expect(headers(unifiedDiffHunks(side(before), side(near)))).toEqual(["@@ -3,13 +3,13 @@"]);
    expect(headers(unifiedDiffHunks(side(before), side(far)))).toEqual([
      "@@ -3,7 +3,7 @@",
      "@@ -18,7 +18,7 @@",
    ]);
  });

  it("renders a new file, a deleted file and a missing final newline the way Git does", () => {
    expect(unifiedDiffHunks(lineDiffSide(""), lineDiffSide("a\nb"))).toEqual([
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      String.raw`\ No newline at end of file`,
    ]);
    expect(unifiedDiffHunks(lineDiffSide("a\nb\n"), lineDiffSide(""))).toEqual([
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
    ]);
    expect(unifiedDiffHunks(lineDiffSide("a\nb"), lineDiffSide("a\nb\n"))).toEqual([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      String.raw`\ No newline at end of file`,
      "+b",
    ]);
    expect(lineChangeCounts(lineDiffSide("a\nb"), lineDiffSide("a\nb\n"))).toEqual({
      added: 1,
      deleted: 1,
    });
  });

  it("splits text into lines the way the reader's sides arrive", () => {
    expect(lineDiffSide("")).toEqual({ lines: [], missingFinalNewline: false });
    expect(lineDiffSide("\n")).toEqual({ lines: [""], missingFinalNewline: false });
    expect(lineDiffSide("x\r\ny")).toEqual({ lines: ["x\r", "y"], missingFinalNewline: true });
  });
});
