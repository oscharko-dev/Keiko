// PresentationML text-layer walk for the pptx parser. A state machine over the shared OOXML tokens
// collects shape paragraphs, table cells and references to embedded charts and diagrams in document
// order, together with each item's position on the slide so the caller can restore reading order.
// What the markup itself settles is decided here: the unused branch of `mc:AlternateContent` is
// skipped so a shape is not read twice, a vertically merged table cell repeats the value of the
// cell it continues, a paragraph keeps its bullet level, and the `show` flag of the slide is
// reported. Placement of chart and SmartArt text is left to the caller, who owns the package.

import { joinedLines } from "./block-text.js";
import { attributeOf, plainSpaces, scanXmlTokens, type XmlTag } from "./pptx-xml.js";

const SKIPPED_FIELD_TYPES: readonly string[] = ["slidenum", "datetime"];
const LEVEL_INDENT = "  ";
const MAX_LEVEL = 8;
const NO_SKIP = -1;

export interface SlidePosition {
  /** Offset of the shape's top-left corner from the slide origin, in EMU. */
  readonly x: number;
  readonly y: number;
}

export type EmbeddedFlavor = "chart" | "diagram";

export type PartItem =
  | {
      readonly kind: "shape";
      readonly placeholder: string | undefined;
      readonly paragraphs: readonly string[];
      readonly position: SlidePosition | undefined;
    }
  | {
      readonly kind: "table";
      readonly headerRow: boolean;
      readonly rows: readonly string[][];
      readonly position: SlidePosition | undefined;
    }
  | {
      readonly kind: "embedded";
      readonly flavor: EmbeddedFlavor;
      /** Relationship id of the chart or diagram data part, resolved by the caller. */
      readonly relationshipId: string;
      readonly position: SlidePosition | undefined;
    };

export interface PartWalkLimits {
  readonly maxDepth: number;
  /** Remaining paragraph + table-cell budget; the walk stops when it is exceeded. */
  readonly maxObjects: number;
}

export interface PartWalkResult {
  readonly items: readonly PartItem[];
  readonly objectCount: number;
  readonly limitReached: boolean;
  /** The slide carries `show="0"`. */
  readonly hidden: boolean;
}

interface ShapeAccumulator {
  placeholder: string | undefined;
  position: SlidePosition | undefined;
  readonly paragraphs: string[];
}

interface TableAccumulator {
  headerRow: boolean;
  readonly rows: string[][];
  /** Value of the last non-continuation cell per column, for vertically merged cells. */
  readonly carry: string[];
}

interface FrameAccumulator {
  position: SlidePosition | undefined;
  readonly embeds: { readonly flavor: EmbeddedFlavor; readonly relationshipId: string }[];
}

interface Point {
  x: number;
  y: number;
}

/** Child-space to parent-space mapping of one group shape (`a:xfrm` of `p:grpSpPr`). */
interface GroupTransform {
  off: Point;
  ext: Point;
  chOff: Point;
  chExt: Point;
}

interface WalkState {
  readonly items: PartItem[];
  shape: ShapeAccumulator | undefined;
  table: TableAccumulator | undefined;
  frame: FrameAccumulator | undefined;
  row: string[] | undefined;
  cell: string[] | undefined;
  cellContinues: boolean;
  runs: string[] | undefined;
  level: number | undefined;
  /** Character data of the open `a:t` element; undefined outside text or inside a skipped field. */
  text: string[] | undefined;
  readonly fieldSkip: boolean[];
  readonly groups: GroupTransform[];
  readonly alternates: boolean[];
  inTransform: boolean;
  inGroupProperties: boolean;
  hidden: boolean;
  depth: number;
  skipDepth: number;
  objectCount: number;
}

type TagHandler = (state: WalkState, tag: XmlTag) => void;

function skippingField(state: WalkState): boolean {
  return state.fieldSkip.some((skipped) => skipped);
}

function indentOf(level: number | undefined): string {
  return level === undefined || level <= 0 ? "" : LEVEL_INDENT.repeat(Math.min(level, MAX_LEVEL));
}

function finishParagraph(state: WalkState): void {
  const runs = state.runs;
  const level = state.level;
  state.runs = undefined;
  state.level = undefined;
  state.text = undefined;
  if (runs === undefined) return;
  state.objectCount += 1;
  const text = plainSpaces(runs.join("")).trim();
  if (text.length === 0) return;
  if (state.cell !== undefined) state.cell.push(text);
  else state.shape?.paragraphs.push(`${indentOf(level)}${text}`);
}

function openShape(state: WalkState): void {
  state.shape = { placeholder: undefined, position: undefined, paragraphs: [] };
}

function closeShape(state: WalkState): void {
  const shape = state.shape;
  state.shape = undefined;
  if (shape === undefined || shape.paragraphs.length === 0) return;
  state.items.push({
    kind: "shape",
    placeholder: shape.placeholder,
    paragraphs: shape.paragraphs,
    position: shape.position,
  });
}

function openTable(state: WalkState): void {
  state.table = { headerRow: false, rows: [], carry: [] };
}

function closeTable(state: WalkState): void {
  const table = state.table;
  state.table = undefined;
  if (table === undefined || table.rows.length === 0) return;
  state.items.push({
    kind: "table",
    headerRow: table.headerRow,
    rows: table.rows,
    position: state.frame?.position,
  });
}

function closeRow(state: WalkState): void {
  const row = state.row;
  state.row = undefined;
  if (row !== undefined) state.table?.rows.push(row);
}

function openCell(state: WalkState, tag: XmlTag): void {
  state.cell = [];
  state.cellContinues = isEnabledFlag(attributeOf(tag, "vMerge"));
}

function closeCell(state: WalkState): void {
  const cell = state.cell;
  state.cell = undefined;
  state.objectCount += 1;
  if (cell === undefined || state.row === undefined) return;
  // Every paragraph of a cell stays its own line, so a list in a cell stays a list.
  const own = joinedLines(cell.map((paragraph) => paragraph.replaceAll(/\s+/gu, " ")).join("\n"));
  const column = state.row.length;
  const carry = state.table?.carry;
  // A vertically merged cell continues the value above it; any other cell starts a new value.
  const text = state.cellContinues ? (carry?.[column] ?? own) : own;
  if (carry !== undefined && !state.cellContinues) carry[column] = own;
  state.row.push(text);
}

function openText(state: WalkState): void {
  if (state.runs !== undefined && !skippingField(state)) state.text = [];
}

function closeText(state: WalkState): void {
  const text = state.text;
  state.text = undefined;
  if (text === undefined || state.runs === undefined) return;
  state.runs.push(text.join(""));
}

function openField(state: WalkState, tag: XmlTag): void {
  const type = (attributeOf(tag, "type") ?? "").toLowerCase();
  state.fieldSkip.push(SKIPPED_FIELD_TYPES.some((prefix) => type.startsWith(prefix)));
}

function isEnabledFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function openParagraphProperties(state: WalkState, tag: XmlTag): void {
  if (state.runs === undefined || state.level !== undefined || state.fieldSkip.length > 0) return;
  const raw = attributeOf(tag, "lvl");
  state.level = raw !== undefined && /^\d{1,2}$/u.test(raw) ? Number(raw) : 0;
}

// ─── Position and groups ─────────────────────────────────────────────────────

function pointOf(tag: XmlTag, first: string, second: string): Point | undefined {
  const x = Number(attributeOf(tag, first));
  const y = Number(attributeOf(tag, second));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function scaleOf(group: GroupTransform, axis: "x" | "y"): number {
  return group.chExt[axis] > 0 ? group.ext[axis] / group.chExt[axis] : 1;
}

/** Maps a point from a shape's own coordinate space out through its enclosing groups. */
function toSlide(groups: readonly GroupTransform[], point: Point): SlidePosition {
  let { x, y } = point;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) continue;
    x = group.off.x + (x - group.chOff.x) * scaleOf(group, "x");
    y = group.off.y + (y - group.chOff.y) * scaleOf(group, "y");
  }
  return { x, y };
}

function openGroup(state: WalkState): void {
  state.groups.push({
    off: { x: 0, y: 0 },
    ext: { x: 0, y: 0 },
    chOff: { x: 0, y: 0 },
    chExt: { x: 0, y: 0 },
  });
}

function setGroupPoint(
  state: WalkState,
  key: keyof GroupTransform,
  point: Point | undefined,
): void {
  const group = state.groups.at(-1);
  if (group !== undefined && point !== undefined) group[key] = point;
}

function setOffset(state: WalkState, tag: XmlTag): void {
  const point = pointOf(tag, "x", "y");
  if (!state.inTransform || point === undefined) return;
  if (state.inGroupProperties) {
    setGroupPoint(state, "off", point);
    return;
  }
  const position = toSlide(state.groups, point);
  if (state.shape !== undefined) state.shape.position = position;
  else if (state.frame !== undefined) state.frame.position = position;
}

function groupPointHandler(key: keyof GroupTransform, first: string, second: string): TagHandler {
  return (state, tag) => {
    if (state.inTransform && state.inGroupProperties) {
      setGroupPoint(state, key, pointOf(tag, first, second));
    }
  };
}

// ─── Graphic frames: charts and diagrams ─────────────────────────────────────

function openFrame(state: WalkState): void {
  state.frame = { position: undefined, embeds: [] };
}

function closeFrame(state: WalkState): void {
  const frame = state.frame;
  state.frame = undefined;
  if (frame === undefined) return;
  for (const embed of frame.embeds) {
    state.items.push({ kind: "embedded", ...embed, position: frame.position });
  }
}

function embedHandler(flavor: EmbeddedFlavor, attribute: string): TagHandler {
  return (state, tag) => {
    const relationshipId = attributeOf(tag, attribute);
    if (state.frame !== undefined && relationshipId !== undefined) {
      state.frame.embeds.push({ flavor, relationshipId });
    }
  };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

const OPEN_HANDLERS: Readonly<Record<string, TagHandler>> = {
  sld: (state, tag) => {
    const show = attributeOf(tag, "show");
    state.hidden = show === "0" || show?.toLowerCase() === "false";
  },
  sp: openShape,
  ph: (state, tag) => {
    if (state.shape !== undefined) state.shape.placeholder = attributeOf(tag, "type") ?? "obj";
  },
  grpSp: openGroup,
  grpSpPr: (state) => {
    state.inGroupProperties = state.groups.length > 0;
  },
  xfrm: (state) => {
    state.inTransform = true;
  },
  off: setOffset,
  ext: groupPointHandler("ext", "cx", "cy"),
  chOff: groupPointHandler("chOff", "x", "y"),
  chExt: groupPointHandler("chExt", "cx", "cy"),
  graphicFrame: openFrame,
  chart: embedHandler("chart", "r:id"),
  relIds: embedHandler("diagram", "r:dm"),
  tbl: openTable,
  tblPr: (state, tag) => {
    if (state.table !== undefined)
      state.table.headerRow = isEnabledFlag(attributeOf(tag, "firstRow"));
  },
  tr: (state) => {
    state.row = [];
  },
  tc: openCell,
  p: (state) => {
    state.runs = [];
    state.level = undefined;
  },
  pPr: openParagraphProperties,
  t: openText,
  br: (state) => {
    state.runs?.push("\n");
  },
  fld: openField,
};

const CLOSE_HANDLERS: Readonly<Record<string, TagHandler>> = {
  sp: closeShape,
  grpSp: (state) => {
    state.groups.pop();
  },
  grpSpPr: (state) => {
    state.inGroupProperties = false;
  },
  xfrm: (state) => {
    state.inTransform = false;
  },
  graphicFrame: closeFrame,
  tbl: closeTable,
  tr: closeRow,
  tc: closeCell,
  p: finishParagraph,
  t: closeText,
  fld: (state) => {
    state.fieldSkip.pop();
  },
};

function handlerFor(
  table: Readonly<Record<string, TagHandler>>,
  local: string,
): TagHandler | undefined {
  return Object.hasOwn(table, local) ? table[local] : undefined;
}

/**
 * Whether the element's subtree is a second rendering of content that is read elsewhere: every
 * `mc:Choice` after the first, and the `mc:Fallback` of an `mc:AlternateContent`.
 */
function isAlternateRendering(state: WalkState, tag: XmlTag): boolean {
  if (tag.prefix !== "mc") return false;
  return tag.local === "Fallback" || (tag.local === "Choice" && state.alternates.at(-1) === true);
}

function applyAlternate(state: WalkState, tag: XmlTag): void {
  if (tag.prefix !== "mc") return;
  if (tag.local === "AlternateContent") {
    if (tag.closing) state.alternates.pop();
    else if (!tag.selfClosing) state.alternates.push(false);
  } else if (tag.local === "Choice" && !tag.closing && state.alternates.length > 0) {
    state.alternates[state.alternates.length - 1] = true;
  }
}

function applyOpen(state: WalkState, tag: XmlTag): void {
  handlerFor(OPEN_HANDLERS, tag.local)?.(state, tag);
  if (tag.selfClosing) handlerFor(CLOSE_HANDLERS, tag.local)?.(state, tag);
}

function applyTag(state: WalkState, tag: XmlTag): void {
  if (tag.closing) {
    state.depth -= 1;
    if (state.skipDepth === NO_SKIP) {
      applyAlternate(state, tag);
      handlerFor(CLOSE_HANDLERS, tag.local)?.(state, tag);
    } else if (state.depth === state.skipDepth) {
      state.skipDepth = NO_SKIP;
    }
    return;
  }
  if (state.skipDepth !== NO_SKIP) {
    if (!tag.selfClosing) state.depth += 1;
    return;
  }
  if (!tag.selfClosing && isAlternateRendering(state, tag)) {
    state.skipDepth = state.depth;
    state.depth += 1;
    return;
  }
  applyAlternate(state, tag);
  if (!tag.selfClosing) state.depth += 1;
  applyOpen(state, tag);
}

function initialState(): WalkState {
  return {
    items: [],
    shape: undefined,
    table: undefined,
    frame: undefined,
    row: undefined,
    cell: undefined,
    cellContinues: false,
    runs: undefined,
    level: undefined,
    text: undefined,
    fieldSkip: [],
    groups: [],
    alternates: [],
    inTransform: false,
    inGroupProperties: false,
    hidden: false,
    depth: 0,
    skipDepth: NO_SKIP,
    objectCount: 0,
  };
}

function resultOf(state: WalkState, limitReached: boolean): PartWalkResult {
  return {
    items: state.items,
    objectCount: state.objectCount,
    limitReached,
    hidden: state.hidden,
  };
}

/**
 * Collects shape paragraphs, table rows and chart or diagram references from one PresentationML
 * part (slide or notes slide) in document order. Malformed markup throws; exceeding `maxObjects`
 * ends the walk early and reports `limitReached` so the caller can disclose the truncation.
 */
export function walkPresentationPart(xml: string, limits: PartWalkLimits): PartWalkResult {
  const state = initialState();
  for (const token of scanXmlTokens(xml, limits.maxDepth)) {
    if (token.kind === "text") {
      if (state.skipDepth === NO_SKIP) state.text?.push(token.value);
    } else {
      applyTag(state, token);
    }
    if (state.objectCount > limits.maxObjects) return resultOf(state, true);
  }
  return resultOf(state, false);
}
