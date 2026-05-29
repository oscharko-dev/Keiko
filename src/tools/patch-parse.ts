// PURE, ReDoS-free unified-diff parser. Supported subset (documented in ADR-0006):
//   - file headers `--- a/<path>` / `+++ b/<path>`, with `/dev/null` for create/delete;
//   - hunk headers `@@ -l,s +l,s @@` (the count `,s` defaults to 1 when omitted);
//   - body lines beginning with " " (context), "+" (add), "-" (remove), and "\" (no-newline).
// This is NOT git-apply: no rename detection, no binary patches, no fuzzy matching. The parser
// is linear (a single pass with bounded per-line regexes) so it cannot backtrack catastrophically.

import type { PatchChangeKind, PatchFileChange, PatchHunk } from "./types.js";

// Bounded, anchored hunk-header regex. Each numeric group is `\d+` (linear, no nesting).
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedPatch {
  readonly files: readonly PatchFileChange[];
}

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

function stripPrefix(raw: string): string {
  if (raw === "/dev/null") {
    return raw;
  }
  // Drop a leading `a/` or `b/` git prefix; otherwise keep the path verbatim.
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

// The header path may carry a trailing tab + timestamp (`path\t2024-…`); keep only the path.
function headerPath(line: string, marker: string): string {
  const rest = line.slice(marker.length);
  const tab = rest.indexOf("\t");
  const raw = tab === -1 ? rest : rest.slice(0, tab);
  return stripPrefix(raw.trim());
}

function classify(oldPath: string, newPath: string): { kind: PatchChangeKind; path: string } {
  if (oldPath === "/dev/null") {
    return { kind: "create", path: newPath };
  }
  if (newPath === "/dev/null") {
    return { kind: "delete", path: oldPath };
  }
  return { kind: "modify", path: newPath };
}

interface HunkAccumulator {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  // Remaining old/new line budget from the `@@ -l,s +l,s @@` header. While either is > 0 the hunk
  // is still consuming body lines, so a body line that renders as `--- `/`+++ ` is NOT a new file
  // header (C6). A context line draws from both; `-` from old; `+` from new.
  oldRemaining: number;
  newRemaining: number;
}

function toHunk(acc: HunkAccumulator): PatchHunk {
  return {
    oldStart: acc.oldStart,
    oldLines: acc.oldLines,
    newStart: acc.newStart,
    newLines: acc.newLines,
    lines: acc.lines,
  };
}

function parseHunkHeader(line: string): HunkAccumulator {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    throw new PatchParseError("malformed hunk header");
  }
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  return {
    oldStart: Number(match[1]),
    oldLines,
    newStart: Number(match[3]),
    newLines,
    lines: [],
    oldRemaining: oldLines,
    newRemaining: newLines,
  };
}

interface FileAccumulator {
  oldPath: string | undefined;
  newPath: string | undefined;
  hunks: PatchHunk[];
  current: HunkAccumulator | undefined;
  added: number;
  removed: number;
}

function newFileAccumulator(): FileAccumulator {
  return {
    oldPath: undefined,
    newPath: undefined,
    hunks: [],
    current: undefined,
    added: 0,
    removed: 0,
  };
}

function finishHunk(file: FileAccumulator): void {
  if (file.current !== undefined) {
    file.hunks.push(toHunk(file.current));
    file.current = undefined;
  }
}

function finishFile(files: PatchFileChange[], file: FileAccumulator): void {
  finishHunk(file);
  if (file.oldPath === undefined || file.newPath === undefined) {
    return;
  }
  const { kind, path } = classify(file.oldPath, file.newPath);
  files.push({
    path,
    kind,
    hunks: file.hunks,
    addedLines: file.added,
    removedLines: file.removed,
  });
}

function countBody(file: FileAccumulator, line: string): void {
  if (line.startsWith("+")) {
    file.added += 1;
  } else if (line.startsWith("-")) {
    file.removed += 1;
  }
}

interface ParseState {
  readonly files: PatchFileChange[];
  current: FileAccumulator | undefined;
}

function startNewFile(state: ParseState, oldPath: string): FileAccumulator {
  if (state.current !== undefined) {
    finishFile(state.files, state.current);
  }
  const file = newFileAccumulator();
  file.oldPath = oldPath;
  state.current = file;
  return file;
}

function isHunkBodyLine(line: string): boolean {
  const marker = line.charAt(0);
  return marker === " " || marker === "+" || marker === "-";
}

// A hunk is still consuming body lines while either the old or the new line budget is positive.
function hunkActive(file: FileAccumulator): boolean {
  const hunk = file.current;
  return hunk !== undefined && (hunk.oldRemaining > 0 || hunk.newRemaining > 0);
}

// Draws down the hunk's old/new line budget for a body line (context draws both, `-` old, `+` new).
function consumeBudget(hunk: HunkAccumulator, line: string): void {
  const marker = line.charAt(0);
  if (marker === " ") {
    hunk.oldRemaining -= 1;
    hunk.newRemaining -= 1;
  } else if (marker === "-") {
    hunk.oldRemaining -= 1;
  } else if (marker === "+") {
    hunk.newRemaining -= 1;
  }
}

function handleBodyLine(file: FileAccumulator, line: string): void {
  if (file.current === undefined) {
    return; // lines outside a hunk (e.g. `diff --git`, `index …`) are ignored
  }
  if (line.startsWith("\\")) {
    return; // "\ No newline at end of file" marker
  }
  // Only genuine body lines (context/add/remove) belong to the hunk. An empty trailing line
  // (the split artifact of a final newline) or any other token ends the hunk so it is not
  // mistaken for a zero-length context line that would never match the file content.
  if (!isHunkBodyLine(line)) {
    finishHunk(file);
    return;
  }
  file.current.lines.push(line);
  countBody(file, line);
  consumeBudget(file.current, line);
}

function handleLine(state: ParseState, line: string): void {
  // While a hunk still has budget, ` `/`+`/`-` lines are BODY even if they render as `--- `/`+++ `
  // (C6). Only once the hunk is consumed (or absent) can a `--- ` line open a new file.
  if (state.current !== undefined && hunkActive(state.current) && isHunkBodyLine(line)) {
    handleBodyLine(state.current, line);
    return;
  }
  if (line.startsWith("--- ")) {
    startNewFile(state, headerPath(line, "--- "));
    return;
  }
  if (state.current === undefined) {
    return; // skip preamble before the first file header
  }
  if (line.startsWith("+++ ")) {
    state.current.newPath = headerPath(line, "+++ ");
    return;
  }
  if (line.startsWith("@@")) {
    finishHunk(state.current);
    state.current.current = parseHunkHeader(line);
    return;
  }
  handleBodyLine(state.current, line);
}

export function parseUnifiedDiff(diff: string): ParsedPatch {
  const state: ParseState = { files: [], current: undefined };
  for (const line of diff.split("\n")) {
    handleLine(state, line);
  }
  if (state.current !== undefined) {
    finishFile(state.files, state.current);
  }
  return { files: state.files };
}
