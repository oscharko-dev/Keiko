// Hunk context shaping for the review diff package (Issue #4134).
//
// Port of PR-Agent v0.49.0 (MIT) `extend_patch` / `process_patch_lines`: every hunk carries a
// fixed number of unchanged lines before and after its changes, and its leading context grows up
// to the enclosing function or class header when that header lies within the dynamic window.
// PR-Agent extends a provider patch by reading both file versions; Keiko asks Git for a patch with
// enough symmetric context (`-U<max>`) and shapes it here, so no file content is read twice and no
// second diff algorithm exists. Git never merges two changes more than `2 * max` lines apart, so
// each Git hunk is shaped on its own: changes closer than `before + after` unchanged lines share
// one hunk, farther ones are split, exactly as extending separate minimal hunks would produce.

import type { PatchHunk, ReviewDiffLanguage } from "@oscharko-dev/keiko-contracts";
import { isEnclosingHeader } from "./languages.js";

export interface ReviewDiffContextOptions {
  readonly before: number;
  readonly after: number;
  readonly dynamicMax: number;
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

interface BodyLine {
  readonly marker: " " | "+" | "-";
  readonly text: string;
  readonly noNewline: boolean;
  /** Old and new lines consumed before this line. */
  readonly oldBefore: number;
  readonly newBefore: number;
}

function isBodyMarker(marker: string): marker is BodyLine["marker"] {
  return marker === " " || marker === "+" || marker === "-";
}

function markLastNoNewline(lines: BodyLine[]): void {
  const previous = lines.pop();
  if (previous !== undefined) lines.push({ ...previous, noNewline: true });
}

function bodyLines(hunk: PatchHunk): BodyLine[] {
  const lines: BodyLine[] = [];
  let oldNext = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newNext = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  for (const line of hunk.lines) {
    const marker = line.charAt(0);
    if (marker === "\\") markLastNoNewline(lines);
    if (!isBodyMarker(marker)) continue;
    const text = line.slice(1);
    lines.push({ marker, text, noNewline: false, oldBefore: oldNext - 1, newBefore: newNext - 1 });
    if (marker !== "+") oldNext += 1;
    if (marker !== "-") newNext += 1;
  }
  return lines;
}

interface ChangeGroup {
  readonly first: number;
  readonly last: number;
}

function changeGroups(lines: readonly BodyLine[], joinGap: number): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  let current: { first: number; last: number } | undefined;
  lines.forEach((line, index) => {
    if (line.marker === " ") return;
    if (current !== undefined && index - current.last - 1 <= joinGap) current.last = index;
    else {
      if (current !== undefined) groups.push(current);
      current = { first: index, last: index };
    }
  });
  if (current !== undefined) groups.push(current);
  return groups;
}

function leadingContext(
  lines: readonly BodyLine[],
  first: number,
  lowerBound: number,
  options: ReviewDiffContextOptions & { readonly language: ReviewDiffLanguage },
): number {
  const available = first - lowerBound;
  const lead = Math.min(options.before, available);
  const window = Math.min(options.dynamicMax, available);
  for (let index = first - 1; index >= first - window; index -= 1) {
    if (isEnclosingHeader(options.language, lines[index]?.text ?? "")) {
      return Math.max(lead, first - index);
    }
  }
  return lead;
}

function emitHunk(lines: readonly BodyLine[], start: number, end: number): PatchHunk {
  const slice = lines.slice(start, end + 1);
  const oldLines = slice.filter((line) => line.marker !== "+").length;
  const newLines = slice.filter((line) => line.marker !== "-").length;
  const firstLine = slice[0];
  const oldBefore = firstLine?.oldBefore ?? 0;
  const newBefore = firstLine?.newBefore ?? 0;
  return {
    oldStart: oldLines > 0 ? oldBefore + 1 : oldBefore,
    oldLines,
    newStart: newLines > 0 ? newBefore + 1 : newBefore,
    newLines,
    lines: slice.flatMap((line) => {
      const body = `${line.marker}${line.text}`;
      return line.noNewline ? [body, NO_NEWLINE_MARKER] : [body];
    }),
  };
}

/**
 * Reshapes the hunks of a `-U<n>` patch (n at least `before`, `after` and `dynamicMax`) to the
 * package's context. The line numbers of every emitted hunk are those of the base and head blobs.
 */
export function shapeReviewHunks(
  hunks: readonly PatchHunk[],
  options: ReviewDiffContextOptions & { readonly language: ReviewDiffLanguage },
): PatchHunk[] {
  const shaped: PatchHunk[] = [];
  for (const hunk of hunks) {
    const lines = bodyLines(hunk);
    let lowerBound = 0;
    for (const group of changeGroups(lines, options.before + options.after)) {
      const start = group.first - leadingContext(lines, group.first, lowerBound, options);
      const end = Math.min(group.last + options.after, lines.length - 1);
      shaped.push(emitHunk(lines, start, end));
      lowerBound = end + 1;
    }
  }
  return shaped;
}

/** The single hunk of an added file: every line of the head blob, numbered from 1. */
export function addedFileHunk(content: string): PatchHunk | undefined {
  if (content.length === 0) return undefined;
  const endsWithNewline = content.endsWith("\n");
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split("\n");
  const body = lines.map((line) => `+${line}`);
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: endsWithNewline ? body : [...body, NO_NEWLINE_MARKER],
  };
}
