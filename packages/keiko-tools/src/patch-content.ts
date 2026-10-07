// PURE hunk application against in-memory file content. Given the current file lines and a
// file's hunks, it verifies the pre-image (context and removed lines must match the current
// content at the hunk location) and produces the post-image. A mismatch yields a conflict
// rather than a silent corruption — the apply phase refuses to write when any conflict exists.
//
// A final line without its line break travels as the unified-diff marker
// `\ No newline at end of file`, which annotates the body line right before it (#3873). The engine
// reads it as Git does: a marked line is the file's last line and has no line break, an unmarked
// line has one. On the old side the marker is verified against the current content and a mismatch
// is a conflict; an unmarked old-side line is accepted whether or not the current content ends
// with a line break, as before. Lines after the last hunk keep the current content's ending.

import type { PatchFileChange, PatchHunk } from "./types.js";

export interface HunkConflict {
  readonly hunkIndex: number;
  readonly reason: string;
}

export interface ApplyOutcome {
  readonly content: string | null; // null for a delete
  readonly conflicts: readonly HunkConflict[];
}

const NO_NEWLINE_MARKER = "\\";
const MARKER_NOT_LAST = "no-newline marker is not on the file's last line";

interface Original {
  readonly lines: readonly string[];
  readonly missingFinalNewline: boolean;
}

// Splits file content into lines WITHOUT a trailing empty element for a final newline, so line
// indexing matches unified-diff 1-based line numbers. An empty file is zero lines.
function toOriginal(content: string): Original {
  if (content === "") {
    return { lines: [], missingFinalNewline: false };
  }
  const lines = content.split("\n");
  const missingFinalNewline = lines.at(-1) !== "";
  if (!missingFinalNewline) {
    lines.pop();
  }
  return { lines, missingFinalNewline };
}

function render(lines: readonly string[], missingFinalNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  return missingFinalNewline ? lines.join("\n") : `${lines.join("\n")}\n`;
}

// The new-side lines a hunk (or a create) produced, and which of them a marker named as last.
interface Produced {
  readonly lines: string[];
  markedAt: number | undefined;
}

function markLastProduced(produced: Produced): string | undefined {
  if (produced.markedAt !== undefined) {
    return "duplicate no-newline marker";
  }
  produced.markedAt = produced.lines.length - 1;
  return undefined;
}

function markedLineNotLast(produced: Produced): string | undefined {
  return produced.markedAt !== undefined && produced.markedAt !== produced.lines.length - 1
    ? MARKER_NOT_LAST
    : undefined;
}

// A marker asserts, for the body line before it: on the old side (` `/`-`) that the line just
// consumed is the current content's last line and lacks its line break; on the new side (` `/`+`)
// that the line just produced is the new file's last line.
function applyMarker(
  original: Original,
  previous: string,
  pos: number,
  produced: Produced,
): string | undefined {
  const marker = previous.charAt(0);
  if (marker !== " " && marker !== "+" && marker !== "-") {
    return "no-newline marker without a preceding line";
  }
  if (marker !== "+" && (pos !== original.lines.length || !original.missingFinalNewline)) {
    return `no-newline marker does not match original line ${String(pos)}`;
  }
  return marker === "-" ? undefined : markLastProduced(produced);
}

interface HunkResult {
  readonly outLines: readonly string[];
  readonly conflict: string | undefined;
  readonly consumed: number;
  // True when the hunk named its last produced line as the file's last line without a line break.
  readonly missingFinalNewline: boolean;
}

const FAILED_HUNK = { outLines: [], consumed: 0, missingFinalNewline: false } as const;

// Applies a single hunk starting at `cursor` (0-based index into the original lines). Returns the
// produced output lines, the count of original lines consumed, and a conflict reason on mismatch.
function applyHunk(original: Original, hunk: PatchHunk, cursor: number): HunkResult {
  const produced: Produced = { lines: [], markedAt: undefined };
  let pos = cursor;
  let previous = "";
  for (const raw of hunk.lines) {
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    let conflict: string | undefined;
    if (marker === NO_NEWLINE_MARKER) {
      conflict = applyMarker(original, previous, pos, produced);
    } else if (marker === "+") {
      produced.lines.push(text);
    } else if (original.lines[pos] === text) {
      // context (" ") and removal ("-") must both match the current line at pos.
      if (marker === " ") {
        produced.lines.push(text);
      }
      pos += 1;
    } else {
      conflict = `context mismatch at original line ${String(pos + 1)}`;
    }
    if (conflict !== undefined) {
      return { ...FAILED_HUNK, conflict };
    }
    previous = raw;
  }
  const conflict = markedLineNotLast(produced);
  if (conflict !== undefined) {
    return { ...FAILED_HUNK, conflict };
  }
  return {
    outLines: produced.lines,
    consumed: pos - cursor,
    conflict: undefined,
    missingFinalNewline: produced.markedAt !== undefined,
  };
}

interface ModifyState {
  readonly out: string[];
  readonly conflicts: HunkConflict[];
  cursor: number;
  missingFinalNewline: boolean;
}

function applyModifyHunk(
  original: Original,
  hunk: PatchHunk,
  index: number,
  state: ModifyState,
): void {
  const anchor = Math.max(hunk.oldStart - 1, 0);
  if (anchor < state.cursor) {
    state.conflicts.push({ hunkIndex: index, reason: "overlapping or out-of-order hunk" });
    return;
  }
  // The unchanged lines between the previous cursor and this hunk's anchor are copied verbatim.
  const between = original.lines.slice(state.cursor, Math.min(anchor, original.lines.length));
  const result = applyHunk(original, hunk, anchor);
  if (result.conflict !== undefined) {
    state.conflicts.push({ hunkIndex: index, reason: result.conflict });
    return;
  }
  if (state.missingFinalNewline && between.length + result.outLines.length > 0) {
    state.conflicts.push({ hunkIndex: index, reason: MARKER_NOT_LAST });
    state.missingFinalNewline = false; // reported once; the tail check must not repeat it
    return;
  }
  state.out.push(...between, ...result.outLines);
  state.cursor = anchor + result.consumed;
  state.missingFinalNewline = result.missingFinalNewline;
}

// Applies all hunks of a modify in order. Hunks are anchored by their stated oldStart (1-based);
// lines between hunks are copied verbatim. Returns the new content or the collected conflicts.
function applyModify(original: Original, hunks: readonly PatchHunk[]): ApplyOutcome {
  const state: ModifyState = { out: [], conflicts: [], cursor: 0, missingFinalNewline: false };
  hunks.forEach((hunk, index) => {
    applyModifyHunk(original, hunk, index, state);
  });
  // Copy any remaining original lines after the last applied hunk; they keep the file's ending.
  const tail = original.lines.slice(state.cursor);
  if (state.missingFinalNewline && tail.length > 0) {
    state.conflicts.push({ hunkIndex: hunks.length - 1, reason: MARKER_NOT_LAST });
  }
  if (state.conflicts.length > 0) {
    return { content: null, conflicts: state.conflicts };
  }
  state.out.push(...tail);
  const missingFinalNewline =
    tail.length > 0 ? original.missingFinalNewline : state.missingFinalNewline;
  return { content: render(state.out, missingFinalNewline), conflicts: [] };
}

// Collects a create's added lines; a marker names the last of them as having no line break.
function createdContent(hunks: readonly PatchHunk[]): ApplyOutcome {
  const produced: Produced = { lines: [], markedAt: undefined };
  let previous = "";
  for (const [index, hunk] of hunks.entries()) {
    for (const raw of hunk.lines) {
      let conflict: string | undefined;
      if (raw.startsWith(NO_NEWLINE_MARKER)) {
        conflict = previous.startsWith("+")
          ? markLastProduced(produced)
          : "no-newline marker without a preceding line";
      } else if (raw.startsWith("+")) {
        produced.lines.push(raw.slice(1));
      }
      if (conflict !== undefined) {
        return { content: null, conflicts: [{ hunkIndex: index, reason: conflict }] };
      }
      previous = raw;
    }
  }
  const conflict = markedLineNotLast(produced);
  if (conflict !== undefined) {
    return { content: null, conflicts: [{ hunkIndex: hunks.length - 1, reason: conflict }] };
  }
  return { content: render(produced.lines, produced.markedAt !== undefined), conflicts: [] };
}

// Verifies a delete's pre-image against the current content (C2). A delete hunk lists the lines to
// remove (`-`) and surrounding context (` `); their concatenation must equal the current file, or
// the diff is stale/fabricated and we MUST NOT delete a mismatched file. A hunk-free delete (no
// pre-image to check) is accepted as-is. `+` lines are not expected in a delete and are ignored,
// and the file's final line break is not part of the check.
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
  const matches = render(preImage, false) === current || render(preImage, true) === current;
  return matches
    ? { content: null, conflicts: [] }
    : {
        content: null,
        conflicts: [{ hunkIndex: 0, reason: "delete pre-image does not match current content" }],
      };
}

// Computes the post-image for one file change against its current content (undefined = absent).
// `allowOverwrite` (default false) governs only the create-over-existing case: when false a create
// whose target already exists is a conflict (the default no-silent-overwrite guardrail, Issue #1204
// AC7/AC14); when true — set only after explicit user confirmation — the existing file is replaced with
// the created content.
export function computeFileContent(
  change: PatchFileChange,
  current: string | undefined,
  allowOverwrite = false,
): ApplyOutcome {
  if (change.kind === "create") {
    if (current !== undefined && !allowOverwrite) {
      return {
        content: null,
        conflicts: [{ hunkIndex: 0, reason: "create target already exists" }],
      };
    }
    return createdContent(change.hunks);
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
  return applyModify(toOriginal(current), change.hunks);
}
