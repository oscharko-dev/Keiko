// Pure windowing plan for a parsed diff (#4108). A governed changeset may be up to 8 MiB, about a
// hundred thousand diff lines, and a browser tab that mounts all of them at once freezes. A diff
// above DIFF_WINDOW_THRESHOLD_ROWS is therefore shown one file and one page of DIFF_WINDOW_PAGE_ROWS
// lines at a time. The plan never drops a line: every row belongs to exactly one page, and the
// caller shows the totals so a reader always knows what is not on screen. A diff at or below the
// threshold is not windowed at all and renders exactly as before.
//
// A page is a count of diff LINES (a hunk with no line counts one row so it stays reachable). The
// hunk header is repeated on a page that starts inside a hunk, so a page is readable by itself.

import type { GitEditorDiffFile, GitEditorDiffHunk } from "@oscharko-dev/keiko-contracts";

export const DIFF_WINDOW_THRESHOLD_ROWS = 2_000;
export const DIFF_WINDOW_PAGE_ROWS = 1_000;

export interface DiffFileMetrics {
  /** Reviewable rows: the diff lines of every hunk (at least one per hunk). */
  readonly rows: number;
  /** UTF-8 size of the diff text the file carries, one newline per line. */
  readonly bytes: number;
}

export interface DiffPage {
  /** The 0-based page shown, after clamping into the file's page range. */
  readonly page: number;
  readonly hunks: readonly GitEditorDiffHunk[];
  /** 1-based first and last row of the page, 0 and 0 for a file without rows. */
  readonly fromRow: number;
  readonly toRow: number;
  readonly pageCount: number;
}

const metricsByFile = new WeakMap<GitEditorDiffFile, DiffFileMetrics>();

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function hunkRows(hunk: GitEditorDiffHunk): number {
  return Math.max(hunk.lines.length, 1);
}

function measureFile(file: GitEditorDiffFile): DiffFileMetrics {
  let rows = 0;
  let bytes = 0;
  for (const hunk of file.hunks) {
    rows += hunkRows(hunk);
    bytes += utf8Length(hunk.header) + 1;
    for (const line of hunk.lines) bytes += utf8Length(line.text) + 1;
  }
  return { rows, bytes };
}

/** Rows and bytes of one file, measured once per parsed file object. */
export function diffFileMetrics(file: GitEditorDiffFile): DiffFileMetrics {
  const known = metricsByFile.get(file);
  if (known !== undefined) return known;
  const measured = measureFile(file);
  metricsByFile.set(file, measured);
  return measured;
}

export function totalDiffRows(files: readonly GitEditorDiffFile[]): number {
  let rows = 0;
  for (const file of files) rows += diffFileMetrics(file).rows;
  return rows;
}

export function isWindowedDiff(files: readonly GitEditorDiffFile[]): boolean {
  return totalDiffRows(files) > DIFF_WINDOW_THRESHOLD_ROWS;
}

export function diffPageCount(rows: number): number {
  return Math.max(1, Math.ceil(rows / DIFF_WINDOW_PAGE_ROWS));
}

function sliceHunk(
  hunk: GitEditorDiffHunk,
  hunkStart: number,
  fromIndex: number,
  toIndex: number,
): GitEditorDiffHunk | null {
  const rows = hunkRows(hunk);
  const first = Math.max(fromIndex, hunkStart) - hunkStart;
  const last = Math.min(toIndex, hunkStart + rows) - hunkStart;
  if (first >= last) return null;
  if (first === 0 && last >= hunk.lines.length) return hunk;
  return {
    ...hunk,
    lines: hunk.lines.slice(first, last),
    // The "incomplete" notice belongs to the end of the hunk, so only its last page carries it.
    truncated: hunk.truncated && last >= hunk.lines.length,
  };
}

/** The rows of one page of `file`; `page` is clamped into the file's page range. */
export function sliceDiffPage(file: GitEditorDiffFile, page: number): DiffPage {
  const { rows } = diffFileMetrics(file);
  const pageCount = diffPageCount(rows);
  const current = Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
  const fromIndex = current * DIFF_WINDOW_PAGE_ROWS;
  const toIndex = Math.min(rows, fromIndex + DIFF_WINDOW_PAGE_ROWS);
  const hunks: GitEditorDiffHunk[] = [];
  let hunkStart = 0;
  for (const hunk of file.hunks) {
    const slice = sliceHunk(hunk, hunkStart, fromIndex, toIndex);
    if (slice !== null) hunks.push(slice);
    hunkStart += hunkRows(hunk);
    if (hunkStart >= toIndex) break;
  }
  return {
    page: current,
    hunks,
    fromRow: rows === 0 ? 0 : fromIndex + 1,
    toRow: toIndex,
    pageCount,
  };
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/** A binary size such as `812 B`, `12.4 KiB` or `7.9 MiB`; `format` localizes the number. */
export function formatDiffBytes(bytes: number, format: (value: number) => string): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${format(unit === 0 ? value : Math.round(value * 10) / 10)} ${BYTE_UNITS[unit] ?? "B"}`;
}
