// PURE hunk application against in-memory file content. Given the current file lines and a
// file's hunks, it verifies the pre-image (context and removed lines must match the current
// content at the hunk location) and produces the post-image. A mismatch yields a conflict
// rather than a silent corruption — the apply phase refuses to write when any conflict exists.

import type { PatchFileChange, PatchHunk } from "./types.js";

export interface HunkConflict {
  readonly hunkIndex: number;
  readonly reason: string;
}

export interface ApplyOutcome {
  readonly content: string | null; // null for a delete
  readonly conflicts: readonly HunkConflict[];
}

// Splits file content into lines WITHOUT a trailing empty element for a final newline, so line
// indexing matches unified-diff 1-based line numbers. An empty file is zero lines.
function toLines(content: string): string[] {
  if (content === "") {
    return [];
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

interface HunkResult {
  readonly outLines: readonly string[];
  readonly conflict: string | undefined;
  readonly consumed: number;
}

// Applies a single hunk starting at `cursor` (0-based index into the original lines). Returns the
// produced output lines, the count of original lines consumed, and a conflict reason on mismatch.
function applyHunk(original: readonly string[], hunk: PatchHunk, cursor: number): HunkResult {
  const out: string[] = [];
  let pos = cursor;
  for (const raw of hunk.lines) {
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    if (marker === "+") {
      out.push(text);
      continue;
    }
    // context (" ") and removal ("-") must both match the current line at pos.
    if (original[pos] !== text) {
      return {
        outLines: [],
        consumed: 0,
        conflict: `context mismatch at original line ${String(pos + 1)}`,
      };
    }
    if (marker === " ") {
      out.push(text);
    }
    pos += 1;
  }
  return { outLines: out, consumed: pos - cursor, conflict: undefined };
}

// Applies all hunks of a modify in order. Hunks are anchored by their stated oldStart (1-based);
// lines between hunks are copied verbatim. Returns the new content or the collected conflicts.
function applyModify(original: readonly string[], hunks: readonly PatchHunk[]): ApplyOutcome {
  const out: string[] = [];
  const conflicts: HunkConflict[] = [];
  let cursor = 0;
  hunks.forEach((hunk, index) => {
    const anchor = Math.max(hunk.oldStart - 1, 0);
    if (anchor < cursor) {
      conflicts.push({ hunkIndex: index, reason: "overlapping or out-of-order hunk" });
      return;
    }
    // Copy verbatim the unchanged lines between the previous cursor and this hunk's anchor.
    out.push(...original.slice(cursor, Math.min(anchor, original.length)));
    cursor = anchor;
    const result = applyHunk(original, hunk, cursor);
    if (result.conflict !== undefined) {
      conflicts.push({ hunkIndex: index, reason: result.conflict });
      return;
    }
    out.push(...result.outLines);
    cursor += result.consumed;
  });
  // Copy any remaining original lines after the last applied hunk.
  out.push(...original.slice(cursor));
  return conflicts.length > 0
    ? { content: null, conflicts }
    : { content: joinLines(out), conflicts: [] };
}

// Verifies a delete's pre-image against the current content (C2). A delete hunk lists the lines to
// remove (`-`) and surrounding context (` `); their concatenation must equal the current file, or
// the diff is stale/fabricated and we MUST NOT delete a mismatched file. A hunk-free delete (no
// pre-image to check) is accepted as-is. `+` lines are not expected in a delete and are ignored.
function verifyDeletePreImage(change: PatchFileChange, current: string): ApplyOutcome {
  const preImage: string[] = [];
  for (const hunk of change.hunks) {
    for (const raw of hunk.lines) {
      const marker = raw.charAt(0);
      if (marker === " " || marker === "-") {
        preImage.push(raw.slice(1));
      }
    }
  }
  if (preImage.length === 0) {
    return { content: null, conflicts: [] };
  }
  const matches = joinLines(preImage) === current || preImage.join("\n") === current;
  return matches
    ? { content: null, conflicts: [] }
    : {
        content: null,
        conflicts: [{ hunkIndex: 0, reason: "delete pre-image does not match current content" }],
      };
}

// Computes the post-image for one file change against its current content (undefined = absent).
export function computeFileContent(
  change: PatchFileChange,
  current: string | undefined,
): ApplyOutcome {
  if (change.kind === "create") {
    if (current !== undefined) {
      return {
        content: null,
        conflicts: [{ hunkIndex: 0, reason: "create target already exists" }],
      };
    }
    const added = change.hunks.flatMap((h) =>
      h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)),
    );
    return { content: joinLines(added), conflicts: [] };
  }
  if (change.kind === "delete") {
    if (current === undefined) {
      return {
        content: null,
        conflicts: [{ hunkIndex: 0, reason: "delete target does not exist" }],
      };
    }
    return verifyDeletePreImage(change, current);
  }
  if (current === undefined) {
    return { content: null, conflicts: [{ hunkIndex: 0, reason: "modify target does not exist" }] };
  }
  return applyModify(toLines(current), change.hunks);
}
