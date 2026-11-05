// Rebuilds the logical text of a PDF page from the positions pdf.js reports (#4235). A PDF stores
// glyph runs, not paragraphs, so this module owns what every consumer needs and no consumer can
// recover from flat text: the reading order of rows, columns and table cells, the paragraph a
// wrapped line belongs to, and the page furniture a document repeats. Everything is decided from
// layout evidence. Where the evidence is missing, a line stays a line.

import { createHash } from "node:crypto";

import { MAX_LEARNED_FURNITURE } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-large-document";

export interface PositionedTextItem {
  readonly str?: string;
  readonly transform?: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly fontName?: string;
}

interface LayoutItem {
  readonly text: string;
  readonly font: string;
  readonly x: number;
  readonly y: number;
  /** Right edge in page units; equals `x` when the producer reported no width. */
  readonly right: number;
  readonly height: number;
  readonly width: number;
}

interface Segment {
  readonly text: string;
  /** The segment is written from right to left; its text is already in logical order. */
  readonly rightToLeft: boolean;
  readonly x: number;
  readonly right: number;
  readonly items: readonly LayoutItem[];
  readonly firstItem: LayoutItem;
}

interface LayoutRow {
  readonly segments: readonly Segment[];
  readonly y: number;
  readonly height: number;
}

export interface PageLayout {
  readonly rows: readonly LayoutRow[];
  /** Text drawn against the page's reading direction, such as a margin note or a watermark. */
  readonly offAxis: readonly string[];
  /** The page's text when the producer reported no positions at all. */
  readonly plain: string;
}

export interface PageHeading {
  /** Offset of the heading inside its page's text. */
  readonly offset: number;
  readonly title: string;
  readonly level: number;
}

export interface ComposedPages {
  readonly texts: readonly string[];
  /** How each page starts and ends, to carry paragraphs over its breaks (`joinAcrossPages`). */
  readonly edges: readonly (PageEdge | undefined)[];
  readonly headings: readonly (readonly PageHeading[])[];
  readonly removedRows: number;
  readonly furniture: ReadonlySet<string>;
}

export interface ComposedDocument extends ComposedPages {
  /**
   * What joins a page to the page before it when its first paragraph goes on from there; absent
   * where the page break also ends the paragraph.
   */
  readonly separators: readonly (string | undefined)[];
}

export interface PdfSection {
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
}

// A page can hold more items than a call takes as arguments, so these never spread.
function maxOf(values: Iterable<number>, floor = Number.NEGATIVE_INFINITY): number {
  let largest = floor;
  for (const value of values) if (value > largest) largest = value;
  return largest;
}

function minOf(values: Iterable<number>): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (const value of values) if (value < smallest) smallest = value;
  return smallest;
}

function lowerQuartile(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 4)] ?? 0;
}

function rowGaps(rows: readonly { readonly y: number }[]): readonly number[] {
  return rows.slice(1).map((row, index) => (rows[index]?.y ?? 0) - row.y);
}

// ─── Items ───────────────────────────────────────────────────────────────────

function hasPosition(item: PositionedTextItem): boolean {
  return item.transform !== undefined && item.transform.length >= 6;
}

function itemAngle(item: PositionedTextItem): number {
  const transform = item.transform ?? [];
  return (Math.atan2(transform[1] ?? 0, transform[0] ?? 1) * 180) / Math.PI;
}

function dominantAngle(items: readonly PositionedTextItem[]): number {
  const weights = new Map<number, number>();
  for (const item of items) {
    const angle = Math.round(itemAngle(item));
    weights.set(angle, (weights.get(angle) ?? 0) + (item.str?.length ?? 0));
  }
  let best = { angle: 0, weight: -1 };
  for (const [angle, weight] of weights) {
    if (weight > best.weight) best = { angle, weight };
  }
  return best.angle;
}

// The glyphs Office exports draw from the Symbol and Wingdings faces as list bullets.
const SYMBOL_FACE_BULLET = /^[\uF06C\uF06E\uF076\uF0A7\uF0A8\uF0B7\uF0D8\uF0FC]$/u;
const ZERO_WIDTH = /[\u200B\u2060\uFEFF]/gu;

function cleanItemText(raw: string): string {
  const cleaned = raw
    .replaceAll(ZERO_WIDTH, "")
    .replaceAll("\u00A0", " ")
    .trim()
    .replaceAll(/\u00AD(?=.)/gu, "")
    .replaceAll(/\u00AD$/gu, "-");
  return SYMBOL_FACE_BULLET.test(cleaned) ? "•" : cleaned;
}

function itemHeight(item: PositionedTextItem): number {
  const transform = item.transform ?? [];
  const reported = item.height ?? 0;
  return reported > 0 ? reported : Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
}

function layoutItem(item: PositionedTextItem, angleDegrees: number): LayoutItem {
  const raw = item.str ?? "";
  const pageX = item.transform?.[4] ?? 0;
  const pageY = item.transform?.[5] ?? 0;
  const angle = (angleDegrees * Math.PI) / 180;
  const perCharacter = raw.length > 0 ? Math.max(item.width ?? 0, 0) / raw.length : 0;
  const leading = raw.length - raw.trimStart().length;
  const x = pageX * Math.cos(angle) + pageY * Math.sin(angle) + leading * perCharacter;
  const width = perCharacter * raw.trim().length;
  return {
    text: cleanItemText(raw),
    font: item.fontName ?? "",
    x,
    y: pageY * Math.cos(angle) - pageX * Math.sin(angle),
    right: x + width,
    height: itemHeight(item),
    width,
  };
}

// ─── Rows and segments ───────────────────────────────────────────────────────

const DUPLICATE_DRAW_TOLERANCE = 1;

function isDuplicateDraw(previous: LayoutItem | undefined, item: LayoutItem): boolean {
  return previous?.text === item.text && Math.abs(previous.x - item.x) <= DUPLICATE_DRAW_TOLERANCE;
}

const WORD_GAP_RATIO = 0.12;

function needsWordSpace(previous: LayoutItem, item: LayoutItem): boolean {
  if (previous.width <= 0) return true;
  return item.x - previous.right > Math.max(previous.height, item.height) * WORD_GAP_RATIO;
}

function separatorBefore(items: readonly LayoutItem[], index: number): string {
  const previous = items[index - 1];
  const item = items[index];
  return previous !== undefined && item !== undefined && needsWordSpace(previous, item) ? " " : "";
}

// Letters of the scripts written from right to left. pdf.js reports the text of a run in logical
// order, but the runs of a line sit on the page from right to left.
const RIGHT_TO_LEFT_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

function isRightToLeftItem(item: LayoutItem): boolean {
  return RIGHT_TO_LEFT_LETTER.test(item.text);
}

const LEFT_TO_RIGHT_LETTER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}]/u;

/** A line is written from right to left when most of its letters are. */
function isRightToLeftLine(items: readonly LayoutItem[]): boolean {
  let rightToLeft = 0;
  let leftToRight = 0;
  for (const item of items) {
    if (isRightToLeftItem(item)) rightToLeft += item.text.length;
    else if (LEFT_TO_RIGHT_LETTER.test(item.text)) leftToRight += item.text.length;
  }
  return rightToLeft > leftToRight;
}

/**
 * The items of a right-to-left line in logical order. Runs of one direction sit next to each other
 * on the page: a right-to-left run reads from its right end, a left-to-right run (a name, a number)
 * from its left, and the runs follow each other from the right.
 */
function logicalOrder(items: readonly LayoutItem[]): readonly number[] {
  const runs: number[][] = [];
  items.forEach((item, index) => {
    const last = runs.at(-1);
    const lastItem = last === undefined ? undefined : items[last[0] ?? 0];
    if (
      last !== undefined &&
      lastItem !== undefined &&
      isRightToLeftItem(lastItem) === isRightToLeftItem(item)
    ) {
      last.push(index);
    } else {
      runs.push([index]);
    }
  });
  return [...runs].reverse().flatMap((run) => {
    const first = items[run[0] ?? 0];
    return first !== undefined && isRightToLeftItem(first) ? [...run].reverse() : run;
  });
}

/** Neighbours on the page keep the space the producer left; other neighbours get one. */
function rightToLeftText(items: readonly LayoutItem[]): string {
  const order = logicalOrder(items);
  let text = "";
  order.forEach((index, position) => {
    const before = order[position - 1];
    const text_ = items[index]?.text ?? "";
    if (before === undefined) text = text_;
    else if (Math.abs(before - index) === 1)
      text += `${separatorBefore(items, Math.max(before, index))}${text_}`;
    else text += ` ${text_}`;
  });
  return text;
}

function toSegment(items: readonly LayoutItem[], first: LayoutItem): Segment {
  const rightToLeft = isRightToLeftLine(items);
  let text = "";
  if (rightToLeft) text = rightToLeftText(items);
  else items.forEach((item, index) => (text += `${separatorBefore(items, index)}${item.text}`));
  return {
    text,
    rightToLeft,
    x: first.x,
    right: maxOf(items.map((item) => item.right)),
    items,
    firstItem: first,
  };
}

const SEGMENT_GAP_RATIO = 1;
const SEGMENT_GAP_MIN = 3;

function segmentsOf(items: readonly LayoutItem[], height: number): readonly Segment[] {
  const threshold = Math.max(height * SEGMENT_GAP_RATIO, SEGMENT_GAP_MIN);
  const groups: LayoutItem[][] = [];
  let right = Number.NEGATIVE_INFINITY;
  let previous: LayoutItem | undefined;
  for (const item of items) {
    if (isDuplicateDraw(previous, item)) continue;
    const current = groups.at(-1);
    if (current === undefined || item.x - right > threshold) groups.push([item]);
    else current.push(item);
    right = Math.max(right, item.right);
    previous = item;
  }
  return groups.flatMap((group) => {
    const first = group[0];
    return first === undefined ? [] : [toSegment(group, first)];
  });
}

const LIST_MARKER_ONLY = /^(?:[-–—*•·▪◦‣]|\d{1,3}[.)]?|[a-z][.)])$/iu;
const BARE_NUMBER = /^\d+$/u;
const HAS_LETTER = /\p{L}/u;
const SECOND_LEVEL_BULLET = "o";

/**
 * A marker drawn apart from its text starts a list item. A bare number is one only in front of
 * words: a number in front of a number is a cell of a table, and joining them would turn "12 | 99"
 * into "12. 99". The letter o is the second-level bullet of Office lists, drawn in a face of its own.
 */
function isListMarker(marker: Segment, body: Segment): boolean {
  if (BARE_NUMBER.test(marker.text)) return HAS_LETTER.test(body.text);
  if (marker.text === SECOND_LEVEL_BULLET) return marker.firstItem.font !== body.firstItem.font;
  return LIST_MARKER_ONLY.test(marker.text);
}

function markerLabel(marker: Segment): string {
  if (BARE_NUMBER.test(marker.text)) return `${marker.text}.`;
  return marker.text === SECOND_LEVEL_BULLET ? "◦" : marker.text;
}

function withListMarkerJoined(segments: readonly Segment[]): readonly Segment[] {
  const [marker, body] = segments;
  if (segments.length !== 2 || marker === undefined || body === undefined) return segments;
  if (!isListMarker(marker, body)) return segments;
  return [{ ...body, text: `${markerLabel(marker)} ${body.text}`, x: marker.x }];
}

const BASELINE_TOLERANCE_RATIO = 0.5;
const BASELINE_TOLERANCE_MIN = 2;

/** The visual rows of a page, top to bottom, with their items in reading order. */
function layoutRows(items: readonly LayoutItem[]): readonly LayoutRow[] {
  const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: { y: number; height: number; items: LayoutItem[] }[] = [];
  for (const item of ordered) {
    const current = groups.at(-1);
    const tolerance = Math.max(
      Math.max(current?.height ?? 0, item.height) * BASELINE_TOLERANCE_RATIO,
      BASELINE_TOLERANCE_MIN,
    );
    if (current !== undefined && current.y - item.y <= tolerance) {
      current.items.push(item);
      // The row sits on the baseline of its tallest run, not of a raised footnote marker.
      if (item.height > current.height) {
        current.y = item.y;
        current.height = item.height;
      }
    } else {
      groups.push({ y: item.y, height: item.height, items: [item] });
    }
  }
  return groups.map((group) => ({
    y: group.y,
    height: group.height,
    segments: withListMarkerJoined(
      segmentsOf(
        [...group.items].sort((a, b) => a.x - b.x),
        group.height,
      ),
    ),
  }));
}

const AXIS_TOLERANCE_DEGREES = 2;

/** What pdf.js reported for one page, reduced to the evidence reading order is decided from. */
export function pageLayoutOf(items: readonly PositionedTextItem[]): PageLayout {
  const positioned = items.filter((item) => hasPosition(item));
  if (positioned.length === 0) {
    const plain = items
      .map((item) => cleanItemText(item.str ?? ""))
      .filter((value) => value.length > 0)
      .join(" ");
    return { rows: [], offAxis: [], plain };
  }
  const angle = dominantAngle(positioned);
  const onAxis = (item: PositionedTextItem): boolean =>
    Math.abs(itemAngle(item) - angle) <= AXIS_TOLERANCE_DEGREES;
  const readable = positioned
    .filter((item) => onAxis(item))
    .map((item) => layoutItem(item, angle))
    .filter((item) => item.text.length > 0);
  const rows = layoutRows(readable);
  const offAxis = positioned
    .filter((item) => !onAxis(item))
    .map((item) => cleanItemText(item.str ?? ""))
    .filter((value) => value.length > 0);
  return { rows, offAxis, plain: "" };
}

function isRightToLeftRow(row: LayoutRow): boolean {
  const weight = (segment: Segment): number => segment.text.length;
  const rightToLeft = row.segments.filter((segment) => segment.rightToLeft);
  const rest = row.segments.filter((segment) => !segment.rightToLeft);
  return (
    rightToLeft.reduce((sum, s) => sum + weight(s), 0) > rest.reduce((sum, s) => sum + weight(s), 0)
  );
}

/** The text of a row; the segments of a right-to-left row follow each other from the right. */
function rowText(row: LayoutRow): string {
  const ordered = isRightToLeftRow(row) ? [...row.segments].reverse() : row.segments;
  return ordered.map((segment) => segment.text).join(" ");
}

// ─── Repeated page furniture ─────────────────────────────────────────────────

const FURNITURE_Y_BUCKET = 3;

// A word that names a page, straight in front of its number (`Seite 3`, `p. 3`, `Pág. 3`).
const PAGE_WORDS: ReadonlySet<string> = new Set([
  "seite",
  "s.",
  "page",
  "pag",
  "pag.",
  "pg",
  "pg.",
  "p.",
  "pagina",
  "página",
  "pág",
  "pág.",
  "folio",
  "folie",
  "slide",
  "blatt",
  "bl.",
  "hoja",
  "feuille",
  "foglio",
]);

/** The word at the end of this text, with its full stop, past a space and a colon in front of a number. */
function wordBeforeNumber(text: string): string {
  const bare = text.trimEnd();
  const open = bare.endsWith(":") ? bare.slice(0, -1).trimEnd() : bare;
  let start = open.endsWith(".") ? open.length - 1 : open.length;
  while (start > 0 && /\p{L}/u.test(open.charAt(start - 1))) start -= 1;
  return open.slice(start);
}

function namesPageCounter(masked: string): boolean {
  return masked
    .split("#")
    .slice(0, -1)
    .some((before) => PAGE_WORDS.has(wordBeforeNumber(before)));
}

// The same line on every page, unless a number in it counts the pages. It does so alone (`12`,
// `- 12 -`, `3 / 10`) or behind a word naming a page. In any other line a number is content: `FR-1`,
// `FR-2` at the top of three pages are three requirements, and `Kapitel 2` is a chapter.
function repeatedLineKey(text: string): string {
  const folded = text.toLowerCase().replaceAll(/\s+/gu, " ");
  const masked = folded.replaceAll(/\p{N}+/gu, "#");
  return !/\p{L}/u.test(masked) || namesPageCounter(masked) ? masked : folded;
}

// What a run knows about a repeated line is a digest of it: a checkpoint stores what it learned, and
// a checkpoint holds no document text.
function furnitureDigest(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 22);
}

function furnitureKey(row: LayoutRow): string {
  return furnitureDigest(
    `${repeatedLineKey(rowText(row))}@${String(Math.round(row.y / FURNITURE_Y_BUCKET))}`,
  );
}

function offAxisKey(text: string): string {
  return furnitureDigest(`off-axis:${repeatedLineKey(text)}`);
}

const FURNITURE_ISOLATION_RATIO = 1.5;

function isolatingGap(pitch: number): number {
  return pitch * FURNITURE_ISOLATION_RATIO;
}

const EDGE_ROWS = 2;

/** The rows at a page edge that a clear gap separates from the body. A table header has no gap. */
function edgeRows(rows: readonly LayoutRow[]): readonly LayoutRow[] {
  const gaps = rowGaps(rows);
  const limit = isolatingGap(lowerQuartile(gaps));
  const out: LayoutRow[] = [];
  const reach = Math.min(EDGE_ROWS, gaps.length);
  for (let count = 1; count <= reach; count += 1) {
    if ((gaps[count - 1] ?? 0) >= limit) {
      out.push(...rows.slice(0, count));
      break;
    }
  }
  for (let count = 1; count <= reach; count += 1) {
    if ((gaps[gaps.length - count] ?? 0) >= limit) {
      out.push(...rows.slice(rows.length - count));
      break;
    }
  }
  return out;
}

const HEADING_SIZE_RATIO = 1.12;

/** A line set larger than the body is a heading, which the page carries; furniture is body-sized. */
function isHeadingSized(row: LayoutRow, bodyHeight: number): boolean {
  return bodyHeight > 0 && row.height >= bodyHeight * HEADING_SIZE_RATIO;
}

function furnitureRows(page: PageLayout, bodyHeight: number): readonly LayoutRow[] {
  return edgeRows(page.rows).filter((row) => !isHeadingSized(row, bodyHeight));
}

const FURNITURE_MIN_PAGES = 3;
const FURNITURE_PAGE_SHARE = 0.4;

function repeatedFurniture(pages: readonly PageLayout[], bodyHeight: number): ReadonlySet<string> {
  if (pages.length < FURNITURE_MIN_PAGES) return new Set();
  const counts = new Map<string, number>();
  const count = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const page of pages) {
    new Set(furnitureRows(page, bodyHeight).map((row) => furnitureKey(row))).forEach((key) => {
      count(key);
    });
    new Set(page.offAxis.map((text) => offAxisKey(text))).forEach((key) => {
      count(key);
    });
  }
  const needed = Math.max(FURNITURE_MIN_PAGES, Math.ceil(pages.length * FURNITURE_PAGE_SHARE));
  return new Set([...counts].filter(([, seen]) => seen >= needed).map(([key]) => key));
}

function withoutFurniture(
  page: PageLayout,
  furniture: ReadonlySet<string>,
  bodyHeight: number,
): PageLayout {
  const edges = new Set(furnitureRows(page, bodyHeight));
  return {
    ...page,
    rows: page.rows.filter((row) => !(edges.has(row) && furniture.has(furnitureKey(row)))),
    offAxis: page.offAxis.filter((text) => !furniture.has(offAxisKey(text))),
  };
}

// ─── Columns ─────────────────────────────────────────────────────────────────

interface Gutter {
  readonly start: number;
  readonly end: number;
}

const MIN_GUTTER = 8;

function coverageGaps(segments: readonly Segment[]): readonly Gutter[] {
  const ordered = [...segments].sort((a, b) => a.x - b.x);
  const gaps: Gutter[] = [];
  let right = ordered[0]?.right ?? 0;
  for (const segment of ordered) {
    if (segment.x - right >= MIN_GUTTER) gaps.push({ start: right, end: segment.x });
    right = Math.max(right, segment.right);
  }
  return gaps;
}

function isMeasured(segments: readonly Segment[]): boolean {
  return segments.some((segment) => segment.right > segment.x);
}

const COLUMN_FILL_RATIO = 0.7;
const COLUMN_FILLED_SHARE = 0.6;

/** Running text fills its column; table cells mostly do not. */
function fillsColumn(segments: readonly Segment[], x: number, right: number): boolean {
  const available = right - x;
  const filled = segments.filter(
    (segment) => segment.right - x >= available * COLUMN_FILL_RATIO,
  ).length;
  return filled >= segments.length * COLUMN_FILLED_SHARE;
}

interface ColumnSpan {
  readonly start: number;
  readonly end: number;
}

function emptyColumns<T>(count: number): T[][] {
  return Array.from({ length: count }, (): T[] => []);
}

/** The column a segment sits in; no segment overlaps a gutter. */
function columnOfSegment(gutters: readonly Gutter[], segment: Segment): number {
  return gutters.filter((gutter) => gutter.end <= segment.x).length;
}

/** The segments of each column, left to right. */
function segmentsByColumn(
  body: readonly Segment[],
  gutters: readonly Gutter[],
): readonly (readonly Segment[])[] {
  const columns = emptyColumns<Segment>(gutters.length + 1);
  for (const segment of body) columns[columnOfSegment(gutters, segment)]?.push(segment);
  return columns;
}

/** Where each column starts and ends: the text edge at the outside, the gutters in between. */
function columnSpans(
  columns: readonly (readonly Segment[])[],
  gutters: readonly Gutter[],
): readonly ColumnSpan[] {
  const outerLeft = minOf((columns[0] ?? []).map((segment) => segment.x));
  const outerRight = maxOf((columns.at(-1) ?? []).map((segment) => segment.right));
  return columns.map((_, index) => ({
    start: gutters[index - 1]?.end ?? outerLeft,
    end: gutters[index]?.start ?? outerRight,
  }));
}

const MIN_COLUMN_LINES = 4;
const MIN_UNMEASURED_COLUMN_LINES = 2;
const COLUMN_BALANCE_RATIO = 0.6;
const MAX_GUTTER_SHARE = 0.5;

function hasColumnEvidence(
  columns: readonly (readonly Segment[])[],
  gutters: readonly Gutter[],
): boolean {
  if (!isMeasured(columns.flat())) {
    return columns.every((column) => column.length >= MIN_UNMEASURED_COLUMN_LINES);
  }
  if (columns.some((column) => column.length < MIN_COLUMN_LINES)) return false;
  const spans = columnSpans(columns, gutters);
  const widths = spans.map((span) => span.end - span.start);
  const narrowest = minOf(widths);
  if (narrowest < maxOf(widths) * COLUMN_BALANCE_RATIO) return false;
  if (gutters.some((gutter) => gutter.end - gutter.start > narrowest * MAX_GUTTER_SHARE)) {
    return false;
  }
  return columns.every((column, index) => {
    const span = spans[index];
    return span !== undefined && fillsColumn(column, span.start, span.end);
  });
}

const FULL_WIDTH_RATIO = 0.65;

/** Segments wider than this share of the text's width are running text, not part of a column. */
function fullWidthLimit(segments: readonly Segment[]): number {
  const pageLeft = minOf(segments.map((segment) => segment.x));
  const pageRight = maxOf(segments.map((segment) => segment.right));
  return (pageRight - pageLeft) * FULL_WIDTH_RATIO;
}

const MAX_COLUMNS = 4;

function guttersOf(rows: readonly LayoutRow[]): readonly Gutter[] {
  const all = rows.flatMap((row) => row.segments);
  const limit = fullWidthLimit(all);
  const body = all.filter((segment) => segment.right - segment.x <= limit);
  const gutters = coverageGaps(body);
  if (gutters.length === 0 || gutters.length >= MAX_COLUMNS) return [];
  return hasColumnEvidence(segmentsByColumn(body, gutters), gutters) ? gutters : [];
}

function crossesGutter(row: LayoutRow, gutters: readonly Gutter[]): boolean {
  return row.segments.some((segment) =>
    gutters.some((gutter) => segment.x < gutter.end && segment.right > gutter.start),
  );
}

type Flows = readonly (readonly LayoutRow[])[];

/** The flows of rows that share one set of gutters, or undefined when they share none. */
function columnFlows(rows: readonly LayoutRow[]): Flows | undefined {
  const gutters = guttersOf(rows);
  if (gutters.length === 0) return undefined;
  const flows: (readonly LayoutRow[])[] = [];
  let band: LayoutRow[] = [];
  let columns = emptyColumns<LayoutRow>(gutters.length + 1);
  const flushBand = (): void => {
    if (band.length > 0) flows.push(band);
    band = [];
  };
  const flushColumns = (): void => {
    flows.push(...columns.filter((column) => column.length > 0));
    columns = emptyColumns<LayoutRow>(gutters.length + 1);
  };
  for (const row of rows) {
    if (crossesGutter(row, gutters)) {
      flushColumns();
      band.push(row);
      continue;
    }
    flushBand();
    for (const segment of row.segments) {
      columns[columnOfSegment(gutters, segment)]?.push({ ...row, segments: [segment] });
    }
  }
  flushColumns();
  flushBand();
  return flows;
}

interface RowBand {
  readonly rows: LayoutRow[];
  readonly fullWidth: boolean;
}

/** Runs of rows with and without a full-width line: a column pair can start below a table. */
function bandsOf(rows: readonly LayoutRow[]): readonly RowBand[] {
  const limit = fullWidthLimit(rows.flatMap((row) => row.segments));
  const bands: RowBand[] = [];
  for (const row of rows) {
    const fullWidth = row.segments.some((segment) => segment.right - segment.x > limit);
    const current = bands.at(-1);
    if (current?.fullWidth === fullWidth) current.rows.push(row);
    else bands.push({ rows: [row], fullWidth });
  }
  return bands;
}

/** Column pairs found band by band; undefined when no band holds one. */
function bandedFlows(rows: readonly LayoutRow[]): Flows | undefined {
  const bands = bandsOf(rows);
  if (bands.length < 2) return undefined;
  const columnsOfBand = bands.map((band) => (band.fullWidth ? undefined : columnFlows(band.rows)));
  if (columnsOfBand.every((columns) => columns === undefined)) return undefined;
  return bands.flatMap((band, index) => columnsOfBand[index] ?? [band.rows]);
}

/**
 * Rows split into reading flows: full-width bands stay in place, a column set reads left first.
 * Columns shared by the whole page decide first; failing that, each stretch between full-width
 * lines is looked at on its own, so a table elsewhere on the page cannot hide the columns.
 */
function readingFlows(rows: readonly LayoutRow[]): Flows {
  if (rows.length === 0) return [];
  return columnFlows(rows) ?? bandedFlows(rows) ?? [rows];
}

// ─── Tables ──────────────────────────────────────────────────────────────────

interface TableBlock {
  readonly columns: readonly number[];
  readonly rows: readonly LayoutRow[];
}

const COLUMN_ALIGN_TOLERANCE = 3;

/** The last column that starts at or before `x`; the columns are sorted from left to right. */
function columnIndex(columns: readonly number[], x: number): number {
  const limit = x + COLUMN_ALIGN_TOLERANCE;
  let low = 0;
  let high = columns.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((columns[middle] ?? Number.POSITIVE_INFINITY) <= limit) low = middle + 1;
    else high = middle;
  }
  return Math.max(low - 1, 0);
}

function alignsToColumn(columns: readonly number[], x: number): boolean {
  const column = columns[columnIndex(columns, x)];
  return column !== undefined && Math.abs(column - x) <= COLUMN_ALIGN_TOLERANCE;
}

const TABLE_MAX_COLUMNS = 64;

function withRowColumns(columns: readonly number[], row: LayoutRow): readonly number[] {
  const xs = row.segments.map((segment) => segment.x);
  if (xs.length < 2 || !xs.some((x) => alignsToColumn(columns, x))) return columns;
  const added = xs.filter((x) => !alignsToColumn(columns, x));
  if (added.length === 0 || columns.length + added.length > TABLE_MAX_COLUMNS) return columns;
  return [...columns, ...added].sort((a, b) => a - b);
}

/** A cell can sit closer to its neighbour than a word gap's limit; its own draw still starts it. */
function splitAtColumns(segment: Segment, columns: readonly number[]): readonly Segment[] {
  const groups: LayoutItem[][] = [];
  for (const item of segment.items) {
    const current = groups.at(-1);
    if (current === undefined || alignsToColumn(columns, item.x)) groups.push([item]);
    else current.push(item);
  }
  if (groups.length < 2) return [segment];
  return groups.flatMap((group) => {
    const first = group[0];
    return first === undefined ? [] : [toSegment(group, first)];
  });
}

function rowOnColumns(row: LayoutRow, columns: readonly number[]): LayoutRow {
  return {
    ...row,
    segments: row.segments.flatMap((segment) => splitAtColumns(segment, columns)),
  };
}

function fitsColumns(row: LayoutRow, columns: readonly number[]): boolean {
  return row.segments.every((segment) => {
    if (!alignsToColumn(columns, segment.x)) return false;
    const next = columns[columnIndex(columns, segment.x) + 1];
    return next === undefined || segment.right <= next + COLUMN_ALIGN_TOLERANCE;
  });
}

interface TableDraft {
  columns: readonly number[];
  readonly rows: LayoutRow[];
  smallestGap: number;
  largestGap: number;
}

const TABLE_GAP_LIMIT_RATIO = 1.8;
const TABLE_GAP_HEIGHT_RATIO = 2;
const CELL_LINE_GAP_RATIO = 1.15;

function extendsTable(row: LayoutRow, columns: readonly number[], draft: TableDraft): boolean {
  const previous = draft.rows.at(-1);
  if (previous === undefined || !fitsColumns(row, columns)) return false;
  const gap = previous.y - row.y;
  const onlyFirstColumn =
    row.segments.length === 1 && columnIndex(columns, row.segments[0]?.x ?? 0) === 0;
  if (onlyFirstColumn) {
    return draft.rows.length > 1 && gap <= draft.smallestGap * CELL_LINE_GAP_RATIO;
  }
  const spacing = Math.max(draft.largestGap, previous.height * TABLE_GAP_HEIGHT_RATIO);
  return gap <= spacing * TABLE_GAP_LIMIT_RATIO;
}

function growTable(draft: TableDraft, candidate: LayoutRow): boolean {
  const row = rowOnColumns(candidate, draft.columns);
  const columns = withRowColumns(draft.columns, row);
  if (!extendsTable(row, columns, draft)) return false;
  const gap = (draft.rows.at(-1)?.y ?? row.y) - row.y;
  draft.columns = columns;
  draft.smallestGap = Math.min(draft.smallestGap, gap);
  draft.largestGap = Math.max(draft.largestGap, gap);
  draft.rows.push(row);
  return true;
}

const TABLE_MIN_ROWS = 2;

function readTableBlock(rows: readonly LayoutRow[], start: number): TableBlock | undefined {
  const head = rows[start];
  if (head === undefined || head.segments.length < 2) return undefined;
  const draft: TableDraft = {
    columns: head.segments.map((segment) => segment.x),
    rows: [head],
    smallestGap: Number.POSITIVE_INFINITY,
    largestGap: Number.NEGATIVE_INFINITY,
  };
  for (let index = start + 1; index < rows.length; index += 1) {
    const candidate = rows[index];
    if (candidate === undefined || !growTable(draft, candidate)) break;
  }
  const multiColumn = draft.rows.filter((row) => row.segments.length >= 2).length;
  return multiColumn >= TABLE_MIN_ROWS ? { columns: draft.columns, rows: draft.rows } : undefined;
}

// ─── The document's own words ────────────────────────────────────────────────

/** Every word form a document uses, with how often. A broken fragment is not one of them. */
type Vocabulary = ReadonlyMap<string, number>;

const WORD_CORE = /[\p{L}\p{N}](?:.*[\p{L}\p{N}])?/su;

function wordKey(raw: string): string {
  return WORD_CORE.exec(raw)?.[0].toLowerCase() ?? "";
}

function documentVocabulary(pages: readonly PageLayout[]): Vocabulary {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const segment of page.rows.flatMap((row) => row.segments)) {
      for (const raw of segment.text.split(/\s+/u)) {
        const key = wordKey(raw);
        if (key.length > 0) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function firstWord(text: string): string {
  return text.split(/\s+/u)[0] ?? "";
}

function lastWord(text: string): string {
  return text.split(/\s+/u).at(-1) ?? "";
}

/** Keeps the hyphen when the document writes the word with it and never without it. */
function keepsWrapHyphen(left: string, right: string, vocabulary: Vocabulary): boolean {
  const head = lastWord(left);
  const tail = firstWord(right);
  return (
    vocabulary.has(wordKey(`${head}${tail}`)) &&
    !vocabulary.has(wordKey(`${head.slice(0, -1)}${tail}`))
  );
}

// Letters between optional opening and closing punctuation: "(Zahlungs-" and "verkehr)," are words.
const PLAIN_WORD = /^[^\p{L}\p{N}]*\p{L}+(?:-\p{L}+)*[^\p{L}\p{N}/_@:\\]*$/u;

/** Only a plain word was hyphenated by the renderer; a URL, a path or an identifier was not. */
function isPlainWord(word: string): boolean {
  return PLAIN_WORD.test(word);
}

interface WrapJoin {
  /** The line ends in a hyphen the wrap added, and the join removes it. */
  readonly dropHyphen: boolean;
  readonly separator: string;
}

const HYPHENATED_END = /\p{L}-$/u;
// Nothing but the rest of the address can follow a URL scheme.
const URL_SCHEME_END = /[\p{L}\p{N}]:\/\/$/u;
const LOWER_START = /^\p{Ll}/u;
const COMPOUND_START = /^[\p{Lu}\p{N}]/u;
// "Ein- und Auszahlung": a word that follows a suspended hyphen keeps it.
const SUSPENDED_HYPHEN_NEXT = /^(?:und|oder|bzw|sowie|bis|and|or)\b/u;

/** How a wrapped line continues the text before it; only the end of that text matters. */
function wrapJoinOf(tail: string, right: string, vocabulary: Vocabulary): WrapJoin {
  if (URL_SCHEME_END.test(tail)) return { dropHyphen: false, separator: "" };
  if (!HYPHENATED_END.test(tail)) return { dropHyphen: false, separator: " " };
  if (LOWER_START.test(right) && !SUSPENDED_HYPHEN_NEXT.test(right)) {
    const repairable = isPlainWord(lastWord(tail)) && isPlainWord(firstWord(right));
    return { dropHyphen: repairable && !keepsWrapHyphen(tail, right, vocabulary), separator: "" };
  }
  return { dropHyphen: false, separator: COMPOUND_START.test(right) ? "" : " " };
}

/** How much of the text so far a join looks at: a word longer than this is no word of a document. */
const JOIN_TAIL_CHARS = 256;

/**
 * Text that grows line by line. Parts are joined once at the end and a join reads only the tail, so
 * a paragraph of any length costs as much as its lines and no more.
 */
class WrappedText {
  private readonly parts: string[];
  private tail: string;

  constructor(first: string) {
    this.parts = [first];
    this.tail = first.slice(-JOIN_TAIL_CHARS);
  }

  isEmpty(): boolean {
    return this.tail.length === 0;
  }

  appendWrapped(right: string, vocabulary: Vocabulary): void {
    if (this.isEmpty()) {
      this.appendRaw(right);
      return;
    }
    const join = wrapJoinOf(this.tail, right, vocabulary);
    if (join.dropHyphen) this.dropLastCharacter();
    this.appendRaw(`${join.separator}${right}`);
  }

  /** A word the renderer broke inside: the fragment continues the text without any separator. */
  appendRaw(text: string): void {
    this.parts.push(text);
    this.tail = this.tail.concat(text).slice(-JOIN_TAIL_CHARS);
  }

  toString(): string {
    return this.parts.join("");
  }

  private dropLastCharacter(): void {
    const last = this.parts.pop() ?? "";
    if (last.length > 1) this.parts.push(last.slice(0, -1));
    this.tail = this.tail.slice(0, -1);
  }
}

const SPACE_WIDTH_RATIO = 0.25;

/** A word's share of its run, from the run's average glyph: spaces are narrower than letters. */
function estimatedWordWidth(item: LayoutItem, word: string): number {
  const glyphs = item.text.replaceAll(/\s/gu, "").length;
  if (glyphs === 0 || item.width <= 0) return 0;
  const spaces = item.text.length - glyphs;
  const glyphWidth = Math.max(item.width - spaces * item.height * SPACE_WIDTH_RATIO, 0) / glyphs;
  return glyphWidth * word.length;
}

function lastWordWidth(segment: Segment): number {
  const item = segment.items.at(-1);
  return item === undefined ? 0 : estimatedWordWidth(item, lastWord(item.text));
}

function firstFragmentWidth(segment: Segment): number {
  return estimatedWordWidth(segment.firstItem, firstWord(segment.firstItem.text));
}

interface CellLine {
  readonly previous: Segment | undefined;
  readonly cellLeft: number;
  readonly cellRight: number;
  readonly vocabulary: Vocabulary;
}

const NUMBER_FRAGMENT_END = /[\p{N}-]$/u;
const NUMBER_FRAGMENT_START = /^\p{N}/u;

/** Layout cannot tell a long whole word from a fragment, because it defines the cell's edge itself. */
function areFragmentsOfOneWord(head: string, tail: string, vocabulary: Vocabulary): boolean {
  // An identifier's digits are no words, so the document cannot use them on their own.
  if (NUMBER_FRAGMENT_END.test(head) && NUMBER_FRAGMENT_START.test(tail)) return true;
  if (vocabulary.has(wordKey(`${head}${tail}`))) return true;
  const usedAgain = (word: string): boolean => (vocabulary.get(wordKey(word)) ?? 0) > 1;
  return !usedAgain(head) && !usedAgain(tail);
}

const WRAP_TOLERANCE = 1.5;
const CELL_EDGE_REACH_RATIO = 0.7;
const WORD_CONTINUATION_START = /^[\p{Ll}\p{N}]/u;

/**
 * A renderer breaks inside a word only when the word cannot fit a line of its cell at all: the line
 * ends at the cell's edge and the two fragments together are wider than the cell.
 */
function brokeInsideWord(previous: Segment, next: Segment, cell: CellLine): boolean {
  const { cellLeft, cellRight, vocabulary } = cell;
  if (!WORD_CONTINUATION_START.test(next.text) || previous.right >= cellRight + WRAP_TOLERANCE) {
    return false;
  }
  if (previous.right < cellRight - next.firstItem.height * CELL_EDGE_REACH_RATIO) return false;
  if (lastWordWidth(previous) + firstFragmentWidth(next) <= cellRight - cellLeft) return false;
  return areFragmentsOfOneWord(lastWord(previous.text), firstWord(next.text), vocabulary);
}

function appendCellLine(
  cells: readonly WrappedText[],
  column: number,
  segment: Segment,
  cell: CellLine,
): void {
  const current = cells[column];
  if (current === undefined) return;
  const broken = cell.previous !== undefined && brokeInsideWord(cell.previous, segment, cell);
  if (broken) current.appendRaw(segment.text);
  else current.appendWrapped(segment.text, cell.vocabulary);
}

function columnRightEdges(block: TableBlock): readonly number[] {
  const edges = block.columns.map(() => 0);
  for (const row of block.rows) {
    for (const segment of row.segments) {
      const column = columnIndex(block.columns, segment.x);
      edges[column] = Math.max(edges[column] ?? 0, segment.right);
    }
  }
  return edges;
}

const BIMODAL_GAP_RATIO = 1.25;

/** A wrapped cell continues its logical row: it sits at the cell's line pitch, not the row pitch. */
function logicalTableRows(
  block: TableBlock,
  vocabulary: Vocabulary,
): readonly (readonly WrappedText[])[] {
  const gaps = rowGaps(block.rows);
  const lineGap = minOf(gaps);
  const bimodal = maxOf(gaps) >= lineGap * BIMODAL_GAP_RATIO;
  const edges = columnRightEdges(block);
  const previousInCell = new Map<string, Segment>();
  const logical: WrappedText[][] = [];
  block.rows.forEach((row, index) => {
    const firstColumnFilled = row.segments.some(
      (segment) => columnIndex(block.columns, segment.x) === 0,
    );
    const gap = gaps[index - 1] ?? Number.POSITIVE_INFINITY;
    const continues = bimodal ? gap <= lineGap * CELL_LINE_GAP_RATIO : !firstColumnFilled;
    const cells =
      (continues ? logical.at(-1) : undefined) ?? block.columns.map(() => new WrappedText(""));
    if (logical.at(-1) !== cells) logical.push(cells);
    for (const segment of row.segments) {
      const column = columnIndex(block.columns, segment.x);
      appendCellLine(cells, column, segment, {
        previous: previousInCell.get(`${String(logical.length)}:${String(column)}`),
        cellLeft: block.columns[column] ?? segment.x,
        cellRight: edges[column] ?? segment.right,
        vocabulary,
      });
      previousInCell.set(`${String(logical.length)}:${String(column)}`, segment);
    }
  });
  return logical;
}

function tableLines(block: TableBlock, vocabulary: Vocabulary): readonly string[] {
  return logicalTableRows(block, vocabulary).map((cells) =>
    cells.map((cell) => cell.toString()).join(" | "),
  );
}

// ─── Paragraphs ──────────────────────────────────────────────────────────────

interface TextLine {
  readonly text: string;
  readonly x: number;
  readonly right: number;
  readonly y: number;
  readonly height: number;
  readonly first: LayoutItem;
  /** The one font the whole line is set in, or undefined when it mixes fonts. */
  readonly font: string | undefined;
  /** The line ends at the margin on its left; layout cannot tell whether a wrap forced it. */
  readonly rightToLeft: boolean;
}

/** What is true of a whole document and decides how its lines are read. */
interface DocumentFacts {
  readonly bodyRight: number;
  readonly vocabulary: Vocabulary;
}

interface ParagraphContext {
  readonly leftEdge: number;
  readonly rightEdge: number;
  readonly hasFullLines: boolean;
  readonly pitch: number;
}

/** A line of a page's text, with what is needed to tell later whether it is a heading. */
interface OutLine {
  readonly text: string;
  readonly height?: number;
  readonly font?: string | undefined;
}

const BLANK_LINE: OutLine = Object.freeze({ text: "" });

function uniformFont(row: LayoutRow): string | undefined {
  const fonts = new Set(row.segments.flatMap((s) => s.items.map((item) => item.font)));
  return fonts.size === 1 ? [...fonts][0] : undefined;
}

function textLineOf(row: LayoutRow): TextLine | undefined {
  const first = row.segments[0]?.firstItem;
  if (first === undefined) return undefined;
  return {
    text: rowText(row),
    x: row.segments[0]?.x ?? 0,
    right: maxOf(row.segments.map((segment) => segment.right)),
    y: row.y,
    height: row.height,
    first,
    font: uniformFont(row),
    rightToLeft: isRightToLeftRow(row),
  };
}

function firstWordWidth(line: TextLine): number | undefined {
  const { first } = line;
  if (first.width <= 0 || first.text.length === 0) return undefined;
  return estimatedWordWidth(first, firstWord(first.text));
}

/** A word's width is estimated from its line's average glyph, which can be this far off. */
const WORD_WIDTH_UNCERTAINTY = 0.1;
const MIN_MARGIN_WIDTH_EMS = 20;

/** The break was forced: the next word would not have fit behind the previous line. */
function wasForcedByWidth(last: TextLine, line: TextLine, context: ParagraphContext): boolean {
  const width = firstWordWidth(line);
  if (width === undefined || !context.hasFullLines) return false;
  // The longest of a few short lines (an address, a list of names) is not a margin.
  if (context.rightEdge - context.leftEdge < last.height * MIN_MARGIN_WIDTH_EMS) return false;
  const reach = width * (1 + WORD_WIDTH_UNCERTAINTY);
  const nextWordEnd = last.right + last.height * SPACE_WIDTH_RATIO + reach;
  return nextWordEnd > context.rightEdge - WRAP_TOLERANCE;
}

const HEIGHT_CHANGE_RATIO = 1.1;

function sizesMatch(last: TextLine, line: TextLine): boolean {
  const larger = Math.max(last.height, line.height);
  const smaller = Math.max(Math.min(last.height, line.height), 1);
  return larger / smaller <= HEIGHT_CHANGE_RATIO;
}

const BULLET_START = /^[-–—*•·▪◦‣](?:\s|$)/u;
const ENUMERATOR_START = /^(?:\d+[.)]|[a-z][.)])\s/iu;

function isListItem(line: TextLine): boolean {
  return BULLET_START.test(line.text) || ENUMERATOR_START.test(line.text);
}

const ABBREVIATION_TAIL_CHARS = 16;
// "z.", "z.B." and "z. B.": a letter and its period abbreviate a word. A plain word cannot match.
const LETTER_ABBREVIATION_END =
  /(?:^|[^\p{L}\p{N}.])(?:\p{Ll}\.|\p{L}\.\p{L}\.(?:\p{L}\.)*|\p{Ll}\.\s\p{L}\.)$/u;
// Words a sentence ends in only by accident. Open-ended ones such as "usw." are deliberately absent.
const ABBREVIATIONS: ReadonlySet<string> = new Set(
  (
    "abb abs abzgl anh approx art bspw bzgl bzw ca cf dr evtl excl exkl fig fr gem ggf ggü hr " +
    "incl inkl kap lt max min mio mr mrd mrs ms nr prof sec sog tab tsd vgl vs ziff zzgl"
  ).split(" "),
);

function endsInAbbreviation(text: string): boolean {
  if (!text.endsWith(".")) return false;
  return (
    LETTER_ABBREVIATION_END.test(text.slice(-ABBREVIATION_TAIL_CHARS)) ||
    ABBREVIATIONS.has(wordKey(lastWord(text)))
  );
}

/**
 * "Hoch · Quelle: A" and then "· Jira: B": the previous line uses the glyph between its fields, so
 * the margin moved a separator to the line start. A list repeats it at each item's start instead.
 */
function usesMarkerInsideLine(head: TextLine, last: TextLine, line: TextLine): boolean {
  return !BULLET_START.test(head.text) && last.text.includes(` ${line.text.charAt(0)} `);
}

const INDENT_TOLERANCE = 2;

/** "16. April" is an enumerator only where the paragraph it would interrupt is one. */
function startsListItem(head: TextLine, last: TextLine, line: TextLine): boolean {
  if (BULLET_START.test(line.text)) return !usesMarkerInsideLine(head, last, line);
  if (!ENUMERATOR_START.test(line.text)) return false;
  return line.x <= head.x + INDENT_TOLERANCE && ENUMERATOR_START.test(head.text);
}

function hangsUnderListItem(head: TextLine, line: TextLine): boolean {
  return isListItem(head) && line.x > head.x + INDENT_TOLERANCE;
}

const SENTENCE_END = /[.!?]$/u;
const LEAD_IN_END = /[.!?:;]$/u;
const UPPER_START = /^\p{Lu}/u;

/** The margin forced this break, but the sense ends here anyway: a new sentence or a list. */
function opensNewLineOfSense(last: TextLine, line: TextLine): boolean {
  if (SENTENCE_END.test(last.text) && UPPER_START.test(line.text)) return true;
  return LEAD_IN_END.test(last.text) && ENUMERATOR_START.test(line.text);
}

const PARAGRAPH_PITCH_RATIO = 1.25;
const PARAGRAPH_HEIGHT_RATIO = 1.45;

function isParagraphGap(last: TextLine, line: TextLine, context: ParagraphContext): boolean {
  const limit = Math.max(
    context.pitch * PARAGRAPH_PITCH_RATIO,
    Math.max(last.height, line.height) * PARAGRAPH_HEIGHT_RATIO,
  );
  return last.y - line.y > limit;
}

/** Whether the line reads as the wrap of the line before it, wherever the two are drawn. */
function readsAsWrap(
  head: TextLine,
  last: TextLine,
  line: TextLine,
  context: ParagraphContext,
): boolean {
  if (last.rightToLeft || line.rightToLeft || !sizesMatch(last, line)) return false;
  if (!wasForcedByWidth(last, line, context)) return false;
  if (endsInAbbreviation(last.text)) return true;
  if (startsListItem(head, last, line)) return false;
  return hangsUnderListItem(head, line) || !opensNewLineOfSense(last, line);
}

function continuesParagraph(
  head: TextLine,
  last: TextLine,
  line: TextLine,
  context: ParagraphContext,
): boolean {
  return !isParagraphGap(last, line, context) && readsAsWrap(head, last, line, context);
}

/** Where a line must sit to belong to the paragraph the page before closed with. */
function sitsInParagraph(closing: ClosingParagraph, opening: TextLine): boolean {
  const { head, last } = closing;
  if (!isListItem(head)) return opening.x <= last.x + INDENT_TOLERANCE;
  if (hangsUnderListItem(head, opening)) return true;
  // Whether the item's wrapped lines hang shows in its own lines. A single line does not show it,
  // so only a sentence that visibly goes on belongs to it.
  return last === head ? LOWER_START.test(opening.text) : last.x <= head.x + INDENT_TOLERANCE;
}

/** A page break says nothing about a paragraph: there is no gap to read, only the lines' places. */
function goesOnBehindPageBreak(closing: ClosingParagraph, opening: TextLine): boolean {
  return (
    sitsInParagraph(closing, opening) &&
    readsAsWrap(closing.head, closing.last, opening, closing.context)
  );
}

const FULL_LINE_RATIO = 0.8;
const MIN_FULL_LINES = 2;

function paragraphContext(lines: readonly TextLine[], bodyRight: number): ParagraphContext {
  const rightEdge = maxOf(
    lines.map((line) => line.right),
    bodyRight,
  );
  const left = minOf(lines.map((line) => line.x));
  const full = lines.filter(
    (line) => line.right - left >= (rightEdge - left) * FULL_LINE_RATIO,
  ).length;
  return {
    leftEdge: left,
    rightEdge,
    hasFullLines: bodyRight > 0 || full >= MIN_FULL_LINES,
    pitch: lowerQuartile(rowGaps(lines)),
  };
}

/** The lines of one flow, with the paragraph still being written kept open until it ends. */
class ParagraphWriter {
  private readonly out: OutLine[] = [];
  private open: WrappedText | undefined;
  private head: TextLine | undefined;
  private last: TextLine | undefined;

  constructor(
    private readonly context: ParagraphContext,
    private readonly vocabulary: Vocabulary,
  ) {}

  add(line: TextLine): void {
    if (this.continues(line)) this.open?.appendWrapped(line.text, this.vocabulary);
    else this.startParagraph(line);
    this.last = line;
  }

  finish(): readonly OutLine[] {
    this.closeOpen();
    return this.out;
  }

  /** The paragraph the last line added belongs to. */
  paragraphInProgress(): { readonly head: TextLine; readonly last: TextLine } | undefined {
    return this.head === undefined || this.last === undefined
      ? undefined
      : { head: this.head, last: this.last };
  }

  private continues(line: TextLine): boolean {
    return (
      this.head !== undefined &&
      this.last !== undefined &&
      this.open !== undefined &&
      continuesParagraph(this.head, this.last, line, this.context)
    );
  }

  private startParagraph(line: TextLine): void {
    this.closeOpen();
    if (this.last !== undefined && isParagraphGap(this.last, line, this.context)) {
      this.out.push(BLANK_LINE);
    }
    this.out.push({
      text: line.text,
      height: line.height,
      font: isListItem(line) ? undefined : line.font,
    });
    this.open = new WrappedText(line.text);
    this.head = line;
  }

  private closeOpen(): void {
    const index = this.out.length - 1;
    const line = this.out[index];
    if (this.open !== undefined && line !== undefined) {
      this.out[index] = { ...line, text: this.open.toString() };
    }
    this.open = undefined;
  }
}

function paragraphLines(rows: readonly LayoutRow[], facts: DocumentFacts): readonly OutLine[] {
  const lines = rows.map((row) => textLineOf(row)).filter((line) => line !== undefined);
  if (lines.length === 0) return [];
  const writer = new ParagraphWriter(paragraphContext(lines, facts.bodyRight), facts.vocabulary);
  for (const line of lines) writer.add(line);
  return writer.finish();
}

type FlowBlock =
  | { readonly kind: "prose"; readonly rows: readonly LayoutRow[] }
  | { readonly kind: "table"; readonly table: TableBlock };

function flowBlocks(rows: readonly LayoutRow[]): readonly FlowBlock[] {
  const blocks: FlowBlock[] = [];
  let prose: LayoutRow[] = [];
  const closeProse = (): void => {
    if (prose.length > 0) blocks.push({ kind: "prose", rows: prose });
    prose = [];
  };
  let index = 0;
  while (index < rows.length) {
    const table = readTableBlock(rows, index);
    if (table === undefined) {
      const row = rows[index];
      if (row !== undefined) prose.push(row);
      index += 1;
    } else {
      closeProse();
      blocks.push({ kind: "table", table });
      index += table.rows.length;
    }
  }
  closeProse();
  return blocks;
}

function flowLines(blocks: readonly FlowBlock[], facts: DocumentFacts): readonly OutLine[] {
  return blocks.flatMap((block) =>
    block.kind === "prose"
      ? paragraphLines(block.rows, facts)
      : [
          BLANK_LINE,
          ...tableLines(block.table, facts.vocabulary).map((text) => ({ text })),
          BLANK_LINE,
        ],
  );
}

// ─── Headings ────────────────────────────────────────────────────────────────

interface BodyStyle {
  readonly height: number;
  readonly font: string;
}

/** What most of the document's characters are set in. */
function bodyStyleOf(pages: readonly PageLayout[]): BodyStyle {
  const weights = new Map<string, { style: BodyStyle; weight: number }>();
  for (const item of pages.flatMap((page) =>
    page.rows.flatMap((row) => row.segments.flatMap((segment) => segment.items)),
  )) {
    const key = `${item.font}@${item.height.toFixed(1)}`;
    const entry = weights.get(key) ?? {
      style: { height: item.height, font: item.font },
      weight: 0,
    };
    weights.set(key, { style: entry.style, weight: entry.weight + item.text.length });
  }
  const ranked = [...weights.values()].sort((a, b) => b.weight - a.weight);
  return ranked[0]?.style ?? { height: 0, font: "" };
}

const HEADING_MAX_CHARS = 160;
const NOT_A_HEADING_END = /[.!?:;,]$/u;

function headingSize(line: OutLine, body: BodyStyle): number | undefined {
  const { height, font } = line;
  if (height === undefined || body.height <= 0) return undefined;
  if (line.text.length > HEADING_MAX_CHARS || NOT_A_HEADING_END.test(line.text)) return undefined;
  if (height >= body.height * HEADING_SIZE_RATIO) return height;
  // A heading set in the body's size stands out by its face, and only as a whole line.
  const distinctFace = font !== undefined && font.length > 0 && font !== body.font;
  return distinctFace && height >= body.height ? height : undefined;
}

function isHeadingLine(lines: readonly OutLine[], index: number, body: BodyStyle): boolean {
  const line = lines[index];
  if (line === undefined || headingSize(line, body) === undefined) return false;
  if ((line.height ?? 0) >= body.height * HEADING_SIZE_RATIO) return true;
  const before = lines[index - 1];
  return before === undefined || before.text.length === 0;
}

const HEADING_MAX_LEVEL = 6;
const HEADING_SIZE_BUCKET = 2;

function headingLevels(sizes: readonly number[]): ReadonlyMap<number, number> {
  const bucket = (size: number): number => Math.round(size * HEADING_SIZE_BUCKET);
  const ranked = [...new Set(sizes.map((size) => bucket(size)))].sort((a, b) => b - a);
  return new Map(
    sizes.map((size) => [size, Math.min(ranked.indexOf(bucket(size)) + 1, HEADING_MAX_LEVEL)]),
  );
}

interface ComposedPageLines {
  readonly text: string;
  readonly candidates: readonly { readonly offset: number; readonly line: OutLine }[];
}

function layOutPageText(lines: readonly OutLine[], body: BodyStyle): ComposedPageLines {
  let text = "";
  let pendingBlank = false;
  const candidates: { offset: number; line: OutLine }[] = [];
  lines.forEach((line, index) => {
    if (line.text.length === 0) {
      pendingBlank = true;
      return;
    }
    // A heading is a block of its own, however tightly the page sets it against its neighbours.
    const heading = isHeadingLine(lines, index, body);
    if (text.length > 0) text += pendingBlank || heading ? "\n\n" : "\n";
    pendingBlank = heading;
    if (heading) candidates.push({ offset: text.length, line });
    text += line.text;
  });
  return { text, candidates };
}

/** The sections a document's headings open, up to the end of its text. */
export function sectionsFromHeadings(
  headings: readonly { readonly start: number; readonly title: string; readonly level: number }[],
  end: number,
): readonly PdfSection[] {
  const stack: { readonly title: string; readonly level: number }[] = [];
  const first = headings[0];
  const preamble: PdfSection[] =
    first !== undefined && first.start > 0
      ? [{ sectionPath: [], characterStart: 0, characterEnd: first.start }]
      : [];
  return [
    ...preamble,
    ...headings.map((heading, index) => {
      while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
      stack.push(heading);
      return {
        sectionPath: stack.map((open) => open.title),
        characterStart: heading.start,
        characterEnd: headings[index + 1]?.start ?? end,
      };
    }),
  ];
}

// ─── Pages ───────────────────────────────────────────────────────────────────

interface PagePlan {
  readonly page: PageLayout;
  readonly flows: readonly (readonly FlowBlock[])[];
}

function planPage(page: PageLayout): PagePlan {
  return { page, flows: readingFlows(page.rows).map((flow) => flowBlocks(flow)) };
}

function proseRightEdge(plan: PagePlan): readonly number[] {
  const rights = plan.flows
    .flat()
    .flatMap((block) => (block.kind === "prose" ? block.rows : []))
    .flatMap((row) => row.segments.map((segment) => segment.right));
  return rights.length === 0 ? [] : [maxOf(rights)];
}

/**
 * The right edge most pages' running text shares; a short last page wraps against the same margin.
 * Tables are no evidence: their cell padding can overhang the margin text wraps against.
 */
function documentBodyRight(plans: readonly PagePlan[]): number {
  const edges = plans
    .filter((plan) => plan.flows.length === 1)
    .flatMap((plan) => proseRightEdge(plan));
  const ordered = [...edges].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function factsForFlows(plan: PagePlan, facts: DocumentFacts): DocumentFacts {
  return plan.flows.length === 1 ? facts : { ...facts, bodyRight: 0 };
}

function composePageLines(plan: PagePlan, facts: DocumentFacts): readonly OutLine[] {
  const flowFacts = factsForFlows(plan, facts);
  return [
    ...plan.flows.flatMap((blocks) => flowLines(blocks, flowFacts)),
    ...plan.page.offAxis.map((text) => ({ text })),
  ];
}

// ─── Paragraphs across pages ─────────────────────────────────────────────────

interface ClosingParagraph {
  readonly head: TextLine;
  readonly last: TextLine;
  readonly context: ParagraphContext;
  readonly vocabulary: Vocabulary;
}

/** How a page's text ends and how it starts, as far as a paragraph could run over either. */
export interface PageEdge {
  readonly closing?: ClosingParagraph | undefined;
  readonly opening?: TextLine | undefined;
}

function textLinesOf(rows: readonly LayoutRow[]): readonly TextLine[] {
  return rows.map((row) => textLineOf(row)).filter((line) => line !== undefined);
}

function endsInHeading(page: ComposedPageLines): boolean {
  const last = page.candidates.at(-1);
  return last !== undefined && last.offset + last.line.text.length === page.text.length;
}

/** The running text a page ends with: a table, a heading or a margin note end the paragraph. */
function closingParagraph(
  plan: PagePlan,
  page: ComposedPageLines,
  facts: DocumentFacts,
): ClosingParagraph | undefined {
  const block = plan.flows.at(-1)?.at(-1);
  if (block?.kind !== "prose" || plan.page.offAxis.length > 0 || endsInHeading(page)) {
    return undefined;
  }
  const lines = textLinesOf(block.rows);
  const context = paragraphContext(lines, factsForFlows(plan, facts).bodyRight);
  const writer = new ParagraphWriter(context, facts.vocabulary);
  for (const line of lines) writer.add(line);
  const open = writer.paragraphInProgress();
  return open === undefined ? undefined : { ...open, context, vocabulary: facts.vocabulary };
}

function openingLine(plan: PagePlan, page: ComposedPageLines): TextLine | undefined {
  const block = plan.flows[0]?.[0];
  if (block?.kind !== "prose" || page.candidates[0]?.offset === 0) return undefined;
  const row = block.rows[0];
  return row === undefined ? undefined : textLineOf(row);
}

function pageEdgeOf(plan: PagePlan, page: ComposedPageLines, facts: DocumentFacts): PageEdge {
  if (plan.page.plain.length > 0) return {};
  return {
    closing: closingParagraph(plan, page, facts),
    opening: openingLine(plan, page),
  };
}

export interface JoinedPages {
  readonly texts: readonly string[];
  readonly separators: readonly (string | undefined)[];
  readonly lastEdge: PageEdge | undefined;
}

/** The separator of one page break a paragraph runs over; a wrap hyphen ahead of it goes. */
function separatorOverBreak(
  joined: string[],
  index: number,
  closing: ClosingParagraph,
  opening: TextLine,
): string {
  const previous = index === 0 ? undefined : joined[index - 1];
  const tail = previous ?? closing.last.text;
  const join = wrapJoinOf(tail.slice(-JOIN_TAIL_CHARS), opening.text, closing.vocabulary);
  if (join.dropHyphen && previous !== undefined) joined[index - 1] = previous.slice(0, -1);
  return join.separator;
}

/**
 * True when the spelling of a run's last word depends on the page after the run: a hyphen a wrap may
 * have added ends its running text. Only then does that page have to be looked at ahead of its turn.
 */
export function endsInOpenHyphen(
  texts: readonly string[],
  edges: readonly (PageEdge | undefined)[],
): boolean {
  return edges.at(-1)?.closing !== undefined && HYPHENATED_END.test(texts.at(-1) ?? "");
}

/** How the next run opens, composed the way its own turn will compose it. */
export function openingOfRun(
  pages: readonly PageLayout[],
  furniture: ReadonlySet<string>,
): TextLine | undefined {
  const first = pages[0];
  if (first === undefined || !hasPageContent(first)) return undefined;
  return composeWindow(
    pages.filter((page) => hasPageContent(page)),
    furniture,
  ).edges[0]?.opening;
}

function withoutClosingWrapHyphen(
  joined: string[],
  closing: ClosingParagraph | undefined,
  next: TextLine | undefined,
): void {
  const last = joined.at(-1);
  if (closing === undefined || next === undefined || last === undefined) return;
  if (!goesOnBehindPageBreak(closing, next)) return;
  const join = wrapJoinOf(last.slice(-JOIN_TAIL_CHARS), next.text, closing.vocabulary);
  if (join.dropHyphen) joined[joined.length - 1] = last.slice(0, -1);
}

/**
 * Carries paragraphs over the page breaks of one run. A page without an edge stands for a page that
 * has no layout and stops a paragraph. `next` is how the next run opens, when a word may run over
 * into it: a run is handed on as it stands, so its last page has to know that already. The size of
 * a run never chooses a spelling.
 */
export function joinAcrossPages(
  texts: readonly string[],
  edges: readonly (PageEdge | undefined)[],
  before: PageEdge | undefined,
  next?: TextLine,
): JoinedPages {
  const joined = [...texts];
  const separators = edges.map((edge, index) => {
    const closing = (index === 0 ? before : edges[index - 1])?.closing;
    const opening = edge?.opening;
    if (closing === undefined || opening === undefined) return undefined;
    if (!goesOnBehindPageBreak(closing, opening)) return undefined;
    return separatorOverBreak(joined, index, closing, opening);
  });
  withoutClosingWrapHyphen(joined, edges.at(-1)?.closing, next);
  return { texts: joined, separators, lastEdge: edges.at(-1) };
}

interface RawHeading {
  readonly offset: number;
  readonly title: string;
  readonly height: number;
}

interface WindowComposition {
  readonly texts: readonly string[];
  readonly edges: readonly (PageEdge | undefined)[];
  readonly headings: readonly (readonly RawHeading[])[];
  readonly removedRows: number;
  readonly furniture: ReadonlySet<string>;
}

function rowCount(list: readonly PageLayout[]): number {
  return list.reduce((sum, page) => sum + page.rows.length + page.offAxis.length, 0);
}

function composeWindow(
  pages: readonly PageLayout[],
  knownFurniture: ReadonlySet<string>,
): WindowComposition {
  const bodyHeight = bodyStyleOf(pages).height;
  const furniture = new Set([...knownFurniture, ...repeatedFurniture(pages, bodyHeight)]);
  const cleaned = pages.map((page) => withoutFurniture(page, furniture, bodyHeight));
  const plans = cleaned.map((page) => planPage(page));
  const facts: DocumentFacts = {
    bodyRight: documentBodyRight(plans),
    vocabulary: documentVocabulary(cleaned),
  };
  const body = bodyStyleOf(cleaned);
  const laidOut = plans.map((plan) =>
    plan.page.plain.length > 0
      ? { text: plan.page.plain, candidates: [] }
      : layOutPageText(composePageLines(plan, facts), body),
  );
  return {
    texts: laidOut.map((page) => page.text),
    edges: plans.map((plan, index) => {
      const page = laidOut[index];
      return page === undefined ? undefined : pageEdgeOf(plan, page, facts);
    }),
    headings: laidOut.map((page) =>
      page.candidates.map(({ offset, line }) => ({
        offset,
        title: line.text,
        height: line.height ?? 0,
      })),
    ),
    removedRows: rowCount(pages) - rowCount(cleaned),
    // A window uses all it found, and hands on a bounded part. What comes first stays, so a resumed
    // run that restores this set composes its pages as a continuous run does.
    furniture: new Set([...furniture].slice(0, MAX_LEARNED_FURNITURE)),
  };
}

/** Levels follow the sizes of all the headings given, so they are comparable across pages. */
function withLevels(
  headings: readonly (readonly RawHeading[])[],
): readonly (readonly PageHeading[])[] {
  const levels = headingLevels(headings.flatMap((page) => page.map(({ height }) => height)));
  return headings.map((page) =>
    page.map(({ offset, title, height }) => ({ offset, title, level: levels.get(height) ?? 1 })),
  );
}

/** Whether a page carries any text at all; a page that does not is left out of what is learned. */
export function hasPageContent(page: PageLayout): boolean {
  return page.rows.length > 0 || page.offAxis.length > 0 || page.plain.length > 0;
}

/**
 * The logical text of a run of pages. Repeated furniture, the body style and the margin are facts
 * about the document, so they are decided across the pages together, with what earlier runs of the
 * same document already proved.
 */
export function composePages(
  pages: readonly PageLayout[],
  knownFurniture: ReadonlySet<string> = new Set(),
): ComposedPages {
  const composed = composeWindow(pages, knownFurniture);
  return { ...composed, headings: withLevels(composed.headings) };
}

/** Puts the composition of a run's pages with text back at their places, empty pages between. */
function spreadOverRun(run: readonly PageLayout[], composed: WindowComposition): WindowComposition {
  let next = 0;
  const placed = run.map((page) => {
    if (!hasPageContent(page)) {
      return { text: "", edge: undefined, headings: [] as readonly RawHeading[] };
    }
    const index = next;
    next += 1;
    return {
      text: composed.texts[index] ?? "",
      edge: composed.edges[index],
      headings: composed.headings[index] ?? [],
    };
  });
  return {
    ...composed,
    texts: placed.map(({ text }) => text),
    edges: placed.map(({ edge }) => edge),
    headings: placed.map(({ headings }) => headings),
  };
}

/**
 * A whole document composed the way a progressive extraction composes it: run by run of
 * `windowPages` pages, each run learning from its own pages and from what earlier runs proved. A
 * page without text takes no part in what a run learns. Both routes read one file as one text.
 */
export function composeInWindows(
  pages: readonly PageLayout[],
  windowPages: number,
): ComposedDocument {
  const step = Math.max(1, windowPages);
  const runs: (WindowComposition & JoinedPages)[] = [];
  let furniture: ReadonlySet<string> = new Set();
  let lastEdge: PageEdge | undefined;
  for (let first = 0; first < pages.length; first += step) {
    const run = pages.slice(first, first + step);
    const withText = composeWindow(
      run.filter((page) => hasPageContent(page)),
      furniture,
    );
    furniture = withText.furniture;
    const placed = spreadOverRun(run, withText);
    const next = endsInOpenHyphen(placed.texts, placed.edges)
      ? openingOfRun(pages.slice(first + step, first + 2 * step), furniture)
      : undefined;
    const joined = joinAcrossPages(placed.texts, placed.edges, lastEdge, next);
    lastEdge = joined.lastEdge;
    runs.push({ ...placed, ...joined });
  }
  return {
    texts: runs.flatMap((run) => run.texts),
    separators: runs.flatMap((run) => run.separators),
    edges: runs.flatMap((run) => run.edges),
    headings: withLevels(runs.flatMap((run) => run.headings)),
    removedRows: runs.reduce((sum, run) => sum + run.removedRows, 0),
    furniture,
  };
}
