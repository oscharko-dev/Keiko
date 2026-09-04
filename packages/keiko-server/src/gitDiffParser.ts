// Unified-diff parsing for the BFF. Two consumers share the primitives in the first half of this
// file and differ only in identity and bounds:
//
//   * `parseGitEditorUnifiedDiff` — the editor's staged/worktree read (ADR-0127). Identity comes
//     from the `diff --git` headers because that lane has nothing else; every path is re-rooted
//     under the selected root and the bounds are the editor's wire limits.
//   * The change snapshot (Issue #3397, ADR-0174) — identity comes from a NUL-safe `--raw -z` lane,
//     so it consumes `splitUnifiedDiffSections`, `parseUnifiedDiffFileHeader` (to cross-check the
//     patch lane against that identity) and `parseUnifiedHunks` with its own limits.
//
// The generalization is deliberately additive: the editor path keeps its exact behaviour and its
// pinned tests, and the header grammar gained the records it used to skip over (copy, old/new
// mode, the `160000` gitlink mode) so a copy, a mode-only change or a submodule move is a fact the
// snapshot can carry instead of a "modified" it has to guess at.

import type {
  GitEditorDiffFile,
  GitEditorDiffFileStatus,
  GitEditorDiffHunk,
  GitEditorDiffLine,
  GitEditorDiffScope,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_DIFF_MAX_HEADER_CHARS,
  GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE,
  GIT_EDITOR_DIFF_MAX_LINE_CHARS,
  GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";

export interface GitUnifiedDiffParseOptions {
  readonly scope: GitEditorDiffScope;
  readonly selectedRootPrefix: string;
  readonly processTruncated: boolean;
}

export interface ParsedGitUnifiedDiff {
  readonly files: readonly GitEditorDiffFile[];
  readonly totalFiles: number;
  readonly truncated: boolean;
}

// ─── Shared primitives ───────────────────────────────────────────────────────────

export interface UnifiedHunkLimits {
  readonly maxHunks: number;
  readonly maxLinesPerHunk: number;
  readonly maxHeaderChars: number;
  readonly maxLineChars: number;
}

/** A parsed hunk: coordinates plus classified lines. Bound-agnostic, so both consumers share it. */
export interface ParsedUnifiedHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly GitEditorDiffLine[];
}

export interface ParsedUnifiedHunks {
  readonly hunks: readonly ParsedUnifiedHunk[];
  /** Well-formed hunks dropped past `maxHunks`. Exact, so a consumer can count its omission. */
  readonly droppedHunks: number;
  /** A hunk body disagreed with its header, a line was over-long, or a hunk was dropped. */
  readonly malformed: boolean;
  /** A hunk header could not be parsed at all; nothing after it can be trusted. */
  readonly fatal: boolean;
}

export type UnifiedDiffFileChange = "add" | "modify" | "delete" | "rename" | "copy";

/**
 * The file-header records of one `diff --git` section, decoded (quoted-path octal escapes
 * resolved, `a/`/`b/` prefixes stripped) but NOT re-rooted: the caller decides what a path is
 * relative to. `submodule` is read from the `160000` gitlink mode in the `index`/mode records.
 */
export interface UnifiedDiffFileHeader {
  readonly path: string;
  readonly oldPath?: string;
  readonly change: UnifiedDiffFileChange;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly similarity?: number;
  readonly binary: boolean;
  readonly submodule: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u;
const OCTAL_ESCAPE = /^[0-7]{3}$/u;
const MODE_RECORD = /^(new file|deleted file|old|new) mode ([0-7]{6})$/u;
const SIMILARITY_RECORD = /^(?:dis)?similarity index (\d{1,3})%$/u;
const INDEX_RECORD = /^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?$/u;
const GITLINK_MODE = "160000";

function decodeQuotedPath(raw: string): string | undefined {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const content = raw.slice(1, -1);
  let index = 0;
  while (index < content.length) {
    const value = content[index] ?? "";
    if (value !== "\\") {
      bytes.push(...encoder.encode(value));
      index += 1;
      continue;
    }
    const escape = content[index + 1];
    if (escape === undefined) return undefined;
    const octal = content.slice(index + 1, index + 4);
    if (OCTAL_ESCAPE.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    const escaped = new Map([
      ["a", 7],
      ["b", 8],
      ["t", 9],
      ["n", 10],
      ["v", 11],
      ["f", 12],
      ["r", 13],
      ['"', 34],
      ["\\", 92],
    ]).get(escape);
    if (escaped === undefined) return undefined;
    bytes.push(escaped);
    index += 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

function decodePath(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.includes("\uFFFD")) return undefined;
  return trimmed.startsWith('"') ? decodeQuotedPath(trimmed) : trimmed;
}

function withoutDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function splitQuotedHeader(value: string): readonly [string, string] | undefined {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') {
      const separator = /^\s+/u.exec(value.slice(index + 1));
      if (separator === null) return undefined;
      const second = value.slice(index + 1 + separator[0].length);
      return [value.slice(0, index + 1), second];
    }
  }
  return undefined;
}

function splitDiffHeader(line: string): readonly [string, string] | undefined {
  if (!line.startsWith("diff --git ")) return undefined;
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) return splitQuotedHeader(value);
  const separator = value.lastIndexOf(" b/");
  return separator < 0 ? undefined : [value.slice(0, separator), value.slice(separator + 1)];
}

function decodeHeaderPath(raw: string): string | undefined {
  const decoded = decodePath(raw);
  return decoded === undefined ? undefined : withoutDiffPrefix(decoded);
}

interface MutableFileHeader {
  path: string;
  oldPath: string | undefined;
  change: UnifiedDiffFileChange;
  oldMode: string | undefined;
  newMode: string | undefined;
  similarity: number | undefined;
  binary: boolean;
  submodule: boolean;
}

function applyModeRecord(header: MutableFileHeader, kind: string, mode: string): void {
  if (kind === "new file") {
    header.change = "add";
    header.newMode = mode;
  } else if (kind === "deleted file") {
    header.change = "delete";
    header.oldMode = mode;
  } else if (kind === "old") header.oldMode = mode;
  else header.newMode = mode;
  header.submodule ||= mode === GITLINK_MODE;
}

// `rename from`/`rename to`/`copy from`/`copy to`: the paired identity records. Returns false on
// a path that cannot be decoded — the section is then malformed as a whole.
function applyPairingRecord(header: MutableFileHeader, line: string): boolean | undefined {
  const match = /^(rename|copy) (from|to) (.+)$/u.exec(line);
  if (match === null) return undefined;
  const path = decodeHeaderPath(match[3] ?? "");
  if (path === undefined) return false;
  if (match[2] === "from") header.oldPath = path;
  else {
    header.path = path;
    header.change = match[1] === "rename" ? "rename" : "copy";
  }
  return true;
}

// Git's file-header grammar is a closed sequence of mutually exclusive records; each branch
// consumes exactly one shape. Returns false only when a record is present but undecodable.
// eslint-disable-next-line complexity
function applyHeaderRecord(header: MutableFileHeader, line: string): boolean {
  const mode = MODE_RECORD.exec(line);
  if (mode !== null) {
    applyModeRecord(header, mode[1] ?? "", mode[2] ?? "");
    return true;
  }
  const paired = applyPairingRecord(header, line);
  if (paired !== undefined) return paired;
  const similarity = SIMILARITY_RECORD.exec(line);
  if (similarity !== null) {
    header.similarity = Math.min(100, Number(similarity[1]));
    return true;
  }
  const index = INDEX_RECORD.exec(line);
  if (index !== null) {
    header.submodule ||= index[1] === GITLINK_MODE;
    return true;
  }
  if (line.startsWith("Binary files ") || line === "GIT binary patch") header.binary = true;
  return true;
}

/**
 * Parses the header records of one file section (the lines from `diff --git` up to the first
 * hunk). `undefined` when the `diff --git` line or any path record cannot be decoded.
 */
export function parseUnifiedDiffFileHeader(
  lines: readonly string[],
): UnifiedDiffFileHeader | undefined {
  const paths = splitDiffHeader(lines[0] ?? "");
  if (paths === undefined) return undefined;
  const path = decodeHeaderPath(paths[1]);
  if (path === undefined) return undefined;
  const header: MutableFileHeader = {
    path,
    oldPath: undefined,
    change: "modify",
    oldMode: undefined,
    newMode: undefined,
    similarity: undefined,
    binary: false,
    submodule: false,
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("@@ ")) break;
    if (!applyHeaderRecord(header, line)) return undefined;
  }
  return {
    path: header.path,
    ...(header.oldPath === undefined ? {} : { oldPath: header.oldPath }),
    change: header.change,
    ...(header.oldMode === undefined ? {} : { oldMode: header.oldMode }),
    ...(header.newMode === undefined ? {} : { newMode: header.newMode }),
    ...(header.similarity === undefined ? {} : { similarity: header.similarity }),
    binary: header.binary,
    submodule: header.submodule,
  };
}

interface HunkCoordinates {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

function parseHunkHeader(header: string, maxHeaderChars: number): HunkCoordinates | undefined {
  if (header.length > maxHeaderChars) return undefined;
  const match = HUNK_HEADER.exec(header);
  if (match === null) return undefined;
  return {
    header,
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function diffLine(
  raw: string,
  oldLine: number,
  newLine: number,
  maxLineChars: number,
): GitEditorDiffLine | undefined {
  const text = raw.slice(1);
  if (text.length > maxLineChars || text.includes("\uFFFD")) return undefined;
  if (raw.startsWith(" ")) return { kind: "ctx", oldLine, newLine, text };
  if (raw.startsWith("+")) return { kind: "add", oldLine: null, newLine, text };
  if (raw.startsWith("-")) return { kind: "del", oldLine, newLine: null, text };
  if (raw === String.raw`\ No newline at end of file`) {
    return { kind: "meta", oldLine: null, newLine: null, text: raw };
  }
  return undefined;
}

interface HunkLineAccumulator {
  readonly parsedLines: GitEditorDiffLine[];
  oldLine: number;
  newLine: number;
  oldConsumed: number;
  newConsumed: number;
  malformed: boolean;
}

function initialHunkLineAccumulator(coordinates: HunkCoordinates): HunkLineAccumulator {
  return {
    parsedLines: [],
    oldLine: coordinates.oldStart,
    newLine: coordinates.newStart,
    oldConsumed: 0,
    newConsumed: 0,
    malformed: false,
  };
}

// Classifies one hunk-body line and advances the two coupled old/new counters it feeds.
function accumulateHunkLine(
  accumulator: HunkLineAccumulator,
  raw: string,
  limits: UnifiedHunkLimits,
): void {
  const parsed = diffLine(raw, accumulator.oldLine, accumulator.newLine, limits.maxLineChars);
  if (parsed === undefined || accumulator.parsedLines.length >= limits.maxLinesPerHunk) {
    accumulator.malformed = true;
    return;
  }
  accumulator.parsedLines.push(parsed);
  if (parsed.kind === "ctx" || parsed.kind === "del") {
    accumulator.oldLine += 1;
    accumulator.oldConsumed += 1;
  }
  if (parsed.kind === "ctx" || parsed.kind === "add") {
    accumulator.newLine += 1;
    accumulator.newConsumed += 1;
  }
}

function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

interface OneHunkParse {
  readonly hunk?: ParsedUnifiedHunk;
  readonly next: number;
  readonly malformed: boolean;
  readonly fatal: boolean;
}

function parseOneHunk(
  lines: readonly string[],
  start: number,
  limits: UnifiedHunkLimits,
): OneHunkParse {
  const coordinates = parseHunkHeader(lineAt(lines, start), limits.maxHeaderChars);
  let index = start + 1;
  if (coordinates === undefined) return { next: index, malformed: true, fatal: true };
  const accumulator = initialHunkLineAccumulator(coordinates);
  while (index < lines.length && !lineAt(lines, index).startsWith("@@ ")) {
    const raw = lineAt(lines, index);
    if (raw.length === 0 && index === lines.length - 1) break;
    accumulateHunkLine(accumulator, raw, limits);
    index += 1;
  }
  accumulator.malformed ||=
    accumulator.oldConsumed !== coordinates.oldCount ||
    accumulator.newConsumed !== coordinates.newCount;
  return accumulator.malformed
    ? { next: index, malformed: true, fatal: false }
    : {
        next: index,
        malformed: false,
        fatal: false,
        hunk: { ...coordinates, lines: accumulator.parsedLines },
      };
}

/**
 * Parses every hunk of one file section under `limits`. A hunk whose body disagrees with its
 * header (a cut tail, an over-long line) is dropped and reported as malformed rather than
 * carried half-parsed; a header that does not parse at all is fatal for the section.
 */
export function parseUnifiedHunks(
  lines: readonly string[],
  limits: UnifiedHunkLimits,
): ParsedUnifiedHunks {
  const hunks: ParsedUnifiedHunk[] = [];
  let droppedHunks = 0;
  let malformed = false;
  let fatal = false;
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("@@")) {
      index += 1;
      continue;
    }
    const parsed = parseOneHunk(lines, index, limits);
    index = parsed.next;
    if (parsed.malformed) malformed = true;
    if (parsed.fatal) fatal = true;
    else if (parsed.hunk !== undefined && hunks.length < limits.maxHunks) hunks.push(parsed.hunk);
    else if (parsed.hunk !== undefined) {
      droppedHunks += 1;
      malformed = true;
    }
  }
  return { hunks, droppedHunks, malformed, fatal };
}

/** Splits a unified diff into its `diff --git` sections, each as its lines. Text before the first header is dropped. */
export function splitUnifiedDiffSections(input: string): readonly (readonly string[])[] {
  const sections: string[][] = [];
  for (const line of input.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return sections;
}

// ─── Editor read surface ─────────────────────────────────────────────────────────

const EDITOR_HUNK_LIMITS: UnifiedHunkLimits = {
  maxHunks: GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE,
  maxLinesPerHunk: GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK,
  maxHeaderChars: GIT_EDITOR_DIFF_MAX_HEADER_CHARS,
  maxLineChars: GIT_EDITOR_DIFF_MAX_LINE_CHARS,
};

function relativePathUnderPrefix(path: string, normalizedPrefix: string): string | undefined {
  if (normalizedPrefix.length === 0) return path;
  if (path.startsWith(`${normalizedPrefix}/`)) return path.slice(normalizedPrefix.length + 1);
  return undefined;
}

function relativeToSelectedRoot(path: string, prefix: string): string | undefined {
  const normalizedPrefix = prefix === "." ? "" : prefix.replace(/\/$/u, "");
  const relative = relativePathUnderPrefix(path, normalizedPrefix);
  return relative !== undefined && isRootRelativeFileIdentifier(relative) ? relative : undefined;
}

// The editor's wire vocabulary has no copy or mode-only member: a copy reads as the modification
// of its destination and a mode-only change as a modification with no hunks, exactly as before
// the header grammar learned those records.
function editorStatus(change: UnifiedDiffFileChange): GitEditorDiffFileStatus {
  if (change === "add") return "added";
  if (change === "delete") return "deleted";
  if (change === "rename") return "renamed";
  return "modified";
}

interface EditorIdentity {
  readonly path: string;
  readonly oldPath: string | undefined;
  readonly status: GitEditorDiffFileStatus;
}

// Re-roots the decoded header paths under the selected root. A path outside it, or one that is
// not a root-relative file identifier, drops the file (the caller marks the response truncated).
function editorIdentity(header: UnifiedDiffFileHeader, prefix: string): EditorIdentity | undefined {
  const path = relativeToSelectedRoot(header.path, prefix);
  if (path === undefined) return undefined;
  const status = editorStatus(header.change);
  if (status !== "renamed" || header.oldPath === undefined)
    return { path, oldPath: undefined, status };
  const oldPath = relativeToSelectedRoot(header.oldPath, prefix);
  return oldPath === undefined ? undefined : { path, oldPath, status };
}

function editorHunks(hunks: readonly ParsedUnifiedHunk[]): readonly GitEditorDiffHunk[] {
  return hunks.map((hunk) => ({ ...hunk, truncated: false }));
}

function lineTotals(hunks: readonly GitEditorDiffHunk[]): {
  readonly addedLines: number;
  readonly removedLines: number;
} {
  const lines = hunks.flatMap((hunk) => hunk.lines);
  return {
    addedLines: lines.filter((line) => line.kind === "add").length,
    removedLines: lines.filter((line) => line.kind === "del").length,
  };
}

// File assembly deliberately keeps binary, rename, malformed, cap, and process-tail states explicit.
function parseFile(
  lines: readonly string[],
  options: GitUnifiedDiffParseOptions,
  isFinal: boolean,
): GitEditorDiffFile | undefined {
  if (lines.some((line) => line.includes("\uFFFD"))) return undefined;
  const header = parseUnifiedDiffFileHeader(lines);
  if (header === undefined) return undefined;
  const identity = editorIdentity(header, options.selectedRootPrefix);
  if (identity === undefined) return undefined;
  const parsed = parseUnifiedHunks(lines, EDITOR_HUNK_LIMITS);
  if (parsed.fatal) return undefined;
  const truncated = parsed.malformed || (isFinal && options.processTruncated);
  const hunks = editorHunks(
    isFinal && options.processTruncated && parsed.hunks.length > 0
      ? parsed.hunks.slice(0, -1)
      : parsed.hunks,
  );
  const totals = lineTotals(hunks);
  return {
    path: identity.path,
    ...(identity.oldPath === undefined ? {} : { oldPath: identity.oldPath }),
    layer: options.scope === "staged" ? "staged" : "worktree",
    status: identity.status,
    binary: header.binary,
    hunks: header.binary ? [] : hunks,
    addedLines: header.binary ? 0 : totals.addedLines,
    removedLines: header.binary ? 0 : totals.removedLines,
    truncated,
  };
}

export function parseGitEditorUnifiedDiff(
  input: string,
  options: GitUnifiedDiffParseOptions,
): ParsedGitUnifiedDiff {
  const sections = splitUnifiedDiffSections(input);
  const files: GitEditorDiffFile[] = [];
  let malformed = input.includes("\uFFFD");
  for (let index = 0; index < sections.length; index += 1) {
    const file = parseFile(sections[index] ?? [], options, index === sections.length - 1);
    if (file === undefined) malformed = true;
    else if (files.length < GIT_EDITOR_DIFF_MAX_FILES) files.push(file);
    else malformed = true;
  }
  return {
    files,
    totalFiles: sections.length,
    truncated: options.processTruncated || malformed || files.some((file) => file.truncated),
  };
}
