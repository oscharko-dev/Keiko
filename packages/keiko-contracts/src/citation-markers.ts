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

/**
 * Every inline citation marker in `text`, in document order. Each returned group is one bracket
 * pair; a grouped marker such as `[1, 7, 8]` is ONE group carrying three entries.
 */
export function findCitationMarkerGroups(text: string): readonly CitationMarkerGroup[] {
  const groups: CitationMarkerGroup[] = [];
  let cursor = 0;
  while (cursor < text.length) {
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
