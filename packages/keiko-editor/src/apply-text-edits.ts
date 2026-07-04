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
 * Positions are zero-based with UTF-16 code-unit columns (the {@link EditorPosition} contract). Line
 * starts and position→offset resolution come from the shared, DOM-free {@link computeLineStarts} /
 * {@link positionToOffset} leaf (`@oscharko-dev/keiko-contracts/line-offsets`), which the server language service also uses
 * (GEN-DUP-SEMANTIC-017); it is LF, CRLF, AND lone-CR aware, so a generated patch or a
 * non-normalised buffer that carries CRLF no longer mis-offsets by one per preceding CR. Editor
 * `{ line, column }` positions cross into the leaf's `{ line, character }` wire shape through the
 * {@link toLanguagePosition} adapter (GEN-MAINT-NAMING-002). The transform is offset-based and
 * applies edits left-to-right; overlapping edits are a malformed patch and surface as a typed error
 * so the adapter can mark the file unrenderable rather than emit a silently corrupted preview.
 */
import {
  computeLineStarts,
  positionToOffset as positionToOffsetLeaf,
} from "@oscharko-dev/keiko-contracts/line-offsets";
import { toLanguagePosition } from "./position-adapters.js";
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
 * Resolve a {@link EditorPosition} to an absolute character offset in `text` via the shared,
 * CRLF/lone-CR-aware {@link positionToOffsetLeaf} primitive, converting the editor `{ line, column }`
 * spelling to the leaf's `{ line, character }` wire shape with {@link toLanguagePosition}. Clamping
 * keeps a preview render-safe for a slightly out-of-range generated position instead of throwing: a
 * column past a line's content end maps to that line's content end (excluding its terminator, so a
 * CRLF/lone-CR buffer no longer mis-offsets — GEN-DUP-SEMANTIC-017). A line past the end maps to the
 * end of the buffer (append), preserving the patch-preview contract: an over-large generated line
 * appends rather than snapping back to the last existing line's start.
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
  return positionToOffsetLeaf(text, lineStarts, toLanguagePosition(position));
}

interface ResolvedEdit {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

interface ByteLimitState {
  bytes: number;
  truncated: boolean;
}

export interface BoundedTextEditResult {
  readonly text: string;
  readonly truncated: boolean;
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
  const lineStarts = computeLineStarts(original);
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

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function appendWithinByteLimit(
  out: string[],
  text: string,
  maxBytes: number,
  state: ByteLimitState,
): void {
  if (state.truncated || text.length === 0) {
    return;
  }
  if (maxBytes <= state.bytes) {
    state.truncated = true;
    return;
  }

  let end = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index) ?? 0;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const nextBytes = utf8ByteLength(codePoint);
    if (state.bytes + nextBytes > maxBytes) {
      if (end > 0) {
        out.push(text.slice(0, end));
      }
      state.truncated = true;
      return;
    }
    state.bytes += nextBytes;
    end = index + codeUnits;
    index += codeUnits;
  }

  out.push(text);
}

/**
 * Apply `edits` like {@link applyTextEditsToText}, but stop appending output once `maxBytes` would be
 * exceeded. The returned text is never larger than the byte budget and never splits a Unicode code
 * point. Overlap validation still runs across all edits.
 */
export function applyTextEditsToTextWithinLimit(
  original: string,
  edits: readonly EditorTextEdit[],
  maxBytes: number,
): BoundedTextEditResult {
  const state: ByteLimitState = { bytes: 0, truncated: false };
  if (edits.length === 0) {
    const out: string[] = [];
    appendWithinByteLimit(out, original, maxBytes, state);
    return { text: out.join(""), truncated: state.truncated };
  }

  const lineStarts = computeLineStarts(original);
  const resolved = edits
    .map((edit) => resolveEdit(original, lineStarts, edit))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));

  const out: string[] = [];
  let cursor = 0;
  for (const edit of resolved) {
    if (edit.start < cursor) {
      throw new OverlappingPatchEditError("patch contains overlapping edits");
    }
    appendWithinByteLimit(out, original.slice(cursor, edit.start), maxBytes, state);
    appendWithinByteLimit(out, edit.newText, maxBytes, state);
    cursor = edit.end;
  }
  appendWithinByteLimit(out, original.slice(cursor), maxBytes, state);
  return { text: out.join(""), truncated: state.truncated };
}
