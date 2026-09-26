/**
 * Pure, deterministic range-mapping helpers (Issue #1192).
 *
 * No clocks, no randomness, no IO. {@link mapPositionAfterEdit} / {@link mapRangeAfterEdit} translate
 * editor coordinates to where they land once a single {@link EditorTextEdit} has been applied, so a
 * pending completion or diagnostic range stays valid after the buffer changes underneath it.
 */
import { computeLineStarts } from "@oscharko-dev/keiko-contracts/line-offsets";

import type { EditorPosition, EditorRange, EditorTextEdit } from "./types.js";

/** Total order on positions: line first, then column. */
export function comparePositions(a: EditorPosition, b: EditorPosition): -1 | 0 | 1 {
  if (a.line !== b.line) {
    return a.line < b.line ? -1 : 1;
  }
  if (a.column !== b.column) {
    return a.column < b.column ? -1 : 1;
  }
  return 0;
}

export function isEmptyRange(range: EditorRange): boolean {
  return comparePositions(range.start, range.end) === 0;
}

/** Inclusive of both `start` and `end`. */
export function rangeContainsPosition(range: EditorRange, position: EditorPosition): boolean {
  return comparePositions(position, range.start) >= 0 && comparePositions(position, range.end) <= 0;
}

interface NewTextShape {
  readonly addedLines: number;
  readonly lastLineLength: number;
}

function measureNewText(newText: string): NewTextShape {
  // KEIKO-0590: delegate to the CRLF/lone-CR-aware shared line-start primitive so this side of the
  // edit matches apply-text-edits.ts's line-terminator semantics (GEN-DUP-SEMANTIC-017). An
  // LF-only `split("\n")` silently mis-counted lines when an inserted newText carried a lone CR.
  const lineStarts = computeLineStarts(newText);
  // computeLineStarts always yields at least one entry (starts[0] === 0); noUncheckedIndexedAccess
  // types the read as possibly-undefined, so the `?? 0` is load-bearing for the compiler only.
  const lastLineStart = lineStarts[lineStarts.length - 1] ?? 0;
  return { addedLines: lineStarts.length - 1, lastLineLength: newText.length - lastLineStart };
}

/**
 * Translate `position` to where it lands after `edit` is applied. A position at or before
 * `edit.range.start` is unchanged; a position inside the replaced range or exactly at its end
 * collapses to the end of the inserted text (the boundary-collapse rule); a position strictly after
 * `edit.range.end` shifts by the line/column delta between the replaced range and `edit.newText`.
 */
export function mapPositionAfterEdit(
  position: EditorPosition,
  edit: EditorTextEdit,
): EditorPosition {
  const { start, end } = edit.range;

  if (comparePositions(position, start) <= 0) {
    return position;
  }

  const { addedLines, lastLineLength } = measureNewText(edit.newText);
  const insertedEnd: EditorPosition =
    addedLines === 0
      ? { line: start.line, column: start.column + lastLineLength }
      : { line: start.line + addedLines, column: lastLineLength };

  if (comparePositions(position, end) <= 0) {
    return insertedEnd;
  }

  const lineDelta = insertedEnd.line - end.line;
  const onEndLine = position.line === end.line;
  const column = onEndLine ? insertedEnd.column + (position.column - end.column) : position.column;
  return { line: position.line + lineDelta, column };
}

export function mapRangeAfterEdit(range: EditorRange, edit: EditorTextEdit): EditorRange {
  return {
    start: mapPositionAfterEdit(range.start, edit),
    end: mapPositionAfterEdit(range.end, edit),
  };
}
