// Shared inline citation-marker grammar (grounded answers).
//
// A grounded answer cites its retrieved references with 1-based numeric markers. Models do not
// emit one integer per bracket: they write `[1]`, but also the grouped forms `[1, 7, 8]`, `[1,7]`
// and `[1; 2]`, and some (gpt-oss) use CJK lenticular `【1】` or fullwidth `［1］` glyphs. Four call
// sites once carried their own one-integer-per-bracket regex (citation attacher, faithfulness
// reconciliation, the SafeMarkdown renderer and the chat copy stripper); each of them silently
// ignored every grouped marker, so grouped citations rendered as plain text and were never linked
// or counted. This module is the ONE parser they share.
//
// Tolerance rules (marker text is untrusted model output):
//   * Open ∈ { `[`, `【`, `［` }, close ∈ { `]`, `】`, `］` }. Mismatched pairs (`[1】`) are accepted
//     intentionally; a model that mixes glyphs must not lose its citations.
//   * A group holds one or more integers separated by `,` `;` `，` `；` `、`, with optional spaces.
//     Leading zeros are accepted; the parsed value is what callers match against references.
//   * Ranges (`[1-3]`) are deliberately NOT expanded: `[0-9]`, `[1-5]` and `[2020-2024]` are far
//     more often a character class or a year span in the answer prose than a citation.
//   * Anything else inside the brackets (`[note]`, `[a.ts:1-2]`, `[1, x]`) is NOT a marker.
//   * Markdown code is never scanned: a fenced block (``` or ~~~) or an inline code span holds
//     code such as `const a = [1, 2, 3];`, never a citation (PR #3678 review).
//   * The scan is a single forward pass with no regular expression, so it stays linear in the text
//     length however many brackets or spaces the input holds.

/** One cited reference index inside a marker group, with the literal that names it on its own. */
export interface CitationMarkerEntry {
  /** The 1-based reference index the marker points at (0 is possible: callers range-check). */
  readonly index: number;
  /**
   * The canonical single-index literal for this entry, in the group's own bracket glyphs (`[7]`,
   * `【7】`, `[01]` keeps its leading zero). For an unpadded lone marker it equals the group text.
   */
  readonly marker: string;
}

/** A bracketed citation marker found in a text: one bracket pair holding one or more indices. */
export interface CitationMarkerGroup {
  /** Offset of the opening bracket in the scanned text. */
  readonly start: number;
  /** Offset just past the closing bracket in the scanned text. */
  readonly end: number;
  /** The exact matched text, brackets included. */
  readonly text: string;
  /** Every cited index in document order (duplicates are kept). */
  readonly indices: readonly number[];
  /** The same indices paired with the literal that names each one alone. */
  readonly entries: readonly CitationMarkerEntry[];
}

const OPEN_BRACKETS: ReadonlySet<string> = new Set(["[", "【", "［"]);
const CLOSE_BRACKETS: ReadonlySet<string> = new Set(["]", "】", "］"]);
const ITEM_SEPARATORS: ReadonlySet<string> = new Set([",", ";", "，", "；", "、"]);
const INLINE_SPACES: ReadonlySet<string> = new Set([" ", "\t", "\u00a0", "\u3000"]);

interface ItemScan {
  readonly digits: string;
  readonly next: number;
}

function isAsciiDigit(character: string): boolean {
  return character.length === 1 && character >= "0" && character <= "9";
}

function skipSpaces(text: string, from: number): number {
  let position = from;
  while (INLINE_SPACES.has(text.charAt(position))) position += 1;
  return position;
}

function readDigits(
  text: string,
  from: number,
): { readonly digits: string; readonly next: number } {
  let next = from;
  while (isAsciiDigit(text.charAt(next))) next += 1;
  return { digits: text.slice(from, next), next };
}

// One item: a run of ASCII digits that fits a safe integer. Returns its digits and the next offset.
function scanItem(text: string, from: number): ItemScan | undefined {
  const { digits, next } = readDigits(text, from);
  if (digits.length === 0 || !Number.isSafeInteger(Number.parseInt(digits, 10))) return undefined;
  return { digits, next };
}

interface GroupScan {
  readonly digits: readonly string[];
  readonly end: number;
}

// Scans the group body that starts right after an opening bracket at `bodyStart`.
function scanGroupBody(text: string, bodyStart: number): GroupScan | undefined {
  const digits: string[] = [];
  let position = skipSpaces(text, bodyStart);
  for (;;) {
    const item = scanItem(text, position);
    if (item === undefined) return undefined;
    digits.push(item.digits);
    position = skipSpaces(text, item.next);
    const character = text.charAt(position);
    if (CLOSE_BRACKETS.has(character)) return { digits, end: position + 1 };
    if (!ITEM_SEPARATORS.has(character)) return undefined;
    position = skipSpaces(text, position + 1);
  }
}

function buildGroup(text: string, start: number, scan: GroupScan): CitationMarkerGroup {
  const open = text.charAt(start);
  const close = text.charAt(scan.end - 1);
  // Always the canonical single-index literal, so a padded lone marker (`[ 1 ]`) and a grouped one
  // both name their index the way the preview and reconciliation code look it up.
  const entries = scan.digits.map((digits): CitationMarkerEntry => ({
    index: Number.parseInt(digits, 10),
    marker: `${open}${digits}${close}`,
  }));
  return {
    start,
    end: scan.end,
    text: text.slice(start, scan.end),
    indices: entries.map((entry) => entry.index),
    entries,
  };
}

function runLength(text: string, from: number, character: string): number {
  let end = from;
  while (text.charAt(end) === character) end += 1;
  return end - from;
}

// True when only up to three spaces precede `position` on its line: where a code fence may open.
function atFenceIndent(text: string, position: number): boolean {
  let start = position;
  while (start > 0 && position - start <= 3 && text.charAt(start - 1) === " ") start -= 1;
  return position - start <= 3 && (start === 0 || text.charAt(start - 1) === "\n");
}

function lineEndOf(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

// True when the line starting at `lineStart` closes a fence of `length` `fence` characters: up to
// three spaces, at least as long a run of the same character, then only whitespace.
function closesFence(text: string, lineStart: number, fence: string, length: number): boolean {
  let first = lineStart;
  while (first - lineStart < 3 && text.charAt(first) === " ") first += 1;
  const run = runLength(text, first, fence);
  return run >= length && text.slice(first + run, lineEndOf(text, first)).trim() === "";
}

// The end of a fenced block opened at `position`: the end of its closing fence line, or the text
// end for a fence that never closes (CommonMark runs it to the end of the document).
function fencedBlockEnd(text: string, position: number, fence: string, length: number): number {
  let lineEnd = lineEndOf(text, position);
  while (lineEnd < text.length) {
    if (closesFence(text, lineEnd + 1, fence, length)) return lineEndOf(text, lineEnd + 1);
    lineEnd = lineEndOf(text, lineEnd + 1);
  }
  return text.length;
}

// Where a Markdown block ends: a blank line, or a line that starts a block of its own — a fence, an
// ATX heading, a list item or a block quote. An inline code span never reaches across one
// (CommonMark), so an unmatched backtick in one block cannot pair with one in the next and swallow
// the cited prose between them (PR #3678 review).
const BLOCK_BREAK =
  /\n[ \t]*\n|\n {0,3}(?:`{3}|~{3}|#{1,6}(?=[ \t\n])|[-*+][ \t]|\d{1,9}[.)][ \t]|>)/gu;

// Every backtick run of the text, grouped by run length in document order, so an inline code span
// finds its closing run without rescanning the text: the per-length cursors and the block-break
// cursor only move forward, so the whole scan stays linear however many unmatched runs it holds.
class BacktickRuns {
  private readonly startsByLength = new Map<number, number[]>();
  private readonly cursorByLength = new Map<number, number>();
  private readonly blockBreaks: readonly number[];
  private breakCursor = 0;

  constructor(text: string) {
    let next = text.indexOf("`");
    while (next !== -1) {
      const length = runLength(text, next, "`");
      const starts = this.startsByLength.get(length) ?? [];
      starts.push(next);
      this.startsByLength.set(length, starts);
      next = text.indexOf("`", next + length);
    }
    this.blockBreaks = [...text.matchAll(BLOCK_BREAK)].map((match) => match.index);
  }

  /** The end of the span a run of `length` opens at `position`, or undefined when none closes it. */
  closingEnd(position: number, length: number): number | undefined {
    const starts = this.startsByLength.get(length) ?? [];
    let cursor = this.cursorByLength.get(length) ?? 0;
    while (cursor < starts.length && (starts[cursor] ?? 0) <= position) cursor += 1;
    this.cursorByLength.set(length, cursor);
    const close = starts[cursor];
    if (close === undefined || this.blockBreakBetween(position, close)) return undefined;
    return close + length;
  }

  // Callers ask in increasing `from` order (the scan cursor), so the break cursor never moves back.
  private blockBreakBetween(from: number, to: number): boolean {
    while ((this.blockBreaks[this.breakCursor] ?? Number.POSITIVE_INFINITY) < from) {
      this.breakCursor += 1;
    }
    return (this.blockBreaks[this.breakCursor] ?? Number.POSITIVE_INFINITY) < to;
  }
}

/**
 * Where the scan resumes after the backtick or tilde run at `position`: past the fenced block or
 * code span it opens, or past the run itself when it is literal text. Undefined when no run starts.
 */
function afterCodeRun(text: string, position: number, runs: BacktickRuns): number | undefined {
  const character = text.charAt(position);
  if (character !== "`" && character !== "~") return undefined;
  const length = runLength(text, position, character);
  if (length >= 3 && atFenceIndent(text, position)) {
    return fencedBlockEnd(text, position, character, length);
  }
  if (character === "~") return position + length;
  return runs.closingEnd(position, length) ?? position + length;
}

/**
 * Every inline citation marker in `text`, in document order, outside Markdown code. Each returned
 * group is one bracket pair; a grouped marker such as `[1, 7, 8]` is ONE group carrying three
 * entries.
 */
export function findCitationMarkerGroups(text: string): readonly CitationMarkerGroup[] {
  const groups: CitationMarkerGroup[] = [];
  const runs = new BacktickRuns(text);
  let cursor = 0;
  while (cursor < text.length) {
    const code = afterCodeRun(text, cursor, runs);
    if (code !== undefined) {
      cursor = code;
      continue;
    }
    if (!OPEN_BRACKETS.has(text.charAt(cursor))) {
      cursor += 1;
      continue;
    }
    const scan = scanGroupBody(text, cursor + 1);
    if (scan === undefined) {
      cursor += 1;
      continue;
    }
    groups.push(buildGroup(text, cursor, scan));
    cursor = scan.end;
  }
  return groups;
}

/** Every cited index in `text`, in document order, duplicates kept (grouped markers expanded). */
export function citationMarkerIndices(text: string): readonly number[] {
  return findCitationMarkerGroups(text).flatMap((group) => group.indices);
}

// ─── Aggregated citation findings ─────────────────────────────────────────────
//
// The server folds every dangling citation (or every unentailed claim) of one answer into ONE
// uncertainty marker whose claim lists at most CITATION_FINDING_LIST_MAX of them. The UI counts the
// findings from that claim, so a count read from the listed items alone capped at 8, and a claim
// naming paths or claims (no numeric index) counted as one (PR #3678 review). Every such marker
// therefore ENDS with its total, written and read only here. The listed paths are untrusted model
// output and may contain the same syntax, so only the terminal suffix counts: the producer always
// appends its own, which a listed path can never follow.

/** The most findings one aggregated marker's claim lists by name. */
export const CITATION_FINDING_LIST_MAX = 8;

const CITATION_FINDING_TOTAL_PATTERN = / \((\d{1,7}) in total\)$/u;

/** The suffix that ends an aggregated marker's claim with its total; empty for no finding. */
export function citationFindingTotalSuffix(total: number): string {
  return Number.isSafeInteger(total) && total > 0 ? ` (${String(total)} in total)` : "";
}

/** The total a marker claim ends with (`citationFindingTotalSuffix`), if it ends with one. */
export function citationFindingTotal(claim: string): number | undefined {
  const match = CITATION_FINDING_TOTAL_PATTERN.exec(claim);
  const total = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}
