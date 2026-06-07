// Pure unified-diff parser. No I/O, no globals.
// Payload caps:
// - MAX_DIFF_BYTES (512 KB) — large diffs truncate at byte boundary then at the previous newline
//   so the prefix parses cleanly.
// - MAX_DIFF_FILES (400 entries, issue #645) — diffs with more file headers cap the rendered file
//   list and set `truncated: true`. Prevents the Review widget from doing unbounded work on the
//   `files` array for large repository / generated patches.

export type DiffLineKind = "ctx" | "add" | "del" | "meta";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Old-side line number (1-based) or null for added/meta lines. */
  readonly oldLine: number | null;
  /** New-side line number (1-based) or null for deleted/meta lines. */
  readonly newLine: number | null;
  /** Source text; leading +/-/space stripped for add/del/ctx. */
  readonly text: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  /** Path from the b/ side, falling back to a/ for old-only renames. */
  readonly path: string;
  /** Old path when this is a rename (a/ differs from b/). */
  readonly oldPath?: string;
  readonly hunks: readonly DiffHunk[];
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface DiffParseResult {
  readonly files: readonly DiffFile[];
  /** True when the input exceeded MAX_DIFF_BYTES and was truncated. */
  readonly truncated: boolean;
  /** Total byte length of the raw input (before truncation). */
  readonly totalBytes: number;
}

// 512 KB cap keeps the renderer fast; large diffs use the evidence manifest.
export const MAX_DIFF_BYTES = 512 * 1024;

// Issue #645: hard cap on the number of files surfaced to the Review widget. The remaining file
// headers in the parsed prefix are dropped and `truncated:true` signals the renderer to render a
// "truncated" indicator instead of an unbounded list.
export const MAX_DIFF_FILES = 400;

// --- helpers ----------------------------------------------------------------

function stripGitPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Parse @@ -oldStart[,oldCount] +newStart[,newCount] @@ … */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) };
}

interface MutableHunk {
  header: string;
  lines: DiffLine[];
}

interface MutableFile {
  path: string;
  oldPath?: string;
  hunks: MutableHunk[];
  addedLines: number;
  removedLines: number;
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

  if (totalBytes > MAX_DIFF_BYTES) {
    truncated = true;
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
        const base: MutableFile = { path, hunks: [], addedLines: 0, removedLines: 0 };
        if (oldPath !== path) base.oldPath = oldPath;
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
        current = { path, hunks: [], addedLines: 0, removedLines: 0 };
      } else if (rest !== "/dev/null" && current !== null) {
        // Update oldPath when we see the --- line after diff --git
        const oldPath = stripGitPrefix(rest);
        if (oldPath !== current.path) {
          current.oldPath = oldPath;
        }
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
        current = { path: stripGitPrefix(rest), hunks: [], addedLines: 0, removedLines: 0 };
      }
      i++;
      continue;
    }

    // Hunk header
    if (line.startsWith("@@ ")) {
      if (current === null) {
        // Hunk without a file header — create an anonymous file entry
        current = { path: "(unknown)", hunks: [], addedLines: 0, removedLines: 0 };
      }
      flushHunk();
      const pos = parseHunkHeader(line);
      oldLine = pos?.oldStart ?? 1;
      newLine = pos?.newStart ?? 1;
      currentHunk = { header: line, lines: [] };
      i++;
      continue;
    }

    i++;
  }

  flushFile();

  return { files, truncated, totalBytes };
}
