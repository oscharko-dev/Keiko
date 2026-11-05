// Paragraph style catalog for the docx parser. `word/styles.xml` says which paragraphs are
// headings, whatever the document calls its styles: Word stores a built-in style under a
// localized style id (`berschrift1`) but under its English style name (`heading 1`), a custom
// style reaches a heading through `w:basedOn`, and `w:outlineLvl` on the style or on the
// paragraph itself marks any paragraph as an outline level. The same catalog carries the list
// numbering a style applies (`w:numPr` in the style), which a paragraph inherits.

import { attributeOf, scanXmlTags, type XmlTag } from "./pptx-xml.js";

export interface StyleInfo {
  readonly name: string | undefined;
  readonly basedOn: string | undefined;
  /** 0-based outline level of the style; 9 means body text. */
  readonly outlineLvl: number | undefined;
  readonly numId: string | undefined;
  readonly ilvl: number | undefined;
}

export type StyleCatalog = ReadonlyMap<string, StyleInfo>;

/** Level 0 is the document title; headings 1 to 9 follow. */
export const TITLE_LEVEL = 0;
const MAX_HEADING_LEVEL = 9;
const BODY_TEXT_OUTLINE_LEVEL = 9;
const MAX_STYLE_CHAIN = 32;
const HEADING_NAME_PATTERN = /^heading\s*([1-9])$/iu;
const TITLE_NAME_PATTERN = /^title$/iu;

interface MutableStyle {
  name: string | undefined;
  basedOn: string | undefined;
  outlineLvl: number | undefined;
  numId: string | undefined;
  ilvl: number | undefined;
}

function outlineLevelOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,3}$/u.test(value)) return undefined;
  return Number(value);
}

interface StyleParse {
  readonly catalog: Map<string, StyleInfo>;
  current: MutableStyle | undefined;
  currentId: string | undefined;
  inNumPr: boolean;
}

function openStyle(parse: StyleParse, tag: XmlTag): void {
  const type = attributeOf(tag, "w:type");
  const wanted = type === undefined || type === "paragraph" || type === "numbering";
  parse.currentId = wanted ? attributeOf(tag, "w:styleId") : undefined;
  parse.inNumPr = false;
  parse.current = {
    name: undefined,
    basedOn: undefined,
    outlineLvl: undefined,
    numId: undefined,
    ilvl: undefined,
  };
}

function closeStyle(parse: StyleParse): void {
  if (parse.current !== undefined && parse.currentId !== undefined) {
    parse.catalog.set(parse.currentId, parse.current);
  }
  parse.current = undefined;
  parse.currentId = undefined;
  parse.inNumPr = false;
}

function readStyleChild(parse: StyleParse, tag: XmlTag): void {
  if (parse.current === undefined) return;
  if (tag.local === "numPr") {
    parse.inNumPr = !tag.closing && !tag.selfClosing;
    return;
  }
  if (tag.closing) return;
  const value = attributeOf(tag, "w:val");
  if (tag.local === "name") parse.current.name = value;
  else if (tag.local === "basedOn") parse.current.basedOn = value;
  else if (tag.local === "outlineLvl") parse.current.outlineLvl = outlineLevelOf(value);
  else if (parse.inNumPr) readNumberingChild(parse.current, tag.local, value);
}

function readNumberingChild(style: MutableStyle, local: string, value: string | undefined): void {
  if (local === "numId") style.numId = value;
  else if (local === "ilvl") style.ilvl = outlineLevelOf(value);
}

/** Reads the paragraph and numbering styles of a `styles.xml` part. */
export function parseStyleCatalog(xml: string, maxDepth: number): StyleCatalog {
  const parse: StyleParse = {
    catalog: new Map(),
    current: undefined,
    currentId: undefined,
    inNumPr: false,
  };
  for (const tag of scanXmlTags(xml, maxDepth)) {
    if (tag.prefix !== "w") continue;
    if (tag.local !== "style") {
      readStyleChild(parse, tag);
    } else if (tag.closing) {
      closeStyle(parse);
    } else if (!tag.selfClosing) {
      openStyle(parse, tag);
    }
  }
  return parse.catalog;
}

/** Heading level a style name or id stands for: `Title`, `heading 3` and `Heading3` alike. */
function builtInLevelOf(label: string | undefined): number | undefined {
  if (label === undefined) return undefined;
  const heading = HEADING_NAME_PATTERN.exec(label)?.[1];
  if (heading !== undefined) return Number(heading);
  return TITLE_NAME_PATTERN.test(label) ? TITLE_LEVEL : undefined;
}

function levelOfOutline(outline: number): number | undefined {
  return outline >= BODY_TEXT_OUTLINE_LEVEL ? undefined : Math.min(outline + 1, MAX_HEADING_LEVEL);
}

/** The style and the styles it is based on, nearest first; ends on a cycle or a long chain. */
function* styleChain(
  catalog: StyleCatalog | undefined,
  styleId: string | undefined,
): Generator<readonly [string, StyleInfo | undefined], void, undefined> {
  const visited = new Set<string>();
  let id = styleId;
  while (id !== undefined && !visited.has(id) && visited.size < MAX_STYLE_CHAIN) {
    visited.add(id);
    const style: StyleInfo | undefined = catalog?.get(id);
    yield [id, style];
    id = style?.basedOn;
  }
}

/** What one style on the chain says about heading level; undefined when it says nothing. */
function verdictOf(
  id: string,
  style: StyleInfo | undefined,
): { level: number | undefined } | undefined {
  if (style?.outlineLvl !== undefined) return { level: levelOfOutline(style.outlineLvl) };
  const named = builtInLevelOf(style?.name) ?? builtInLevelOf(id);
  return named === undefined ? undefined : { level: named };
}

/**
 * Heading level of a paragraph: its own `w:outlineLvl`, else the nearest style on its `basedOn`
 * chain that carries an outline level or a built-in heading or title name. Without a catalog (no
 * `styles.xml`) only the style id itself is consulted. Undefined for body text.
 */
export function resolveHeadingLevel(
  catalog: StyleCatalog | undefined,
  styleId: string | undefined,
  directOutline: number | undefined,
): number | undefined {
  if (directOutline !== undefined) return levelOfOutline(directOutline);
  for (const [id, style] of styleChain(catalog, styleId)) {
    const verdict = verdictOf(id, style);
    if (verdict !== undefined) return verdict.level;
  }
  return undefined;
}

export interface StyleNumbering {
  readonly numId: string;
  readonly ilvl: number | undefined;
}

/** Nearest numbering a style (or a style it is based on) applies; undefined when none. */
export function resolveStyleNumbering(
  catalog: StyleCatalog | undefined,
  styleId: string | undefined,
): StyleNumbering | undefined {
  for (const [, style] of styleChain(catalog, styleId)) {
    if (style?.numId !== undefined) return { numId: style.numId, ilvl: style.ilvl };
  }
  return undefined;
}

/** Style name (`List Bullet`) of a style id, for the fallbacks that work without numbering data. */
export function styleLabel(catalog: StyleCatalog | undefined, styleId: string): string {
  return catalog?.get(styleId)?.name ?? styleId;
}
