// PURE, ReDoS-free unified-diff parser. Supported subset (documented in ADR-0006):
//   - file headers `--- a/<path>` / `+++ b/<path>`, with `/dev/null` for create/delete;
//   - hunk headers `@@ -l,s +l,s @@` (the count `,s` defaults to 1 when omitted);
//   - body lines beginning with " " (context), "+" (add), "-" (remove), and "\" (no-newline).
// This is NOT git-apply: no rename detection, no binary patches, no fuzzy matching. The parser
// is linear (a single pass with bounded per-line regexes) so it cannot backtrack catastrophically.

import type { PatchChangeKind, PatchFileChange, PatchHunk } from "./tools.js";

// Bounded, anchored hunk-header regex. Each numeric group is `\d+` (linear, no nesting).
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedPatch {
  readonly files: readonly PatchFileChange[];
}

export interface UnifiedDiffSourceRange {
  readonly start: number;
  readonly end: number;
}

export interface UnifiedDiffSourceLine extends UnifiedDiffSourceRange {
  readonly marker: " " | "+" | "-" | "\\";
}

export interface UnifiedDiffHunkSource {
  readonly hunk: PatchHunk;
  readonly header: UnifiedDiffSourceRange;
  readonly contextStart: number;
  readonly lines: readonly UnifiedDiffSourceLine[];
}

export interface UnifiedDiffFileSource {
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldHeader: UnifiedDiffSourceRange;
  readonly newHeader: UnifiedDiffSourceRange;
  readonly hunks: readonly UnifiedDiffHunkSource[];
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
  source:
    | {
        readonly header: UnifiedDiffSourceRange;
        readonly contextStart: number;
        readonly lines: UnifiedDiffSourceLine[];
      }
    | undefined;
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

function parseHunkHeader(
  line: string,
  source: UnifiedDiffSourceRange | undefined,
): HunkAccumulator {
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
    source:
      source === undefined
        ? undefined
        : { header: source, contextStart: source.start + match[0].length, lines: [] },
  };
}

interface FileAccumulator {
  oldPath: string | undefined;
  newPath: string | undefined;
  hunks: PatchHunk[];
  current: HunkAccumulator | undefined;
  added: number;
  removed: number;
  source:
    | {
        readonly oldHeader: UnifiedDiffSourceRange;
        newHeader: UnifiedDiffSourceRange | undefined;
        readonly hunks: UnifiedDiffHunkSource[];
      }
    | undefined;
}

function newFileAccumulator(source: UnifiedDiffSourceRange | undefined): FileAccumulator {
  return {
    oldPath: undefined,
    newPath: undefined,
    hunks: [],
    current: undefined,
    added: 0,
    removed: 0,
    source:
      source === undefined ? undefined : { oldHeader: source, newHeader: undefined, hunks: [] },
  };
}

function finishHunk(file: FileAccumulator): void {
  if (file.current !== undefined) {
    if (file.current.oldRemaining !== 0 || file.current.newRemaining !== 0) {
      throw new PatchParseError("hunk body has fewer lines than declared");
    }
    const hunk = toHunk(file.current);
    file.hunks.push(hunk);
    if (file.current.source !== undefined)
      file.source?.hunks.push({ ...file.current.source, hunk });
    file.current = undefined;
  }
}

function finishFile(
  files: PatchFileChange[],
  file: FileAccumulator,
  sources: UnifiedDiffFileSource[] | undefined,
): void {
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
  if (file.source?.newHeader !== undefined && file.source.hunks.length > 0)
    sources?.push({
      oldPath: file.oldPath,
      newPath: file.newPath,
      ...file.source,
      newHeader: file.source.newHeader,
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
  readonly sources: UnifiedDiffFileSource[] | undefined;
  current: FileAccumulator | undefined;
}

function startNewFile(
  state: ParseState,
  oldPath: string,
  source: UnifiedDiffSourceRange | undefined,
): FileAccumulator {
  if (state.current !== undefined) {
    finishFile(state.files, state.current, state.sources);
  }
  const file = newFileAccumulator(source);
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
function assertBudgetAvailable(hunk: HunkAccumulator, line: string): void {
  const marker = line.charAt(0);
  const oldNeeded = marker === " " || marker === "-" ? 1 : 0;
  const newNeeded = marker === " " || marker === "+" ? 1 : 0;
  if (hunk.oldRemaining < oldNeeded || hunk.newRemaining < newNeeded) {
    throw new PatchParseError("hunk body has more lines than declared");
  }
}

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

// `\ No newline at end of file` annotates the body line right before it. It is kept in the hunk so
// application can honour it (#3873; it used to be dropped, which gave every patched file a final
// line break), and it draws no line budget. Anywhere else it is malformed.
function attachNoNewlineMarker(hunk: HunkAccumulator | undefined, line: string): void {
  const previous = hunk?.lines.at(-1);
  if (hunk === undefined || previous === undefined || !isHunkBodyLine(previous)) {
    throw new PatchParseError("no-newline marker must follow a hunk body line");
  }
  hunk.lines.push(line);
}

function recordSourceLine(
  hunk: HunkAccumulator | undefined,
  line: string,
  source: UnifiedDiffSourceRange | undefined,
): void {
  const marker = line.charAt(0);
  if (
    source !== undefined &&
    (marker === " " || marker === "+" || marker === "-" || marker === "\\")
  )
    hunk?.source?.lines.push({ ...source, marker });
}

function handleBodyLine(
  file: FileAccumulator,
  line: string,
  source: UnifiedDiffSourceRange | undefined,
): void {
  if (line.startsWith("\\")) {
    attachNoNewlineMarker(file.current, line);
    recordSourceLine(file.current, line, source);
    return;
  }
  if (file.current === undefined) {
    return; // lines outside a hunk (e.g. `diff --git`, `index …`) are ignored
  }
  // Only genuine body lines (context/add/remove) belong to the hunk. An empty trailing line
  // (the split artifact of a final newline) or any other token ends the hunk so it is not
  // mistaken for a zero-length context line that would never match the file content.
  if (!isHunkBodyLine(line)) {
    finishHunk(file);
    return;
  }
  assertBudgetAvailable(file.current, line);
  file.current.lines.push(line);
  recordSourceLine(file.current, line, source);
  countBody(file, line);
  consumeBudget(file.current, line);
}

function handleLine(
  state: ParseState,
  line: string,
  source: UnifiedDiffSourceRange | undefined,
): void {
  // While a hunk still has budget, ` `/`+`/`-` lines are BODY even if they render as `--- `/`+++ `
  // (C6). Only once the hunk is consumed (or absent) can a `--- ` line open a new file.
  if (state.current !== undefined && hunkActive(state.current) && isHunkBodyLine(line)) {
    handleBodyLine(state.current, line, source);
    return;
  }
  if (line.startsWith("--- ")) {
    startNewFile(state, headerPath(line, "--- "), source);
    return;
  }
  if (state.current === undefined) {
    return; // skip preamble before the first file header
  }
  if (line.startsWith("+++ ")) {
    state.current.newPath = headerPath(line, "+++ ");
    if (state.current.source !== undefined) state.current.source.newHeader = source;
    return;
  }
  if (line.startsWith("@@")) {
    finishHunk(state.current);
    state.current.current = parseHunkHeader(line, source);
    return;
  }
  handleBodyLine(state.current, line, source);
}

/** Source observations cover only accepted headers/hunks, and publish only after the entire parse
 * succeeds. Ignored preamble, gaps, tails and incomplete files never gain source ownership. */
export function parseUnifiedDiff(
  diff: string,
  observeSources?: (files: readonly UnifiedDiffFileSource[]) => void,
): ParsedPatch {
  const state: ParseState = {
    files: [],
    current: undefined,
    sources: observeSources === undefined ? undefined : [],
  };
  let offset = 0;
  for (const line of diff.split("\n")) {
    const end = Math.min(diff.length, offset + line.length + 1);
    handleLine(state, line, state.sources === undefined ? undefined : { start: offset, end });
    offset = end;
  }
  if (state.current !== undefined) {
    finishFile(state.files, state.current, state.sources);
  }
  if (state.sources !== undefined) observeSources?.(state.sources);
  return { files: state.files };
}
