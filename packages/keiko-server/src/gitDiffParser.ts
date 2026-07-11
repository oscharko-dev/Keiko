import {
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_DIFF_MAX_HEADER_CHARS,
  GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE,
  GIT_EDITOR_DIFF_MAX_LINE_CHARS,
  GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK,
  isRootRelativeFileIdentifier,
  type GitEditorDiffFile,
  type GitEditorDiffFileStatus,
  type GitEditorDiffHunk,
  type GitEditorDiffLine,
  type GitEditorDiffScope,
} from "@oscharko-dev/keiko-contracts";

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

interface ParsedHunks {
  readonly hunks: readonly GitEditorDiffHunk[];
  readonly addedLines: number;
  readonly removedLines: number;
  readonly malformed: boolean;
  readonly fatal: boolean;
}

interface HunkCoordinates {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

interface FileMetadata {
  path: string;
  oldPath: string | undefined;
  status: GitEditorDiffFileStatus;
  binary: boolean;
  malformed: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u;
const OCTAL_ESCAPE = /^[0-7]{3}$/u;

function decodeQuotedPath(raw: string): string | undefined {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const content = raw.slice(1, -1);
  for (let index = 0; index < content.length; index += 1) {
    const value = content[index] ?? "";
    if (value !== "\\") {
      bytes.push(...encoder.encode(value));
      continue;
    }
    const escape = content[index + 1];
    if (escape === undefined) return undefined;
    const octal = content.slice(index + 1, index + 4);
    if (OCTAL_ESCAPE.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
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
    index += 1;
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
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) return splitQuotedHeader(value);
  const separator = value.lastIndexOf(" b/");
  return separator < 0 ? undefined : [value.slice(0, separator), value.slice(separator + 1)];
}

function relativeToSelectedRoot(path: string, prefix: string): string | undefined {
  const normalizedPrefix = prefix === "." ? "" : prefix.replace(/\/$/u, "");
  const relative =
    normalizedPrefix.length === 0
      ? path
      : path.startsWith(`${normalizedPrefix}/`)
        ? path.slice(normalizedPrefix.length + 1)
        : undefined;
  return relative !== undefined && isRootRelativeFileIdentifier(relative) ? relative : undefined;
}

function parseHeaderPath(raw: string, prefix: string): string | undefined {
  const decoded = decodePath(raw);
  return decoded === undefined
    ? undefined
    : relativeToSelectedRoot(withoutDiffPrefix(decoded), prefix);
}

function initialMetadata(line: string, prefix: string): FileMetadata | undefined {
  const paths = splitDiffHeader(line);
  if (paths === undefined) return undefined;
  const path = parseHeaderPath(paths[1], prefix);
  if (path === undefined) return undefined;
  return { path, oldPath: undefined, status: "modified", binary: false, malformed: false };
}

// Git's file-header grammar is a closed sequence of mutually exclusive metadata records.
// eslint-disable-next-line complexity
function updateMetadata(metadata: FileMetadata, line: string, prefix: string): void {
  if (line === "new file mode" || line.startsWith("new file mode ")) metadata.status = "added";
  else if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
    metadata.status = "deleted";
  } else if (line.startsWith("rename from ")) {
    metadata.oldPath = parseHeaderPath(line.slice("rename from ".length), prefix);
    metadata.malformed ||= metadata.oldPath === undefined;
  } else if (line.startsWith("rename to ")) {
    const path = parseHeaderPath(line.slice("rename to ".length), prefix);
    metadata.malformed ||= path === undefined;
    if (path !== undefined) metadata.path = path;
    metadata.status = "renamed";
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    metadata.binary = true;
  }
}

function parseHunkHeader(header: string): HunkCoordinates | undefined {
  if (header.length > GIT_EDITOR_DIFF_MAX_HEADER_CHARS) return undefined;
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

function diffLine(raw: string, oldLine: number, newLine: number): GitEditorDiffLine | undefined {
  const text = raw.slice(1);
  if (text.length > GIT_EDITOR_DIFF_MAX_LINE_CHARS || text.includes("\uFFFD")) return undefined;
  if (raw.startsWith(" ")) return { kind: "ctx", oldLine, newLine, text };
  if (raw.startsWith("+")) return { kind: "add", oldLine: null, newLine, text };
  if (raw.startsWith("-")) return { kind: "del", oldLine, newLine: null, text };
  if (raw === "\\ No newline at end of file") {
    return { kind: "meta", oldLine: null, newLine: null, text: raw };
  }
  return undefined;
}

// Hunk parsing must advance four coupled counters while rejecting malformed line grammars.
// eslint-disable-next-line complexity
function parseOneHunk(
  lines: readonly string[],
  start: number,
): {
  readonly hunk?: GitEditorDiffHunk;
  readonly next: number;
  readonly malformed: boolean;
  readonly fatal: boolean;
} {
  const coordinates = parseHunkHeader(lines[start] ?? "");
  let index = start + 1;
  if (coordinates === undefined) return { next: index, malformed: true, fatal: true };
  const parsedLines: GitEditorDiffLine[] = [];
  let oldLine = coordinates.oldStart;
  let newLine = coordinates.newStart;
  let oldConsumed = 0;
  let newConsumed = 0;
  let malformed = false;
  while (index < lines.length && !(lines[index] ?? "").startsWith("@@ ")) {
    const raw = lines[index] ?? "";
    if (raw.length === 0 && index === lines.length - 1) break;
    const parsed = diffLine(raw, oldLine, newLine);
    if (parsed === undefined || parsedLines.length >= GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK) {
      malformed = true;
    } else {
      parsedLines.push(parsed);
      if (parsed.kind === "ctx" || parsed.kind === "del") {
        oldLine += 1;
        oldConsumed += 1;
      }
      if (parsed.kind === "ctx" || parsed.kind === "add") {
        newLine += 1;
        newConsumed += 1;
      }
    }
    index += 1;
  }
  malformed ||= oldConsumed !== coordinates.oldCount || newConsumed !== coordinates.newCount;
  return malformed
    ? { next: index, malformed: true, fatal: false }
    : {
        next: index,
        malformed: false,
        fatal: false,
        hunk: { ...coordinates, lines: parsedLines, truncated: false },
      };
}

function parseHunks(lines: readonly string[]): ParsedHunks {
  const hunks: GitEditorDiffHunk[] = [];
  let malformed = false;
  let fatal = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("@@")) continue;
    const parsed = parseOneHunk(lines, index);
    index = parsed.next - 1;
    if (parsed.malformed) malformed = true;
    if (parsed.fatal) fatal = true;
    else if (parsed.hunk !== undefined && hunks.length < GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE) {
      hunks.push(parsed.hunk);
    } else malformed = true;
  }
  const flatLines = hunks.flatMap((hunk) => hunk.lines);
  return {
    hunks,
    addedLines: flatLines.filter((line) => line.kind === "add").length,
    removedLines: flatLines.filter((line) => line.kind === "del").length,
    malformed,
    fatal,
  };
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
// eslint-disable-next-line complexity
function parseFile(
  lines: readonly string[],
  options: GitUnifiedDiffParseOptions,
  isFinal: boolean,
): GitEditorDiffFile | undefined {
  if (lines.some((line) => line.includes("\uFFFD"))) return undefined;
  const metadata = initialMetadata(lines[0] ?? "", options.selectedRootPrefix);
  if (metadata === undefined) return undefined;
  for (const line of lines.slice(1)) updateMetadata(metadata, line, options.selectedRootPrefix);
  const parsed = parseHunks(lines);
  if (parsed.fatal) return undefined;
  const truncated = parsed.malformed || (isFinal && options.processTruncated);
  if (metadata.malformed) return undefined;
  const hunks =
    isFinal && options.processTruncated && parsed.hunks.length > 0
      ? parsed.hunks.slice(0, -1)
      : parsed.hunks;
  const totals = lineTotals(hunks);
  return {
    path: metadata.path,
    ...(metadata.status === "renamed" && metadata.oldPath !== undefined
      ? { oldPath: metadata.oldPath }
      : {}),
    layer: options.scope === "staged" ? "staged" : "worktree",
    status: metadata.status,
    binary: metadata.binary,
    hunks: metadata.binary ? [] : hunks,
    addedLines: metadata.binary ? 0 : totals.addedLines,
    removedLines: metadata.binary ? 0 : totals.removedLines,
    truncated,
  };
}

function fileSections(input: string): readonly (readonly string[])[] {
  const sections: string[][] = [];
  for (const line of input.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return sections;
}

export function parseGitEditorUnifiedDiff(
  input: string,
  options: GitUnifiedDiffParseOptions,
): ParsedGitUnifiedDiff {
  const sections = fileSections(input);
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
