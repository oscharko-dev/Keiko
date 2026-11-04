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
    const end = lineEndAt(text, start);
    lines.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
    start = text[end] === "\r" && text[end + 1] === "\n" ? end + 2 : end + 1;
  }
  return lines;
}

/** Where the line that starts at `start` ends: before `\n`, `\r\n` or a lone `\r`. */
function lineEndAt(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") return index;
  }
  return text.length;
}

export function lineAt(lines: readonly Line[], index: number): Line {
  const line = lines[index];
  if (line === undefined) throw new RangeError("line index outside the document");
  return line;
}

/** Zero-width characters, the soft hyphen and the byte order mark: no reader sees them. */
const INVISIBLE = /[\u{AD}\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu;
/**
 * The look-alikes of the hyphen-minus a word processor types into an identifier (`FR‑1` with a
 * non-breaking hyphen): hyphen, non-breaking hyphen, figure dash and minus sign.
 */
const HYPHEN_LOOKALIKES = /[\u{2010}-\u{2012}\u{2212}]/gu;

/** NFKC, invisible characters removed, hyphen look-alikes unified, whitespace collapsed. */
export function collapse(value: string): string {
  return normaliseText(value)
    .replaceAll(INVISIBLE, "")
    .replaceAll(HYPHEN_LOOKALIKES, "-")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+/u;
export const LIST_MARKER = /^\s*(?:[-–—*•·]\s+|\d+[.)]\s+|[a-z][.)]\s+)/iu;

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

const THEMATIC_BREAK = /^\s*(?:[-–—―_*=~]\s*){3,}$/u;

/** A line of nothing but rule characters: the thematic break of Markdown and of typed text. */
export function isThematicBreak(raw: string): boolean {
  return THEMATIC_BREAK.test(raw);
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
/** A field whose value is one identifier (`Jira: KRED-29`), up to the whitespace behind it. */
export const ID_VALUE_FIELD = new RegExp(String.raw`^[^:]{1,40}: ?${ID_SOURCE}(?=\s)`, "u");
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
