// PresentationML text-layer extraction for the pptx parser. A small XML-aware tokenizer (a linear
// scan with sticky, non-backtracking patterns; no regex over document bodies) feeds a state
// machine that collects shape paragraphs and table cells in document order. Comments are skipped
// whole, CDATA sections yield their literal character data, and attribute values are read quote
// aware. Entities are never expanded beyond the five predefined ones and numeric character
// references, and every construct the text layer does not need - a DOCTYPE or ENTITY declaration,
// a processing instruction other than the leading XML declaration, markup that does not parse -
// fails closed instead of being skipped.

import { decodeXmlEntities } from "./_internal.js";

const NAME_PATTERN = /[A-Za-z_][\w.-]*(?::[\w.-]+)?/uy;
const SPACE_PATTERN = /\s*/uy;
const ATTRIBUTE_PATTERN = /([^\s=/<>"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
const CLOSING_END_PATTERN = /\s*>/uy;
const XML_DECLARATION_PATTERN = /<\?xml\s[^>]*\?>/uy;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
const BYTE_ORDER_MARK = "﻿";
const SKIPPED_FIELD_TYPES: readonly string[] = ["slidenum", "datetime"];

export interface XmlTag {
  readonly kind: "tag";
  /** Element name without its namespace prefix. */
  readonly local: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Decoded attribute values keyed by their qualified name. */
  readonly attributes: ReadonlyMap<string, string>;
}

export interface XmlText {
  readonly kind: "text";
  /** Decoded character data, or the literal content of a CDATA section. */
  readonly value: string;
}

export type XmlToken = XmlTag | XmlText;

interface OpenElement {
  readonly qualified: string;
}

interface Markup {
  readonly token: XmlToken | undefined;
  readonly next: number;
}

interface TagTail {
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly next: number;
}

function malformed(): Error {
  return new Error("pptx xml is not well formed");
}

function localNameOf(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function matchAt(pattern: RegExp, xml: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(xml);
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
  if (stack.pop()?.qualified !== qualified) throw malformed();
}

interface AttributeRead {
  readonly name: string;
  readonly value: string;
  readonly next: number;
}

/** One `name="value"` pair that must follow whitespace; anything else is not well formed. */
function readAttribute(xml: string, at: number, separated: boolean): AttributeRead {
  const match = separated ? matchAt(ATTRIBUTE_PATTERN, xml, at) : null;
  const name = match?.[1];
  const value = match?.[2] ?? match?.[3];
  if (match === null || name === undefined || value === undefined) throw malformed();
  return { name, value: decodeXmlEntities(value), next: at + match[0].length };
}

/** Reads the attributes and the end of a start tag; a quoted `>` never ends the tag. */
function readStartTagTail(xml: string, from: number): TagTail {
  const attributes = new Map<string, string>();
  let cursor = from;
  for (;;) {
    const spaceEnd = cursor + (matchAt(SPACE_PATTERN, xml, cursor)?.[0].length ?? 0);
    if (xml[spaceEnd] === ">") return { attributes, selfClosing: false, next: spaceEnd + 1 };
    if (xml.startsWith("/>", spaceEnd)) {
      return { attributes, selfClosing: true, next: spaceEnd + 2 };
    }
    const attribute = readAttribute(xml, spaceEnd, spaceEnd > cursor);
    if (attributes.has(attribute.name)) throw new Error("pptx xml repeats an attribute");
    attributes.set(attribute.name, attribute.value);
    cursor = attribute.next;
  }
}

function readTagTail(xml: string, afterName: number, closing: boolean): TagTail {
  if (!closing) return readStartTagTail(xml, afterName);
  const end = matchAt(CLOSING_END_PATTERN, xml, afterName);
  if (end === null) throw malformed();
  return { attributes: new Map(), selfClosing: false, next: afterName + end[0].length };
}

function readElement(xml: string, open: number, stack: OpenElement[], maxDepth: number): Markup {
  const closing = xml[open + 1] === "/";
  const nameStart = open + (closing ? 2 : 1);
  const name = matchAt(NAME_PATTERN, xml, nameStart)?.[0];
  if (name === undefined) throw malformed();
  const tail = readTagTail(xml, nameStart + name.length, closing);
  const tag: XmlTag = {
    kind: "tag",
    local: localNameOf(name),
    closing,
    selfClosing: tail.selfClosing,
    attributes: tail.attributes,
  };
  trackNesting(stack, tag, name, maxDepth);
  return { token: tag, next: tail.next };
}

function closerOf(xml: string, open: number, opener: string, closer: string): number {
  const close = xml.indexOf(closer, open + opener.length);
  if (close === -1) throw new Error("pptx xml has an unterminated construct");
  return close;
}

function readMarkup(xml: string, open: number, stack: OpenElement[], maxDepth: number): Markup {
  if (xml.startsWith(COMMENT_OPEN, open)) {
    const close = closerOf(xml, open, COMMENT_OPEN, COMMENT_CLOSE);
    return { token: undefined, next: close + COMMENT_CLOSE.length };
  }
  if (xml.startsWith(CDATA_OPEN, open)) {
    const close = closerOf(xml, open, CDATA_OPEN, CDATA_CLOSE);
    const value = xml.slice(open + CDATA_OPEN.length, close);
    return { token: { kind: "text", value }, next: close + CDATA_CLOSE.length };
  }
  if (xml.startsWith("<!", open)) throw new Error("pptx xml declares a DOCTYPE or ENTITY");
  if (xml.startsWith("<?", open)) throw new Error("pptx xml carries a processing instruction");
  return readElement(xml, open, stack, maxDepth);
}

function declarationEnd(xml: string): number {
  const start = xml.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  const declaration = matchAt(XML_DECLARATION_PATTERN, xml, start);
  return declaration === null ? start : start + declaration[0].length;
}

/**
 * Yields element tags and character data in document order. Throws when the document declares a
 * DOCTYPE or ENTITY, carries a processing instruction other than the leading XML declaration,
 * contains markup that does not parse, nests deeper than `maxDepth`, or is not balanced (the
 * generator only reports a balanced document when it runs to completion).
 */
export function* scanXmlTokens(
  xml: string,
  maxDepth: number,
): Generator<XmlToken, void, undefined> {
  const stack: OpenElement[] = [];
  let cursor = declarationEnd(xml);
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const textEnd = open === -1 ? xml.length : open;
    if (textEnd > cursor) {
      yield { kind: "text", value: decodeXmlEntities(xml.slice(cursor, textEnd)) };
    }
    if (open === -1) break;
    const markup = readMarkup(xml, open, stack, maxDepth);
    if (markup.token !== undefined) yield markup.token;
    cursor = markup.next;
  }
  if (stack.length > 0) throw new Error("pptx xml has unterminated elements");
}

/** Yields only the element tags of `scanXmlTokens`. */
export function* scanXmlTags(xml: string, maxDepth: number): Generator<XmlTag, void, undefined> {
  for (const token of scanXmlTokens(xml, maxDepth)) {
    if (token.kind === "tag") yield token;
  }
}

export function attributeOf(tag: XmlTag, name: string): string | undefined {
  return tag.attributes.get(name);
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
  readonly items: PartItem[];
  shape: ShapeAccumulator | undefined;
  table: TableAccumulator | undefined;
  row: string[] | undefined;
  cell: string[] | undefined;
  runs: string[] | undefined;
  /** Character data of the open `a:t` element; undefined outside text or inside a skipped field. */
  text: string[] | undefined;
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
  state.text = undefined;
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

function initialState(): WalkState {
  return {
    items: [],
    shape: undefined,
    table: undefined,
    row: undefined,
    cell: undefined,
    runs: undefined,
    text: undefined,
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
  const state = initialState();
  for (const token of scanXmlTokens(xml, limits.maxDepth)) {
    if (token.kind === "text") state.text?.push(token.value);
    else applyTag(state, token);
    if (state.objectCount > limits.maxObjects) {
      return { items: state.items, objectCount: state.objectCount, limitReached: true };
    }
  }
  return { items: state.items, objectCount: state.objectCount, limitReached: false };
}
