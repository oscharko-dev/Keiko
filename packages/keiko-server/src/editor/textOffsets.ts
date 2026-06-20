// Pure conversion between zero-based {line, character} positions (LSP 3.17) and absolute UTF-16
// code-unit offsets in a source buffer (Issue #1198). Deterministic: it maps an editor position
// onto the TypeScript offset model and maps analysis spans back to wire ranges. The TypeScript
// language service speaks in offsets; the editor wire contract speaks in line/character.

import type { LanguagePosition, LanguageRange } from "@oscharko-dev/keiko-contracts";

const LF = 0x0a;
const CR = 0x0d;

// The absolute offset at which each line begins. `lineStarts[0]` is always 0. Both LF and CRLF
// terminate a line; a lone CR also starts a new line (old-mac line endings).
export function computeLineStarts(text: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === LF) {
      starts.push(index + 1);
    } else if (code === CR && text.charCodeAt(index + 1) !== LF) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// The offset just past the last content character of a line, excluding its terminator. Used to
// clamp a character offset so it never lands inside a line break. Never precedes `lineStart`, so the
// phantom empty line after a trailing newline maps to end-of-buffer rather than the prior line.
function lineContentEnd(text: string, lineStarts: readonly number[], line: number): number {
  const lineStart = lineStarts[line] ?? 0;
  const nextLineStart =
    line + 1 < lineStarts.length ? (lineStarts[line + 1] ?? text.length) : text.length;
  let end = nextLineStart;
  if (end > lineStart && text.charCodeAt(end - 1) === LF) {
    end -= 1;
    if (end > lineStart && text.charCodeAt(end - 1) === CR) {
      end -= 1;
    }
  } else if (end > lineStart && text.charCodeAt(end - 1) === CR) {
    // Old-Mac, lone-CR line terminator: strip it so a character offset never lands on the CR.
    end -= 1;
  }
  return end;
}

// Maps a zero-based {line, character} position to an absolute offset, clamping out-of-range input
// into the buffer so a malformed editor position can never index outside the text.
export function positionToOffset(
  text: string,
  lineStarts: readonly number[],
  position: LanguagePosition,
): number {
  const line = clamp(position.line, 0, lineStarts.length - 1);
  const lineStart = lineStarts[line] ?? 0;
  const contentEnd = lineContentEnd(text, lineStarts, line);
  return clamp(lineStart + position.character, lineStart, contentEnd);
}

// Maps an absolute offset back to a zero-based {line, character} position via binary search over the
// line-start table.
export function offsetToPosition(
  text: string,
  lineStarts: readonly number[],
  offset: number,
): LanguagePosition {
  const bounded = clamp(offset, 0, text.length);
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if ((lineStarts[mid] ?? 0) <= bounded) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low, character: bounded - (lineStarts[low] ?? 0) };
}

// Maps a TypeScript text span (start offset + length) to a wire range. A missing start (some global
// diagnostics carry none) collapses to the buffer origin.
export function spanToRange(
  text: string,
  lineStarts: readonly number[],
  start: number | undefined,
  length: number | undefined,
): LanguageRange {
  const safeStart = start ?? 0;
  const safeLength = length ?? 0;
  return {
    start: offsetToPosition(text, lineStarts, safeStart),
    end: offsetToPosition(text, lineStarts, safeStart + safeLength),
  };
}
