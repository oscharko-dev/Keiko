/**
 * Pure, deterministic application of {@link EditorTextEdit}s to a string (Issue #1195).
 *
 * The patch-preview adapter ({@link import("./patch-preview.js").buildPatchPreview}) renders a diff
 * by applying a generated patch's edits to the original buffer text in memory — it never writes to
 * disk and never calls a Node-domain patch tool (the unified-diff parser/applier in `keiko-tools` is
 * server-side and operates on a different, hunk-based representation; the editor's #1192 contract is
 * a list of `{range, newText}` edits). This module is the small browser-safe helper that performs
 * that text transform; it parses nothing.
 *
 * Positions are zero-based with UTF-16 code-unit columns (the {@link EditorPosition} contract) and
 * lines are delimited by `\n` (Monaco's normalised EOL). The transform is offset-based and applies
 * edits left-to-right; overlapping edits are a malformed patch and surface as a typed error so the
 * adapter can mark the file unrenderable rather than emit a silently corrupted preview.
 */
import type { EditorPosition, EditorTextEdit } from "./types.js";

/** Thrown when two edits in the same file overlap; a malformed patch cannot be previewed safely. */
export class OverlappingPatchEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlappingPatchEditError";
  }
}

/** Type guard used by the adapter to classify an apply failure as a (recoverable) overlap. */
export function isOverlappingPatchEditError(value: unknown): value is OverlappingPatchEditError {
  return value instanceof OverlappingPatchEditError;
}

/**
 * The absolute character offset at which each line of `text` starts. `lineStarts[0]` is always `0`;
 * `lineStarts[i]` is the offset just past the `i-1`th `\n`. There is always one more conceptual line
 * than there are newlines, matching `text.split("\n")`.
 */
function buildLineStarts(text: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * Resolve a {@link EditorPosition} to an absolute character offset in `text`, clamping defensively:
 * a line past the end maps to `text.length`, and a column past a line's end maps to that line's end
 * (the next `\n`, or `text.length` for the final line). Clamping keeps a preview render-safe for a
 * slightly out-of-range generated position instead of throwing.
 */
function positionToOffset(
  text: string,
  lineStarts: readonly number[],
  position: EditorPosition,
): number {
  if (position.line < 0) {
    return 0;
  }
  if (position.line >= lineStarts.length) {
    return text.length;
  }
  const lineStart = lineStarts[position.line] ?? text.length;
  const nextLineStart = lineStarts[position.line + 1];
  const lineEnd = nextLineStart === undefined ? text.length : nextLineStart - 1;
  const column = position.column < 0 ? 0 : position.column;
  return Math.min(lineStart + column, lineEnd);
}

interface ResolvedEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

function resolveEdit(
  text: string,
  lineStarts: readonly number[],
  edit: EditorTextEdit,
): ResolvedEdit {
  const start = positionToOffset(text, lineStarts, edit.range.start);
  const end = positionToOffset(text, lineStarts, edit.range.end);
  // An inverted range is malformed; collapse it to an insertion at `start` rather than slicing
  // backwards (which would duplicate text). This is defensive — a well-formed patch never inverts.
  return { start, end: Math.max(start, end), newText: edit.newText };
}

/**
 * Apply `edits` to `original` and return the resulting text. Edits are resolved to offsets, sorted
 * by start position, and spliced left-to-right. Two edits whose spans overlap throw
 * {@link OverlappingPatchEditError}. The input is never mutated.
 */
export function applyTextEditsToText(original: string, edits: readonly EditorTextEdit[]): string {
  if (edits.length === 0) {
    return original;
  }
  const lineStarts = buildLineStarts(original);
  const resolved = edits
    .map((edit) => resolveEdit(original, lineStarts, edit))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));

  const out: string[] = [];
  let cursor = 0;
  for (const edit of resolved) {
    if (edit.start < cursor) {
      throw new OverlappingPatchEditError("patch contains overlapping edits");
    }
    out.push(original.slice(cursor, edit.start), edit.newText);
    cursor = edit.end;
  }
  out.push(original.slice(cursor));
  return out.join("");
}
