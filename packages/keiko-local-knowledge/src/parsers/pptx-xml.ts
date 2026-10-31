// PresentationML text-layer extraction for the pptx parser. A single linear tag scan (no nested
// quantifiers, no backtracking over document bodies) feeds a small state machine that collects
// shape paragraphs and table cells in document order. Entities are never expanded beyond the
// shared character-reference decoder, and a DOCTYPE or ENTITY declaration fails closed.

import { decodeXmlEntities, readAttribute } from "./_internal.js";

const TAG_PATTERN = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)(\s[^>]*)?\/?>/gu;
const DECLARATION_PATTERN = /<!(?:DOCTYPE|ENTITY)/iu;
const SKIPPED_FIELD_TYPES: readonly string[] = ["slidenum", "datetime"];

export interface XmlTag {
  /** Element name without its namespace prefix. */
  readonly local: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

interface OpenElement {
  readonly qualified: string;
}

function localNameOf(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function trackNesting(
  stack: OpenElement[],
  tag: XmlTag,
  qualified: string,
  maxDepth: number,
): void {
  if (tag.selfClosing) return;
  if (!tag.closing) {
    if (stack.length >= maxDepth) throw new Error("pptx xml exceeds nesting limit");
    stack.push({ qualified });
    return;
  }
  if (stack.pop()?.qualified !== qualified) throw new Error("pptx xml is not well formed");
}

/**
 * Yields every element tag in document order. Throws when the document declares a DOCTYPE or
 * ENTITY, nests deeper than `maxDepth`, or is not balanced (the generator only reports a
 * balanced document when it runs to completion).
 */
export function* scanXmlTags(xml: string, maxDepth: number): Generator<XmlTag, void, undefined> {
  if (DECLARATION_PATTERN.test(xml)) throw new Error("pptx xml declares a DOCTYPE or ENTITY");
  const stack: OpenElement[] = [];
  for (const match of xml.matchAll(TAG_PATTERN)) {
    const raw = match[0];
    const qualified = match[2] ?? "";
    const tag: XmlTag = {
      local: localNameOf(qualified),
      closing: match[1] === "/",
      selfClosing: raw.endsWith("/>"),
      raw,
      start: match.index,
      end: match.index + raw.length,
    };
    trackNesting(stack, tag, qualified, maxDepth);
    yield tag;
  }
  if (stack.length > 0) throw new Error("pptx xml has unterminated elements");
}

export function attributeOf(tag: XmlTag, name: string): string | undefined {
  return readAttribute(tag.raw, name);
}

export type PartItem =
  | {
      readonly kind: "shape";
      readonly placeholder: string | undefined;
      readonly paragraphs: readonly string[];
    }
  | { readonly kind: "table"; readonly headerRow: boolean; readonly rows: readonly string[][] };

export interface PartWalkLimits {
  readonly maxDepth: number;
  /** Remaining paragraph + table-cell budget; the walk stops when it is exceeded. */
  readonly maxObjects: number;
}

export interface PartWalkResult {
  readonly items: readonly PartItem[];
  readonly objectCount: number;
  readonly limitReached: boolean;
}

interface ShapeAccumulator {
  placeholder: string | undefined;
  readonly paragraphs: string[];
}

interface TableAccumulator {
  headerRow: boolean;
  readonly rows: string[][];
}

interface WalkState {
  readonly xml: string;
  readonly items: PartItem[];
  shape: ShapeAccumulator | undefined;
  table: TableAccumulator | undefined;
  row: string[] | undefined;
  cell: string[] | undefined;
  runs: string[] | undefined;
  textFrom: number | undefined;
  readonly fieldSkip: boolean[];
  objectCount: number;
}

type TagHandler = (state: WalkState, tag: XmlTag) => void;

function skippingField(state: WalkState): boolean {
  return state.fieldSkip.some(Boolean);
}

function finishParagraph(state: WalkState): void {
  const runs = state.runs;
  state.runs = undefined;
  state.textFrom = undefined;
  if (runs === undefined) return;
  state.objectCount += 1;
  const text = runs.join("").trim();
  if (text.length === 0) return;
  if (state.cell !== undefined) state.cell.push(text);
  else state.shape?.paragraphs.push(text);
}

function openShape(state: WalkState): void {
  state.shape = { placeholder: undefined, paragraphs: [] };
}

function closeShape(state: WalkState): void {
  const shape = state.shape;
  state.shape = undefined;
  if (shape === undefined || shape.paragraphs.length === 0) return;
  state.items.push({
    kind: "shape",
    placeholder: shape.placeholder,
    paragraphs: shape.paragraphs,
  });
}

function closeTable(state: WalkState): void {
  const table = state.table;
  state.table = undefined;
  if (table === undefined || table.rows.length === 0) return;
  state.items.push({ kind: "table", headerRow: table.headerRow, rows: table.rows });
}

function closeRow(state: WalkState): void {
  const row = state.row;
  state.row = undefined;
  if (row !== undefined) state.table?.rows.push(row);
}

function closeCell(state: WalkState): void {
  const cell = state.cell;
  state.cell = undefined;
  state.objectCount += 1;
  if (cell !== undefined) state.row?.push(cell.join(" "));
}

function openText(state: WalkState, tag: XmlTag): void {
  if (state.runs !== undefined && !skippingField(state)) state.textFrom = tag.end;
}

function closeText(state: WalkState, tag: XmlTag): void {
  const from = state.textFrom;
  state.textFrom = undefined;
  if (from === undefined || state.runs === undefined) return;
  state.runs.push(decodeXmlEntities(state.xml.slice(from, tag.start)));
}

function openField(state: WalkState, tag: XmlTag): void {
  const type = (attributeOf(tag, "type") ?? "").toLowerCase();
  state.fieldSkip.push(SKIPPED_FIELD_TYPES.some((prefix) => type.startsWith(prefix)));
}

function isEnabledFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

const OPEN_HANDLERS: Readonly<Record<string, TagHandler>> = {
  sp: openShape,
  ph: (state, tag) => {
    if (state.shape !== undefined) state.shape.placeholder = attributeOf(tag, "type") ?? "obj";
  },
  tbl: (state) => {
    state.table = { headerRow: false, rows: [] };
  },
  tblPr: (state, tag) => {
    if (state.table !== undefined)
      state.table.headerRow = isEnabledFlag(attributeOf(tag, "firstRow"));
  },
  tr: (state) => {
    state.row = [];
  },
  tc: (state) => {
    state.cell = [];
  },
  p: (state) => {
    state.runs = [];
  },
  t: openText,
  br: (state) => {
    state.runs?.push("\n");
  },
  fld: openField,
};

const CLOSE_HANDLERS: Readonly<Record<string, TagHandler>> = {
  sp: closeShape,
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

function applyTag(state: WalkState, tag: XmlTag): void {
  if (!tag.closing) handlerFor(OPEN_HANDLERS, tag.local)?.(state, tag);
  if (tag.closing || tag.selfClosing) handlerFor(CLOSE_HANDLERS, tag.local)?.(state, tag);
}

function initialState(xml: string): WalkState {
  return {
    xml,
    items: [],
    shape: undefined,
    table: undefined,
    row: undefined,
    cell: undefined,
    runs: undefined,
    textFrom: undefined,
    fieldSkip: [],
    objectCount: 0,
  };
}

/**
 * Collects shape paragraphs and table rows from one PresentationML part (slide or notes slide)
 * in document order. Malformed markup throws; exceeding `maxObjects` ends the walk early and
 * reports `limitReached` so the caller can disclose the truncation.
 */
export function walkPresentationPart(xml: string, limits: PartWalkLimits): PartWalkResult {
  const state = initialState(xml);
  for (const tag of scanXmlTags(xml, limits.maxDepth)) {
    applyTag(state, tag);
    if (state.objectCount > limits.maxObjects) {
      return { items: state.items, objectCount: state.objectCount, limitReached: true };
    }
  }
  return { items: state.items, objectCount: state.objectCount, limitReached: false };
}
