// Text and identifier primitives of the requirement inventory (#4179, Epic #4173).

import { normaliseText } from "./assertions.js";

export interface Line {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function splitLines(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const rawEnd = newline === -1 ? text.length : newline;
    const end = rawEnd > start && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ text: text.slice(start, end), start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

export function lineAt(lines: readonly Line[], index: number): Line {
  const line = lines[index];
  if (line === undefined) throw new RangeError("line index outside the document");
  return line;
}

/** NFKC, invisible characters removed, whitespace collapsed. */
export function collapse(value: string): string {
  return normaliseText(value).replaceAll(/\s+/gu, " ").trim();
}

export const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+/u;
export const LIST_MARKER = /^\s*(?:[-*•·]\s+|\d+[.)]\s+|[a-z][.)]\s+)/iu;

const EMPHASIS_MARKS = ["**", "__", "`"] as const;

/** The text without the emphasis marks around it; plain scans, no backtracking. */
function stripEmphasis(value: string): string {
  let text = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const mark of EMPHASIS_MARKS) {
      if (text.startsWith(mark)) {
        text = text.slice(mark.length);
        changed = true;
      }
      if (text.endsWith(mark)) {
        text = text.slice(0, -mark.length);
        changed = true;
      }
    }
  }
  return text;
}

/** A line without heading hashes, list markers and emphasis marks. */
export function bare(raw: string): string {
  const noHeading = raw.replace(MARKDOWN_HEADING, "");
  return collapse(stripEmphasis(noHeading.replace(LIST_MARKER, "")));
}

export function trimTrailingMarks(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "." || value[end - 1] === ";")) end -= 1;
  return value.slice(0, end);
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

/**
 * `PREFIX-NUMBER`: one or more upper-case segments joined by `-` or `_`, then a number with an
 * optional dotted tail (`R-12`, `FR-12.3`, `REQ_003`, `REQ-FUNC-001`).
 */
const ID_SOURCE = String.raw`[A-Z][A-Z0-9]*(?:[-_][A-Z][A-Z0-9]*)*[-_]\d{1,8}(?:\.\d{1,3})*`;
export const ID_START = new RegExp(String.raw`^\[?(${ID_SOURCE})(\])?`, "u");
export const ID_EXACT = new RegExp(String.raw`^\[?(${ID_SOURCE})\]?$`, "u");
export const ID_ANYWHERE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_-])${ID_SOURCE}(?![\p{L}\p{N}_-])`,
  "u",
);

/** The identifier without its number: `REQ-FUNC-001` has the prefix `REQ-FUNC`. */
export function idPrefix(id: string): string {
  const cut = Math.max(id.lastIndexOf("-"), id.lastIndexOf("_"));
  return cut < 0 ? id : id.slice(0, cut);
}
