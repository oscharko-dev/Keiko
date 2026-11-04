// Rebuilds the logical text of a PDF page from the positions pdf.js reports (#4235). A PDF stores
// glyph runs, not paragraphs, so this module owns what every consumer needs and no consumer can
// recover from flat text: the reading order of rows, columns and table cells, the paragraph a
// wrapped line belongs to, and the page furniture a document repeats. Everything is decided from
// layout evidence. Where the evidence is missing, a line stays a line.

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
  readonly headings: readonly (readonly PageHeading[])[];
  readonly removedRows: number;
  readonly furniture: ReadonlySet<string>;
}

export interface PdfSection {
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
}

const BASELINE_TOLERANCE_RATIO = 0.4;
const BASELINE_TOLERANCE_MIN = 2;
const AXIS_TOLERANCE_DEGREES = 2;
const WORD_GAP_RATIO = 0.12;
const SEGMENT_GAP_RATIO = 1;
const SEGMENT_GAP_MIN = 3;
const DUPLICATE_DRAW_TOLERANCE = 1;
const FULL_WIDTH_RATIO = 0.65;
const MIN_GUTTER = 8;
const MIN_COLUMN_LINES = 4;
const MIN_UNMEASURED_COLUMN_LINES = 2;
const COLUMN_BALANCE_RATIO = 0.6;
const MAX_GUTTER_SHARE = 0.5;
const COLUMN_FILL_RATIO = 0.7;
const COLUMN_FILLED_SHARE = 0.6;
const COLUMN_ALIGN_TOLERANCE = 3;
const SPACE_WIDTH_RATIO = 0.25;
const WRAP_TOLERANCE = 1.5;
/** A word's width is estimated from its line's average glyph, which can be this far off. */
const WORD_WIDTH_UNCERTAINTY = 0.1;
const CELL_EDGE_REACH_RATIO = 0.7;
const FULL_LINE_RATIO = 0.8;
const MIN_MARGIN_WIDTH_EMS = 20;
const MIN_FULL_LINES = 2;
const HEIGHT_CHANGE_RATIO = 1.1;
const PARAGRAPH_PITCH_RATIO = 1.25;
const PARAGRAPH_HEIGHT_RATIO = 1.45;
const INDENT_TOLERANCE = 2;
const TABLE_MIN_ROWS = 2;
const TABLE_MAX_COLUMNS = 64;
const TABLE_GAP_LIMIT_RATIO = 1.8;
const TABLE_GAP_HEIGHT_RATIO = 2;
const CELL_LINE_GAP_RATIO = 1.15;
const BIMODAL_GAP_RATIO = 1.25;
const HEADING_SIZE_RATIO = 1.12;
const HEADING_MAX_CHARS = 160;
const HEADING_MAX_LEVEL = 6;
const HEADING_SIZE_BUCKET = 2;
const EDGE_ROWS = 2;
const FURNITURE_MIN_PAGES = 3;
const FURNITURE_PAGE_SHARE = 0.4;
const FURNITURE_Y_BUCKET = 3;
const FURNITURE_ISOLATION_RATIO = 1.5;

const LIST_MARKER_ONLY = /^(?:[-–—*•·▪◦‣]|\d{1,3}[.)]?|[a-z][.)])$/iu;
const NOT_A_HEADING_END = /[.!?:;,]$/u;
const BARE_NUMBER = /^\d+$/u;
const BULLET_START = /^[-–—*•·▪◦‣](?:\s|$)/u;
const ENUMERATOR_START = /^(?:\d+[.)]|[a-z][.)])\s/iu;
const SENTENCE_END = /[.!?]$/u;
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
const LEAD_IN_END = /[.!?:;]$/u;
const UPPER_START = /^\p{Lu}/u;
const HYPHENATED_END = /\p{L}-$/u;
const LOWER_START = /^\p{Ll}/u;
const WORD_CONTINUATION_START = /^[\p{Ll}\p{N}]/u;
const COMPOUND_START = /^[\p{Lu}\p{N}]/u;
// "Ein- und Auszahlung": a word that follows a suspended hyphen keeps it.
const SUSPENDED_HYPHEN_NEXT = /^(?:und|oder|bzw|sowie|bis|and|or)\b/u;
const WORD_CORE = /[\p{L}\p{N}](?:.*[\p{L}\p{N}])?/su;
const NUMBER_FRAGMENT_END = /[\p{N}-]$/u;
const NUMBER_FRAGMENT_START = /^\p{N}/u;
const ZERO_WIDTH = /[\u200B\u2060\uFEFF]/gu;

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

function cleanItemText(raw: string): string {
  return raw
    .replaceAll(ZERO_WIDTH, "")
    .replaceAll(" ", " ")
    .trim()
    .replaceAll(/­(?=.)/gu, "")
    .replaceAll(/­$/gu, "-");
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

function isDuplicateDraw(previous: LayoutItem | undefined, item: LayoutItem): boolean {
  return previous?.text === item.text && Math.abs(previous.x - item.x) <= DUPLICATE_DRAW_TOLERANCE;
}

function needsWordSpace(previous: LayoutItem, item: LayoutItem): boolean {
  if (previous.width <= 0) return true;
  return item.x - previous.right > Math.max(previous.height, item.height) * WORD_GAP_RATIO;
}

function toSegment(items: readonly LayoutItem[], first: LayoutItem): Segment {
  let text = "";
  items.forEach((item, index) => {
    const previous = items[index - 1];
    text += previous !== undefined && needsWordSpace(previous, item) ? ` ${item.text}` : item.text;
  });
  return {
    text,
    x: first.x,
    right: maxOf(items.map((item) => item.right)),
    items,
    firstItem: first,
  };
}

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

/** A marker drawn apart from its text is one list item, not two table cells. */
function withListMarkerJoined(segments: readonly Segment[]): readonly Segment[] {
  const [marker, body] = segments;
  if (segments.length !== 2 || marker === undefined || body === undefined) return segments;
  if (!LIST_MARKER_ONLY.test(marker.text)) return segments;
  const label = BARE_NUMBER.test(marker.text) ? `${marker.text}.` : marker.text;
  return [{ ...body, text: `${label} ${body.text}`, x: marker.x }];
}

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
      current.height = Math.max(current.height, item.height);
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

/** What pdf.js reported for one page, reduced to the evidence reading order is decided from. */
export function pageLayoutOf(items: readonly PositionedTextItem[]): PageLayout {
  const positioned = items.filter(hasPosition);
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
    .filter(onAxis)
    .map((item) => layoutItem(item, angle))
    .filter((item) => item.text.length > 0);
  const rows = layoutRows(readable);
  const offAxis = positioned
    .filter((item) => !onAxis(item))
    .map((item) => cleanItemText(item.str ?? ""))
    .filter((value) => value.length > 0);
  return { rows, offAxis, plain: "" };
}

function rowText(row: LayoutRow): string {
  return row.segments.map((segment) => segment.text).join(" ");
}

// ─── Repeated page furniture ─────────────────────────────────────────────────

function furnitureKey(row: LayoutRow): string {
  const text = rowText(row)
    .toLowerCase()
    .replaceAll(/\p{N}+/gu, "#")
    .replaceAll(/\s+/gu, " ");
  return `${text}@${String(Math.round(row.y / FURNITURE_Y_BUCKET))}`;
}

function offAxisKey(text: string): string {
  return `off-axis:${text.toLowerCase().replaceAll(/\p{N}+/gu, "#")}`;
}

function isolatingGap(pitch: number): number {
  return pitch * FURNITURE_ISOLATION_RATIO;
}

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

function repeatedFurniture(pages: readonly PageLayout[]): ReadonlySet<string> {
  if (pages.length < FURNITURE_MIN_PAGES) return new Set();
  const counts = new Map<string, number>();
  const count = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const page of pages) {
    new Set(edgeRows(page.rows).map((row) => furnitureKey(row))).forEach(count);
    new Set(page.offAxis.map((text) => offAxisKey(text))).forEach(count);
  }
  const needed = Math.max(FURNITURE_MIN_PAGES, Math.ceil(pages.length * FURNITURE_PAGE_SHARE));
  return new Set([...counts].filter(([, seen]) => seen >= needed).map(([key]) => key));
}

function withoutFurniture(page: PageLayout, furniture: ReadonlySet<string>): PageLayout {
  const edges = new Set(edgeRows(page.rows));
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

/** Running text fills its column; table cells mostly do not. */
function fillsColumn(segments: readonly Segment[], x: number, right: number): boolean {
  const available = right - x;
  const filled = segments.filter(
    (segment) => segment.right - x >= available * COLUMN_FILL_RATIO,
  ).length;
  return filled >= segments.length * COLUMN_FILLED_SHARE;
}

function hasColumnEvidence(
  left: readonly Segment[],
  right: readonly Segment[],
  gutter: Gutter,
): boolean {
  if (!isMeasured([...left, ...right])) {
    return (
      left.length >= MIN_UNMEASURED_COLUMN_LINES && right.length >= MIN_UNMEASURED_COLUMN_LINES
    );
  }
  if (left.length < MIN_COLUMN_LINES || right.length < MIN_COLUMN_LINES) return false;
  const leftEdge = minOf(left.map((segment) => segment.x));
  const rightEdge = maxOf(right.map((segment) => segment.right));
  const leftWidth = gutter.start - leftEdge;
  const rightWidth = rightEdge - gutter.end;
  const narrower = Math.min(leftWidth, rightWidth);
  if (narrower < Math.max(leftWidth, rightWidth) * COLUMN_BALANCE_RATIO) return false;
  if (gutter.end - gutter.start > narrower * MAX_GUTTER_SHARE) return false;
  return fillsColumn(left, leftEdge, gutter.start) && fillsColumn(right, gutter.end, rightEdge);
}

function gutterOf(rows: readonly LayoutRow[]): Gutter | undefined {
  const all = rows.flatMap((row) => row.segments);
  const pageLeft = minOf(all.map((segment) => segment.x));
  const pageRight = maxOf(all.map((segment) => segment.right));
  const limit = (pageRight - pageLeft) * FULL_WIDTH_RATIO;
  const body = all.filter((segment) => segment.right - segment.x <= limit);
  const gaps = coverageGaps(body);
  const gap = gaps[0];
  if (gap === undefined || gaps.length !== 1) return undefined;
  const left = body.filter((segment) => segment.right <= gap.start);
  const right = body.filter((segment) => segment.x >= gap.end);
  return hasColumnEvidence(left, right, gap) ? gap : undefined;
}

/** Rows split into reading flows: full-width bands stay in place, a column pair reads left first. */
function readingFlows(rows: readonly LayoutRow[]): readonly (readonly LayoutRow[])[] {
  const gutter = rows.length === 0 ? undefined : gutterOf(rows);
  if (gutter === undefined) return rows.length === 0 ? [] : [rows];
  const flows: (readonly LayoutRow[])[] = [];
  let band: LayoutRow[] = [];
  let left: LayoutRow[] = [];
  let right: LayoutRow[] = [];
  const flush = (next: "band" | "columns"): void => {
    if (next === "columns" && band.length > 0) {
      flows.push(band);
      band = [];
    }
    if (next === "band") {
      if (left.length > 0) flows.push(left);
      if (right.length > 0) flows.push(right);
      left = [];
      right = [];
    }
  };
  for (const row of rows) {
    if (row.segments.some((s) => s.x < gutter.end && s.right > gutter.start)) {
      flush("band");
      band.push(row);
      continue;
    }
    flush("columns");
    for (const segment of row.segments) {
      (segment.x < gutter.end ? left : right).push({ ...row, segments: [segment] });
    }
  }
  flush("band");
  flush("columns");
  return flows;
}

// ─── Tables ──────────────────────────────────────────────────────────────────

interface TableBlock {
  readonly columns: readonly number[];
  readonly rows: readonly LayoutRow[];
}

function columnIndex(columns: readonly number[], x: number): number {
  let index = 0;
  columns.forEach((column, position) => {
    if (column <= x + COLUMN_ALIGN_TOLERANCE) index = position;
  });
  return index;
}

function alignsToColumn(columns: readonly number[], x: number): boolean {
  return columns.some((column) => Math.abs(column - x) <= COLUMN_ALIGN_TOLERANCE);
}

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

function joinWrapped(left: string, right: string, vocabulary: Vocabulary): string {
  if (left.length === 0) return right;
  if (!HYPHENATED_END.test(left)) return `${left} ${right}`;
  if (LOWER_START.test(right) && !SUSPENDED_HYPHEN_NEXT.test(right)) {
    return keepsWrapHyphen(left, right, vocabulary)
      ? `${left}${right}`
      : `${left.slice(0, -1)}${right}`;
  }
  return COMPOUND_START.test(right) ? `${left}${right}` : `${left} ${right}`;
}

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

/** Layout cannot tell a long whole word from a fragment, because it defines the cell's edge itself. */
function areFragmentsOfOneWord(head: string, tail: string, vocabulary: Vocabulary): boolean {
  // An identifier's digits are no words, so the document cannot use them on their own.
  if (NUMBER_FRAGMENT_END.test(head) && NUMBER_FRAGMENT_START.test(tail)) return true;
  if (vocabulary.has(wordKey(`${head}${tail}`))) return true;
  const usedAgain = (word: string): boolean => (vocabulary.get(wordKey(word)) ?? 0) > 1;
  return !usedAgain(head) && !usedAgain(tail);
}

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

function appendCellLine(cells: string[], column: number, segment: Segment, cell: CellLine): void {
  const current = cells[column] ?? "";
  const broken = cell.previous !== undefined && brokeInsideWord(cell.previous, segment, cell);
  cells[column] = broken
    ? `${current}${segment.text}`
    : joinWrapped(current, segment.text, cell.vocabulary);
}

function columnRightEdges(block: TableBlock): readonly number[] {
  return block.columns.map((_, column) => {
    const rights = block.rows.flatMap((row) =>
      row.segments
        .filter((segment) => columnIndex(block.columns, segment.x) === column)
        .map((segment) => segment.right),
    );
    return maxOf(rights, 0);
  });
}

/** A wrapped cell continues its logical row: it sits at the cell's line pitch, not the row pitch. */
function logicalTableRows(block: TableBlock, vocabulary: Vocabulary): readonly string[][] {
  const gaps = rowGaps(block.rows);
  const lineGap = minOf(gaps);
  const bimodal = maxOf(gaps) >= lineGap * BIMODAL_GAP_RATIO;
  const edges = columnRightEdges(block);
  const previousInCell = new Map<string, Segment>();
  const logical: string[][] = [];
  block.rows.forEach((row, index) => {
    const firstColumnFilled = row.segments.some(
      (segment) => columnIndex(block.columns, segment.x) === 0,
    );
    const gap = gaps[index - 1] ?? Number.POSITIVE_INFINITY;
    const continues = bimodal ? gap <= lineGap * CELL_LINE_GAP_RATIO : !firstColumnFilled;
    const cells = (continues ? logical.at(-1) : undefined) ?? block.columns.map(() => "");
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
  return logicalTableRows(block, vocabulary).map((cells) => cells.join(" | "));
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
  };
}

function firstWordWidth(line: TextLine): number | undefined {
  const { first } = line;
  if (first.width <= 0 || first.text.length === 0) return undefined;
  return estimatedWordWidth(first, firstWord(first.text));
}

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

function sizesMatch(last: TextLine, line: TextLine): boolean {
  const larger = Math.max(last.height, line.height);
  const smaller = Math.max(Math.min(last.height, line.height), 1);
  return larger / smaller <= HEIGHT_CHANGE_RATIO;
}

function isListItem(line: TextLine): boolean {
  return BULLET_START.test(line.text) || ENUMERATOR_START.test(line.text);
}

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

/** "16. April" is an enumerator only where the paragraph it would interrupt is one. */
function startsListItem(head: TextLine, last: TextLine, line: TextLine): boolean {
  if (BULLET_START.test(line.text)) return !usesMarkerInsideLine(head, last, line);
  if (!ENUMERATOR_START.test(line.text)) return false;
  return line.x <= head.x + INDENT_TOLERANCE && ENUMERATOR_START.test(head.text);
}

function hangsUnderListItem(head: TextLine, line: TextLine): boolean {
  return isListItem(head) && line.x > head.x + INDENT_TOLERANCE;
}

/** The margin forced this break, but the sense ends here anyway: a new sentence or a list. */
function opensNewLineOfSense(last: TextLine, line: TextLine): boolean {
  if (SENTENCE_END.test(last.text) && UPPER_START.test(line.text)) return true;
  return LEAD_IN_END.test(last.text) && ENUMERATOR_START.test(line.text);
}

function isParagraphGap(last: TextLine, line: TextLine, context: ParagraphContext): boolean {
  const limit = Math.max(
    context.pitch * PARAGRAPH_PITCH_RATIO,
    Math.max(last.height, line.height) * PARAGRAPH_HEIGHT_RATIO,
  );
  return last.y - line.y > limit;
}

function continuesParagraph(
  head: TextLine,
  last: TextLine,
  line: TextLine,
  context: ParagraphContext,
): boolean {
  if (isParagraphGap(last, line, context) || !sizesMatch(last, line)) return false;
  if (!wasForcedByWidth(last, line, context)) return false;
  if (endsInAbbreviation(last.text)) return true;
  if (startsListItem(head, last, line)) return false;
  return hangsUnderListItem(head, line) || !opensNewLineOfSense(last, line);
}

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

function paragraphLines(rows: readonly LayoutRow[], facts: DocumentFacts): readonly OutLine[] {
  const lines = rows.map(textLineOf).filter((line) => line !== undefined);
  if (lines.length === 0) return [];
  const context = paragraphContext(lines, facts.bodyRight);
  const out: OutLine[] = [];
  let head: TextLine | undefined;
  let last: TextLine | undefined;
  for (const line of lines) {
    const open = out.at(-1);
    if (
      head !== undefined &&
      last !== undefined &&
      open !== undefined &&
      continuesParagraph(head, last, line, context)
    ) {
      out[out.length - 1] = { ...open, text: joinWrapped(open.text, line.text, facts.vocabulary) };
    } else {
      if (last !== undefined && isParagraphGap(last, line, context)) out.push(BLANK_LINE);
      out.push({
        text: line.text,
        height: line.height,
        font: isListItem(line) ? undefined : line.font,
      });
      head = line;
    }
    last = line;
  }
  return out;
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

function headingLevels(sizes: readonly number[]): ReadonlyMap<number, number> {
  const bucket = (size: number): number => Math.round(size * HEADING_SIZE_BUCKET);
  const ranked = [...new Set(sizes.map(bucket))].sort((a, b) => b - a);
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
    if (text.length > 0) text += pendingBlank ? "\n\n" : "\n";
    pendingBlank = false;
    if (isHeadingLine(lines, index, body)) candidates.push({ offset: text.length, line });
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
  return { page, flows: readingFlows(page.rows).map(flowBlocks) };
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
  const edges = plans.filter((plan) => plan.flows.length === 1).flatMap(proseRightEdge);
  const ordered = [...edges].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function composePageLines(plan: PagePlan, facts: DocumentFacts): readonly OutLine[] {
  const flowFacts = plan.flows.length === 1 ? facts : { ...facts, bodyRight: 0 };
  return [
    ...plan.flows.flatMap((blocks) => flowLines(blocks, flowFacts)),
    ...plan.page.offAxis.map((text) => ({ text })),
  ];
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
  const furniture = new Set([...knownFurniture, ...repeatedFurniture(pages)]);
  const cleaned = pages.map((page) => withoutFurniture(page, furniture));
  const plans = cleaned.map(planPage);
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
  const sizes = laidOut.flatMap((page) => page.candidates.map(({ line }) => line.height ?? 0));
  const levels = headingLevels(sizes);
  const count = (list: readonly PageLayout[]): number =>
    list.reduce((sum, page) => sum + page.rows.length + page.offAxis.length, 0);
  return {
    texts: laidOut.map((page) => page.text),
    headings: laidOut.map((page) =>
      page.candidates.map(({ offset, line }) => ({
        offset,
        title: line.text,
        level: levels.get(line.height ?? 0) ?? 1,
      })),
    ),
    removedRows: count(pages) - count(cleaned),
    furniture,
  };
}
