/**
 * safe-markdown-math.ts — delimiter scanner for math spans inside prose.
 *
 * Pure and renderer-free: it decides only WHERE a complete `$…$`, `$$…$$`, `\(…\)` or `\[…\]`
 * span starts and ends, never what the TeX means. Typesetting stays with the renderer, which
 * validates the source again and falls back to the verbatim text on any error.
 *
 * Like the rest of the Markdown parser it uses no regular expression over untrusted text, and every
 * scan is bounded by `SAFE_MARKDOWN_MAX_MATH_CHARS`, so a hostile answer made of unmatched
 * delimiters costs a constant amount of work per candidate position.
 */

/**
 * Longest math source (in UTF-16 units) the parser claims and the renderers accept. A longer span
 * stays prose, so an adversarial answer cannot turn one paragraph into quadratic parser work or ask
 * the typesetter for an unbounded layout.
 */
export const SAFE_MARKDOWN_MAX_MATH_CHARS = 4000;

export interface MathSpan {
  /** Index just after the closing delimiter. */
  readonly end: number;
  /** The TeX between the delimiters, without surrounding whitespace. */
  readonly text: string;
  /** The verbatim source including both delimiters. */
  readonly raw: string;
  readonly display: boolean;
}

function isWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function span(raw: string, start: number, end: number, open: number, display: boolean): MathSpan {
  return {
    end,
    text: raw.slice(start + open, end - open).trim(),
    raw: raw.slice(start, end),
    display,
  };
}

// The scan window is a bounded slice, so a missing partner is found absent after at most
// SAFE_MARKDOWN_MAX_MATH_CHARS characters instead of after the rest of the answer.
function scanPaired(
  raw: string,
  start: number,
  open: string,
  close: string,
  display: boolean,
): MathSpan | null {
  const bodyStart = start + open.length;
  const window = raw.slice(bodyStart, bodyStart + SAFE_MARKDOWN_MAX_MATH_CHARS + close.length);
  const offset = window.indexOf(close);
  if (offset <= 0) return null;
  const found = span(raw, start, bodyStart + offset + close.length, open.length, display);
  // `$$ $$` and `\(  \)` typeset nothing: leave them as written.
  return found.text.length === 0 ? null : found;
}

// Index of the first unescaped `$` at or after `from`, within the bounded window; -1 when absent.
function nextUnescapedDollar(raw: string, from: number): number {
  const limit = Math.min(raw.length, from + SAFE_MARKDOWN_MAX_MATH_CHARS + 1);
  for (let index = from; index < limit; index += 1) {
    const char = raw[index];
    if (char === "\\") index += 1;
    else if (char === "$") return index;
  }
  return -1;
}

// Pandoc's rule for a single dollar: the opener is followed by non-space, the closer is preceded by
// non-space and not followed by a digit. Only the FIRST candidate partner is tried, so "costs $5 and
// $6 total" is prose: its first partner is preceded by a space and the scan stops there.
function scanInlineDollar(raw: string, start: number): MathSpan | null {
  const first = raw[start + 1];
  if (first === undefined || isWhitespace(first)) return null;
  const closeAt = nextUnescapedDollar(raw, start + 1);
  if (closeAt === -1 || isWhitespace(raw[closeAt - 1]) || isDigit(raw[closeAt + 1])) return null;
  return span(raw, start, closeAt + 1, 1, false);
}

/** The complete math span that opens at `pos`, or null when none does. */
export function scanMathSpan(raw: string, pos: number): MathSpan | null {
  const char = raw[pos];
  if (char === "$") {
    return raw[pos + 1] === "$"
      ? scanPaired(raw, pos, "$$", "$$", true)
      : scanInlineDollar(raw, pos);
  }
  if (char !== "\\") return null;
  const next = raw[pos + 1];
  if (next === "(") return scanPaired(raw, pos, String.raw`\(`, String.raw`\)`, false);
  return next === "[" ? scanPaired(raw, pos, String.raw`\[`, String.raw`\]`, true) : null;
}
