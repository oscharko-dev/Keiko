/**
 * A bounded line diff for the runtime Git reader (CodeRabbit review, PR #3452).
 *
 * The reader rendered and counted every modified file as a whole-file replacement: a one-line edit
 * in a large file reached the model as one hunk rewriting every line, and the operator's stage review
 * as that many additions and deletions. Git's own `git diff` cannot repair that on the worktree side:
 * Git runs the repository's configured clean filters over worktree content, and this lane never
 * executes a repository-configured command (pinned in verifiedCommitService.test.ts). The reader
 * keeps reading both sides raw (a blob through `cat-file`, the worktree bytes directly) and compares
 * them here: Myers' O(ND) algorithm over the region between the common prefix and suffix, rendered
 * as unified hunks with Git's three lines of context.
 */

/** One side of a comparison: its lines without terminators, and whether its last line lacks one. */
export interface LineDiffSide {
  readonly lines: readonly string[];
  readonly missingFinalNewline: boolean;
}

/** One replaced region: old lines [oldStart, oldEnd) became new lines [newStart, newEnd). */
export interface LineChangeBlock {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

/**
 * The largest edit distance searched for a minimal script. Past it, the region between the common
 * prefix and suffix is reported as one replaced block (still a correct diff, just not a minimal one),
 * so the search stays quadratic in this bound and linear in the file length.
 */
export const LINE_DIFF_MAX_EDIT_DISTANCE = 1_000;
export const UNIFIED_DIFF_CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = String.raw`\ No newline at end of file`;

type LineEdit = "keep" | "remove" | "add";

interface HunkGroup {
  readonly blocks: LineChangeBlock[];
  readonly leading: number;
  trailing: number;
}

export function lineDiffSide(text: string): LineDiffSide {
  return {
    lines: text === "" ? [] : text.replace(/\n$/u, "").split("\n"),
    missingFinalNewline: text.length > 0 && !text.endsWith("\n"),
  };
}

// A last line without its terminator differs from the same text with one, as it does for Git. No
// line contains "\n", so the suffixed key never equals another line.
function comparisonKeys(side: LineDiffSide): readonly string[] {
  const last = side.lines.at(-1);
  if (!side.missingFinalNewline || last === undefined) return side.lines;
  return [...side.lines.slice(0, -1), `${last}\n`];
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length += 1;
  return length;
}

function commonSuffixLength(a: readonly string[], b: readonly string[], prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let length = 0;
  while (length < limit && a[a.length - 1 - length] === b[b.length - 1 - length]) length += 1;
  return length;
}

function movesDown(diagonal: number, d: number, left: number, right: number): boolean {
  return diagonal === -d || (diagonal !== d && left < right);
}

function snakeEnd(a: readonly string[], b: readonly string[], x: number, diagonal: number): number {
  let end = x;
  while (end < a.length && end - diagonal < b.length && a[end] === b[end - diagonal]) end += 1;
  return end;
}

// Myers' greedy forward pass. trace[d] keeps the frontier as it stood before step d, for diagonals
// -d-1 to d+1 only, which is all the walk back reads. Undefined once the distance exceeds the bound.
function forwardTrace(
  a: readonly string[],
  b: readonly string[],
  maxDistance: number,
): readonly Int32Array[] | undefined {
  const offset = maxDistance + 1;
  const frontier = new Int32Array(2 * maxDistance + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxDistance; d += 1) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2));
    for (let diagonal = -d; diagonal <= d; diagonal += 2) {
      const left = frontier[offset + diagonal - 1] ?? 0;
      const right = frontier[offset + diagonal + 1] ?? 0;
      const x = snakeEnd(a, b, movesDown(diagonal, d, left, right) ? right : left + 1, diagonal);
      frontier[offset + diagonal] = x;
      if (x >= a.length && x - diagonal >= b.length) return trace;
    }
  }
  return undefined;
}

function frontierAt(trace: readonly Int32Array[], d: number, diagonal: number): number {
  return trace[d]?.[diagonal + d + 1] ?? 0;
}

// Walks the forward pass back from the end. Each step is one removal or addition, preceded by the
// run of kept lines that followed it; the edits come out last-first.
function backtrackEdits(
  trace: readonly Int32Array[],
  aLength: number,
  bLength: number,
): readonly LineEdit[] {
  const edits: LineEdit[] = [];
  let x = aLength;
  let y = bLength;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const diagonal = x - y;
    const left = frontierAt(trace, d, diagonal - 1);
    const down = movesDown(diagonal, d, left, frontierAt(trace, d, diagonal + 1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = frontierAt(trace, d, previousDiagonal);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      edits.push("keep");
      x -= 1;
      y -= 1;
    }
    if (d > 0) edits.push(down ? "add" : "remove");
    x = previousX;
    y = previousY;
  }
  return edits;
}

function editBlocks(lastFirstEdits: readonly LineEdit[], base: number): LineChangeBlock[] {
  const blocks: LineChangeBlock[] = [];
  let oldPosition = base;
  let newPosition = base;
  let open: { readonly oldStart: number; readonly newStart: number } | undefined;
  for (let index = lastFirstEdits.length - 1; index >= 0; index -= 1) {
    const edit = lastFirstEdits[index] ?? "keep";
    if (edit === "keep") {
      if (open !== undefined) blocks.push({ ...open, oldEnd: oldPosition, newEnd: newPosition });
      open = undefined;
      oldPosition += 1;
      newPosition += 1;
      continue;
    }
    open ??= { oldStart: oldPosition, newStart: newPosition };
    if (edit === "remove") oldPosition += 1;
    else newPosition += 1;
  }
  if (open !== undefined) blocks.push({ ...open, oldEnd: oldPosition, newEnd: newPosition });
  return blocks;
}

/** The replaced regions between two sides, in order; empty when the sides are identical. */
export function lineChangeBlocks(
  before: LineDiffSide,
  after: LineDiffSide,
  maxDistance = LINE_DIFF_MAX_EDIT_DISTANCE,
): readonly LineChangeBlock[] {
  const a = comparisonKeys(before);
  const b = comparisonKeys(after);
  const prefix = commonPrefixLength(a, b);
  const suffix = commonSuffixLength(a, b, prefix);
  const whole: LineChangeBlock = {
    oldStart: prefix,
    oldEnd: a.length - suffix,
    newStart: prefix,
    newEnd: b.length - suffix,
  };
  const oldEmpty = whole.oldStart === whole.oldEnd;
  const newEmpty = whole.newStart === whole.newEnd;
  if (oldEmpty && newEmpty) return [];
  if (oldEmpty || newEmpty) return [whole];
  const middleA = a.slice(whole.oldStart, whole.oldEnd);
  const middleB = b.slice(whole.newStart, whole.newEnd);
  const trace = forwardTrace(middleA, middleB, maxDistance);
  if (trace === undefined) return [whole];
  return editBlocks(backtrackEdits(trace, middleA.length, middleB.length), prefix);
}

/** Added and deleted line counts between two sides: a one-line edit counts 1/1. */
export function lineChangeCounts(
  before: LineDiffSide,
  after: LineDiffSide,
): { readonly added: number; readonly deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const block of lineChangeBlocks(before, after)) {
    added += block.newEnd - block.newStart;
    deleted += block.oldEnd - block.oldStart;
  }
  return { added, deleted };
}

// Blocks whose context windows touch share one hunk, as Git groups them.
function hunkGroups(blocks: readonly LineChangeBlock[], oldLength: number): readonly HunkGroup[] {
  const groups: HunkGroup[] = [];
  let previousEnd = 0;
  for (const block of blocks) {
    const gap = block.oldStart - previousEnd;
    const current = groups.at(-1);
    if (current !== undefined && gap <= 2 * UNIFIED_DIFF_CONTEXT_LINES) {
      current.blocks.push(block);
    } else {
      if (current !== undefined) current.trailing = UNIFIED_DIFF_CONTEXT_LINES;
      const leading = Math.min(UNIFIED_DIFF_CONTEXT_LINES, gap);
      groups.push({ blocks: [block], leading, trailing: 0 });
    }
    previousEnd = block.oldEnd;
  }
  const last = groups.at(-1);
  if (last !== undefined)
    last.trailing = Math.min(UNIFIED_DIFF_CONTEXT_LINES, oldLength - previousEnd);
  return groups;
}

function hunkRange(start: number, end: number): string {
  const count = end - start;
  return `${String(count === 0 ? start : start + 1)},${String(count)}`;
}

function sideLines(side: LineDiffSide, start: number, end: number, marker: string): string[] {
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    lines.push(`${marker}${side.lines[index] ?? ""}`);
    if (index === side.lines.length - 1 && side.missingFinalNewline) lines.push(NO_NEWLINE_MARKER);
  }
  return lines;
}

// Context comes from the old side: around and between blocks both sides hold the same lines,
// including whether the last one ends without a newline.
function renderHunk(group: HunkGroup, before: LineDiffSide, after: LineDiffSide): string[] {
  const first = group.blocks[0];
  const last = group.blocks.at(-1);
  if (first === undefined || last === undefined) return [];
  const oldStart = first.oldStart - group.leading;
  const oldEnd = last.oldEnd + group.trailing;
  const newStart = first.newStart - group.leading;
  const newEnd = last.newEnd + group.trailing;
  const lines = [`@@ -${hunkRange(oldStart, oldEnd)} +${hunkRange(newStart, newEnd)} @@`];
  let position = oldStart;
  for (const block of group.blocks) {
    lines.push(
      ...sideLines(before, position, block.oldStart, " "),
      ...sideLines(before, block.oldStart, block.oldEnd, "-"),
      ...sideLines(after, block.newStart, block.newEnd, "+"),
    );
    position = block.oldEnd;
  }
  lines.push(...sideLines(before, position, oldEnd, " "));
  return lines;
}

/** Unified-diff hunks (headers and lines) between two sides, with three lines of context. */
export function unifiedDiffHunks(before: LineDiffSide, after: LineDiffSide): readonly string[] {
  return hunkGroups(lineChangeBlocks(before, after), before.lines.length).flatMap((group) =>
    renderHunk(group, before, after),
  );
}
