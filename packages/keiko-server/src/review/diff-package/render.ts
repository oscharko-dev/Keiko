// Reviewer-facing rendering of the review diff package (Issue #4134).
//
// Port of PR-Agent v0.49.0 (MIT) `decouple_and_convert_to_hunks_with_lines_numbers`: each hunk is
// shown as a `__new hunk__` with head line numbers (context and added lines) and, when it removes
// anything, an `__old hunk__` without numbers (context and removed lines). The reviewer cites head
// line numbers, which child 6 validates against the head commit. File names are untrusted: they
// appear only through `quoteReviewPath`, so a name cannot end a line or forge another header, and
// every code line starts with its number or its marker, never at a header's position.

import type { PatchHunk, ReviewDiffFileStatus } from "@oscharko-dev/keiko-contracts";
import { quoteReviewPath } from "./paths.js";

export interface ReviewDiffRenderedFile {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status: ReviewDiffFileStatus;
}

const STATUS_NOTES: Readonly<Partial<Record<ReviewDiffFileStatus, string>>> = {
  added: " (new file)",
  "type-changed": " (type changed)",
};

/** The header line(s) of one file section. */
export function renderReviewFileHeader(file: ReviewDiffRenderedFile): string {
  const renamed =
    file.previousPath === undefined ? "" : ` (renamed from ${quoteReviewPath(file.previousPath)})`;
  return `## File: ${quoteReviewPath(file.path)}${renamed}${STATUS_NOTES[file.status] ?? ""}\n`;
}

function isBody(line: string): boolean {
  const marker = line.charAt(0);
  return marker === " " || marker === "+" || marker === "-";
}

/** One hunk in PR-Agent's decoupled form. */
export function renderReviewHunk(hunk: PatchHunk): string {
  const body = hunk.lines.filter(isBody);
  const header = `\n@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@\n`;
  const newLines = body.filter((line) => !line.startsWith("-"));
  const rendered = [header, "__new hunk__\n"];
  newLines.forEach((line, index) => {
    rendered.push(`${String(hunk.newStart + index)} ${line}\n`);
  });
  if (body.some((line) => line.startsWith("-"))) {
    rendered.push("__old hunk__\n");
    for (const line of body) if (!line.startsWith("+")) rendered.push(`${line}\n`);
  }
  return rendered.join("");
}
