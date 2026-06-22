/**
 * Pure coordinate conversion at the Monaco boundary (Issue #1194).
 *
 * Monaco positions are 1-based (`lineNumber`/`column` start at 1); the editor contracts
 * ({@link EditorPosition}/{@link EditorRange}) are 0-based, with `column` counting UTF-16 units.
 * The conversion happens only here, so the rest of the component speaks the contract's coordinate
 * system. The `monaco-editor` import is type-only.
 */
import type { EditorPosition, EditorRange } from "../index.js";

/** Minimal 1-based position shape (`monaco.Position` / `monaco.IPosition`). */
export interface MonacoPositionLike {
  readonly lineNumber: number;
  readonly column: number;
}

/**
 * Minimal selection shape (`monaco.Selection` extends `monaco.Range`). `isEmpty()` reports whether
 * the selection is collapsed (start === end), i.e. a caret with no highlighted span.
 */
export interface MonacoSelectionLike {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  isEmpty(): boolean;
}

/** Convert a 1-based Monaco position to the 0-based {@link EditorPosition} contract. */
export function monacoPositionToEditorPosition(position: MonacoPositionLike): EditorPosition {
  return { line: position.lineNumber - 1, column: position.column - 1 };
}

/**
 * Convert a Monaco selection to an {@link EditorRange}, or `null` when the selection is collapsed
 * (a caret with no span) — callers report "no selection" rather than a zero-width range.
 */
export function monacoSelectionToEditorRange(selection: MonacoSelectionLike): EditorRange | null {
  if (selection.isEmpty()) {
    return null;
  }
  return {
    start: { line: selection.startLineNumber - 1, column: selection.startColumn - 1 },
    end: { line: selection.endLineNumber - 1, column: selection.endColumn - 1 },
  };
}
