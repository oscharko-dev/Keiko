/**
 * Pure, deterministic range-mapping helpers (Issue #1192).
 *
 * No clocks, no randomness, no IO. {@link mapPositionAfterEdit} / {@link mapRangeAfterEdit} translate
 * editor coordinates to where they land once a single {@link EditorTextEdit} has been applied, so a
 * pending completion or diagnostic range stays valid after the buffer changes underneath it.
 */
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
  const segments = newText.split("\n");
  // `split` always yields at least one segment, but `noUncheckedIndexedAccess` types the access as
  // possibly-undefined; the `?? ""` is load-bearing for the compiler, never reached at runtime.
  const lastSegment = segments[segments.length - 1] ?? "";
  return { addedLines: segments.length - 1, lastLineLength: lastSegment.length };
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
