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
//     code such as `const a = [1, 2, 3];`, never a citation (PR #3678 review). Fenced blocks are
//     the renderer's: a fence at any indentation or inside a quote opens one, and any-indented
//     closing fence ends it.
//   * The marker scan is a single forward pass with no regular expression. The block pre-pass reads
//     each line with anchored patterns, once per quote level up to the renderer's nesting cap, so
//     the whole scan stays linear in the text length however many brackets or spaces it holds.

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

// Where an inline code span must end. The chat renderer (keiko-ui `safe-markdown.ts`) parses inline
// Markdown per paragraph, heading, list item, table cell and quoted paragraph, so an unmatched
// backtick in one of them cannot pair with one in the next and swallow the cited prose between them
// (PR #3678 review). The breaks are every newline the renderer does not join into one paragraph and
// every cell pipe of a table row; the line rules below mirror the renderer's block dispatch, so a
// thematic break, a table row or an indented list item ends a span exactly where it ends there.

interface MarkdownLine {
  readonly text: string;
  /** Offset of the line's first character in the scanned text. */
  readonly start: number;
  /** Offset of the newline that precedes the line, or -1 for the first line. */
  readonly newlineBefore: number;
}

interface InlineBreakScan {
  /** Newlines the renderer joins into one paragraph: no break. */
  readonly joined: Set<number>;
  /** Breaks inside a line: table cell pipes. */
  readonly inline: number[];
  /** The fenced code blocks the renderer shows as code, in document order. */
  readonly code: TextRange[];
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** Where the renderer ends inline contexts, and where it shows fenced code. */
interface RenderedLayout {
  readonly breaks: readonly number[];
  readonly code: readonly TextRange[];
}

// The renderer's quote nesting cap (safe-markdown MAX_MARKDOWN_DEPTH): deeper quoted text becomes one
// text node, whose lines the marker scan reads as one paragraph. The cap also bounds this recursion
// on hostile `> > > …` input.
const RENDERED_QUOTE_DEPTH = 16;
const FENCE_OPEN = /^(`{3,}|~{3,})/u;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/u;
const HEADING_LINE = /^#{1,6} .+$/u;
const HEADING_START = /^#{1,6} /u;
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const LIST_ITEM = /^ *(?:[*+-]|\d{1,9}\.) /u;
const QUOTE_PREFIX = /^ *> ?/u;
const SEPARATOR_CELL = /^-+$/u;

function markdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  let end = text.indexOf("\n");
  while (end !== -1) {
    lines.push({ text: text.slice(start, end), start, newlineBefore: start - 1 });
    start = end + 1;
    end = text.indexOf("\n", start);
  }
  lines.push({ text: text.slice(start), start, newlineBefore: start - 1 });
  return lines;
}

function isQuoteLine(line: string): boolean {
  return line.trimStart().startsWith("> ") || line.trim() === ">";
}

// The renderer's paragraph rule: a paragraph ends before a line that starts a block of its own.
function startsRenderedBlock(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    HEADING_START.test(trimmed) ||
    line.trimStart().startsWith("> ") ||
    FENCE_OPEN.test(trimmed) ||
    LIST_ITEM.test(line) ||
    THEMATIC_BREAK.test(trimmed)
  );
}

function isSeparatorRow(line: string): boolean {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row
    .split("|")
    .every((cell) => SEPARATOR_CELL.test(cell.trim().replace(/^:/u, "").replace(/:$/u, "")));
}

function afterRenderedFence(lines: readonly MarkdownLine[], index: number, fence: string): number {
  for (let next = index + 1; next < lines.length; next += 1) {
    const closer = FENCE_CLOSE.exec(lines[next]?.text.trim() ?? "")?.[1] ?? "";
    if (closer.startsWith(fence.charAt(0)) && closer.length >= fence.length) return next + 1;
  }
  return lines.length;
}

// A fence at any indentation, in a quote too, opens code the renderer never scans for markers; it
// runs to its closing fence line, or to the end of its container when it never closes.
function scanRenderedFence(
  lines: readonly MarkdownLine[],
  index: number,
  fence: string,
  scan: InlineBreakScan,
): number {
  const next = afterRenderedFence(lines, index, fence);
  const first = lines[index];
  const last = lines[next - 1];
  if (first !== undefined && last !== undefined) {
    scan.code.push({ start: first.start, end: last.start + last.text.length });
  }
  return next;
}

function pushPipes(line: MarkdownLine, scan: InlineBreakScan): void {
  let pipe = line.text.indexOf("|");
  while (pipe !== -1) {
    scan.inline.push(line.start + pipe);
    pipe = line.text.indexOf("|", pipe + 1);
  }
}

function scanTable(lines: readonly MarkdownLine[], index: number, scan: InlineBreakScan): number {
  const header = lines[index];
  if (header !== undefined) pushPipes(header, scan);
  let next = index + 2;
  for (let row = lines[next]; row !== undefined; row = lines[next]) {
    const trimmed = row.text.trim();
    if (trimmed === "" || !trimmed.includes("|")) break;
    pushPipes(row, scan);
    next += 1;
  }
  return next;
}

function scanParagraph(
  lines: readonly MarkdownLine[],
  index: number,
  scan: InlineBreakScan,
): number {
  let next = index + 1;
  for (let line = lines[next]; line !== undefined; line = lines[next]) {
    if (startsRenderedBlock(line.text)) break;
    scan.joined.add(line.newlineBefore);
    next += 1;
  }
  return next;
}

function scanQuote(
  lines: readonly MarkdownLine[],
  index: number,
  depth: number,
  scan: InlineBreakScan,
): number {
  const inner: MarkdownLine[] = [];
  let next = index;
  for (let line = lines[next]; line !== undefined && isQuoteLine(line.text); line = lines[next]) {
    const prefix = QUOTE_PREFIX.exec(line.text)?.[0].length ?? 0;
    inner.push({ ...line, text: line.text.slice(prefix), start: line.start + prefix });
    next += 1;
  }
  if (depth < RENDERED_QUOTE_DEPTH) {
    scanRenderedBlocks(inner, depth + 1, scan);
    return next;
  }
  for (const line of inner.slice(1)) scan.joined.add(line.newlineBefore);
  return next;
}

function startsTable(lines: readonly MarkdownLine[], index: number, trimmed: string): boolean {
  return trimmed.includes("|") && isSeparatorRow(lines[index + 1]?.text ?? "");
}

function isBlankHeadingOrRule(trimmed: string): boolean {
  return trimmed === "" || HEADING_LINE.test(trimmed) || THEMATIC_BREAK.test(trimmed);
}

// One block of the renderer's dispatch order: fence, heading, rule, quote, table, list, paragraph.
function scanRenderedBlock(
  lines: readonly MarkdownLine[],
  index: number,
  depth: number,
  scan: InlineBreakScan,
): number {
  const line = lines[index]?.text ?? "";
  const trimmed = line.trim();
  const fence = FENCE_OPEN.exec(trimmed)?.[1];
  if (fence !== undefined) return scanRenderedFence(lines, index, fence, scan);
  if (isBlankHeadingOrRule(trimmed)) return index + 1;
  if (isQuoteLine(line)) return scanQuote(lines, index, depth, scan);
  if (startsTable(lines, index, trimmed)) return scanTable(lines, index, scan);
  if (LIST_ITEM.test(line)) return index + 1;
  return scanParagraph(lines, index, scan);
}

function scanRenderedBlocks(
  lines: readonly MarkdownLine[],
  depth: number,
  scan: InlineBreakScan,
): void {
  let index = 0;
  while (index < lines.length) index = scanRenderedBlock(lines, index, depth, scan);
}

// Every offset where the renderer ends an inline context, and every fenced code block, in
// document order.
function renderedLayout(text: string): RenderedLayout {
  const lines = markdownLines(text);
  const scan: InlineBreakScan = { joined: new Set(), inline: [], code: [] };
  scanRenderedBlocks(lines, 0, scan);
  const newlines = lines
    .map((line) => line.newlineBefore)
    .filter((newline) => newline >= 0 && !scan.joined.has(newline));
  return {
    breaks: [...newlines, ...scan.inline].sort((left, right) => left - right),
    code: [...scan.code].sort((left, right) => left.start - right.start),
  };
}

// Every backtick run of the text, grouped by run length in document order, so an inline code span
// finds its closing run without rescanning the text: the per-length cursors and the block-break
// cursor only move forward, so the whole scan stays linear however many unmatched runs it holds.
class BacktickRuns {
  private readonly startsByLength = new Map<number, number[]>();
  private readonly cursorByLength = new Map<number, number>();
  private readonly blockBreaks: readonly number[];
  private breakCursor = 0;

  constructor(text: string, blockBreaks: readonly number[]) {
    let next = text.indexOf("`");
    while (next !== -1) {
      const length = runLength(text, next, "`");
      const starts = this.startsByLength.get(length) ?? [];
      starts.push(next);
      this.startsByLength.set(length, starts);
      next = text.indexOf("`", next + length);
    }
    this.blockBreaks = blockBreaks;
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
 * Where the scan resumes after the backtick run at `position`: past the inline code span it opens,
 * or past the run itself when it is literal text. Undefined when no backtick run starts there.
 */
function afterCodeRun(text: string, position: number, runs: BacktickRuns): number | undefined {
  if (text.charAt(position) !== "`") return undefined;
  const length = runLength(text, position, "`");
  return runs.closingEnd(position, length) ?? position + length;
}

// The renderer's fenced code blocks in document order; the scan cursor only moves forward, so each
// block is passed once.
class FencedBlocks {
  private readonly ranges: readonly TextRange[];
  private next = 0;

  constructor(ranges: readonly TextRange[]) {
    this.ranges = ranges;
  }

  /** The end of the fenced block the scan has reached at `cursor`, or undefined outside one. */
  endAt(cursor: number): number | undefined {
    for (
      let block = this.ranges[this.next];
      block !== undefined && cursor >= block.start;
      block = this.ranges[this.next]
    ) {
      this.next += 1;
      if (block.end > cursor) return block.end;
    }
    return undefined;
  }
}

/**
 * Every inline citation marker in `text`, in document order, outside Markdown code. Each returned
 * group is one bracket pair; a grouped marker such as `[1, 7, 8]` is ONE group carrying three
 * entries.
 */
export function findCitationMarkerGroups(text: string): readonly CitationMarkerGroup[] {
  const groups: CitationMarkerGroup[] = [];
  const layout = renderedLayout(text);
  const runs = new BacktickRuns(text, layout.breaks);
  const fenced = new FencedBlocks(layout.code);
  let cursor = 0;
  while (cursor < text.length) {
    const code = fenced.endAt(cursor) ?? afterCodeRun(text, cursor, runs);
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
