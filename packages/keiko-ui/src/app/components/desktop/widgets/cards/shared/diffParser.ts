// Pure unified-diff parser for legacy raw ReviewWidget input. No I/O, no globals. The parser emits
// the shared ADR-0127 contract shape; Git Client reads arrive pre-parsed from the bounded BFF route.
// Payload caps:
// - MAX_DIFF_BYTES (512 KB) — large diffs truncate at byte boundary then at the previous newline
//   so the prefix parses cleanly.
// - MAX_DIFF_FILES (400 entries, issue #645) — diffs with more file headers cap the rendered file
//   list and set `truncated: true`. Prevents the Review widget from doing unbounded work on the
//   `files` array for large repository / generated patches.

import {
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
  type GitEditorDiffFile,
  type GitEditorDiffHunk,
  type GitEditorDiffLine,
  type GitEditorDiffLineKind,
} from "@oscharko-dev/keiko-contracts";

export type DiffLineKind = GitEditorDiffLineKind;
export type DiffLine = GitEditorDiffLine;
export type DiffHunk = GitEditorDiffHunk;
export type DiffFile = GitEditorDiffFile;

export interface DiffParseResult {
  readonly files: readonly DiffFile[];
  /** True when the input exceeded MAX_DIFF_BYTES and was truncated. */
  readonly truncated: boolean;
  /** Total byte length of the raw input (before truncation). */
  readonly totalBytes: number;
}

// 512 KB cap keeps the renderer fast; large diffs use the evidence manifest.
export const MAX_DIFF_BYTES = GIT_EDITOR_DIFF_MAX_BYTES;

// Issue #645: hard cap on the number of files surfaced to the Review widget. The remaining file
// headers in the parsed prefix are dropped and `truncated:true` signals the renderer to render a
// "truncated" indicator instead of an unbounded list.
export const MAX_DIFF_FILES = GIT_EDITOR_DIFF_MAX_FILES;

// --- helpers ----------------------------------------------------------------

function stripGitPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Parse @@ -oldStart[,oldCount] +newStart[,newCount] @@ … */
function parseHunkHeader(
  line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null || m[1] === undefined || m[3] === undefined) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
    newStart: parseInt(m[3] ?? "1", 10),
    newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
  };
}

interface MutableHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  truncated: boolean;
}

interface MutableFile {
  path: string;
  oldPath?: string;
  layer: "worktree";
  status: GitEditorDiffFile["status"];
  binary: boolean;
  hunks: MutableHunk[];
  addedLines: number;
  removedLines: number;
  truncated: boolean;
}

function mutableFile(path: string): MutableFile {
  return {
    path,
    layer: "worktree",
    status: "modified",
    binary: false,
    hunks: [],
    addedLines: 0,
    removedLines: 0,
    truncated: false,
  };
}

// --- main parser ------------------------------------------------------------

export function parseUnifiedDiff(raw: string): DiffParseResult {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(raw).byteLength;

  if (raw.length === 0) {
    return { files: [], truncated: false, totalBytes: 0 };
  }

  let input = raw;
  let truncated = false;
  let byteTruncated = false;

  if (totalBytes > MAX_DIFF_BYTES) {
    truncated = true;
    byteTruncated = true;
    // Slice to byte boundary then trim to last complete line.
    const bytes = encoder.encode(raw);
    const slice = new TextDecoder().decode(bytes.slice(0, MAX_DIFF_BYTES));
    const lastNl = slice.lastIndexOf("\n");
    input = lastNl === -1 ? slice : slice.slice(0, lastNl + 1);
  }

  const rawLines = input.split("\n");
  // Remove the single trailing empty string that results from a terminal newline.
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  const files: MutableFile[] = [];
  let current: MutableFile | null = null;
  let currentHunk: MutableHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const flushHunk = (): void => {
    if (current !== null && currentHunk !== null) {
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushFile = (): void => {
    flushHunk();
    if (current !== null) {
      if (files.length < MAX_DIFF_FILES) {
        files.push(current);
      } else {
        truncated = true;
      }
    }
    current = null;
  };

  let i = 0;
  while (i < lines.length) {
    // noUncheckedIndexedAccess: the while guard ensures i is in bounds.
    const line = lines[i] ?? "";

    // git diff header: diff --git a/<path> b/<path>
    if (line.startsWith("diff --git ")) {
      flushFile();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m !== null && m[1] !== undefined && m[2] !== undefined) {
        const aPath = m[1];
        const bPath = m[2];
        const path = stripGitPrefix(`b/${bPath}`);
        const oldPath = stripGitPrefix(`a/${aPath}`);
        const base = mutableFile(path);
        if (oldPath !== path) {
          base.oldPath = oldPath;
          base.status = "renamed";
        }
        current = base;
      }
      i++;
      continue;
    }

    // Hunk content lines must be recognized before ---/+++ file headers: valid
    // added or deleted source text can begin with those header-like prefixes.
    if (currentHunk !== null) {
      if (line.startsWith("+")) {
        const dl: DiffLine = { kind: "add", oldLine: null, newLine: newLine, text: line.slice(1) };
        currentHunk.lines.push(dl);
        if (current !== null) current.addedLines++;
        newLine++;
        i++;
        continue;
      }
      if (line.startsWith("-")) {
        const dl: DiffLine = { kind: "del", oldLine: oldLine, newLine: null, text: line.slice(1) };
        currentHunk.lines.push(dl);
        if (current !== null) current.removedLines++;
        oldLine++;
        i++;
        continue;
      }
      if (line.startsWith("\\ ")) {
        // "\ No newline at end of file"
        const dl: DiffLine = { kind: "meta", oldLine: null, newLine: null, text: line };
        currentHunk.lines.push(dl);
        i++;
        continue;
      }
      // Context line (space prefix) or empty line within hunk
      if (line.startsWith(" ") || line === "") {
        const dl: DiffLine = {
          kind: "ctx",
          oldLine: oldLine,
          newLine: newLine,
          text: line.startsWith(" ") ? line.slice(1) : line,
        };
        currentHunk.lines.push(dl);
        oldLine++;
        newLine++;
        i++;
        continue;
      }
    }

    // --- a/path line (may start a file when no diff --git header)
    if (line.startsWith("--- ")) {
      const rest = line.slice(4);
      if (rest !== "/dev/null" && current === null) {
        flushFile();
        const path = stripGitPrefix(rest);
        current = mutableFile(path);
      } else if (rest !== "/dev/null" && current !== null) {
        // Update oldPath when we see the --- line after diff --git
        const oldPath = stripGitPrefix(rest);
        if (oldPath !== current.path) {
          current.oldPath = oldPath;
          current.status = "renamed";
        }
      } else if (rest === "/dev/null" && current !== null) {
        current.status = "added";
      }
      i++;
      continue;
    }

    // +++ b/path line
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4);
      if (rest !== "/dev/null" && current !== null) {
        current.path = stripGitPrefix(rest);
      } else if (rest !== "/dev/null") {
        flushFile();
        current = mutableFile(stripGitPrefix(rest));
      } else if (current !== null) {
        current.status = "deleted";
      }
      i++;
      continue;
    }

    // Hunk header
    if (line.startsWith("@@ ")) {
      if (current === null) {
        // Hunk without a file header — create an anonymous file entry
        current = mutableFile("(unknown)");
      }
      flushHunk();
      const pos = parseHunkHeader(line);
      oldLine = pos?.oldStart ?? 1;
      newLine = pos?.newStart ?? 1;
      currentHunk = {
        header: line,
        oldStart: pos?.oldStart ?? 1,
        oldCount: pos?.oldCount ?? 1,
        newStart: pos?.newStart ?? 1,
        newCount: pos?.newCount ?? 1,
        lines: [],
        truncated: false,
      };
      i++;
      continue;
    }

    if (
      current !== null &&
      (/^Binary files .+ differ$/u.test(line) || line === "GIT binary patch")
    ) {
      current.binary = true;
      i++;
      continue;
    }

    i++;
  }

  flushFile();

  if (byteTruncated) {
    const file = files.at(-1);
    if (file !== undefined) {
      file.truncated = true;
      const hunk = file.hunks.at(-1);
      if (hunk !== undefined) hunk.truncated = true;
    }
  }

  return { files, truncated, totalBytes };
}
