// List numbering for the docx parser. `word/numbering.xml` maps each list instance (`w:num`) to an
// abstract definition whose levels say whether a marker is a bullet or a number, in which format,
// and how the marker text is composed (`%1.%2`). A paragraph names its list with `w:numPr`
// directly or through its style; the tracker below counts the paragraphs per list and level the
// way Word does, so "1.", "a)" or "2.3" are the numbers a reader sees rather than a bare dash.

import { resolveStyleNumbering, type StyleCatalog } from "./docx-styles.js";
import { attributeOf, scanXmlTags, type XmlTag } from "./pptx-xml.js";

export interface NumberingLevel {
  readonly start: number;
  readonly format: string;
  readonly text: string;
  /** Paragraph style that this level is linked to. */
  readonly styleId: string | undefined;
}

interface AbstractDefinition {
  readonly levels: Map<number, NumberingLevel>;
  numStyleLink: string | undefined;
}

interface NumInstance {
  abstractId: string;
  readonly startOverrides: Map<number, number>;
}

export interface NumberingCatalog {
  readonly abstracts: ReadonlyMap<string, AbstractDefinition>;
  readonly nums: ReadonlyMap<string, NumInstance>;
}

export interface ListMarker {
  readonly kind: "none" | "bullet" | "number";
  /** The number text (`2.1`, `a)`); empty for a bullet or no marker. */
  readonly text: string;
  /** Outline level of the item within its list (0 is the outermost). */
  readonly level: number;
}

const MAX_LEVELS = 9;
const MAX_LIST_NUMBER = 1_000_000;
const MAX_LINK_HOPS = 8;
const MAX_ROMAN = 3999;
const LETTER_COUNT = 26;

/** Marker of a list item that is shown as a bullet. */
export function bulletMarker(level: number): ListMarker {
  return { kind: "bullet", text: "", level };
}

function noMarker(level: number): ListMarker {
  return { kind: "none", text: "", level };
}

// ─── Reading numbering.xml ───────────────────────────────────────────────────

interface LevelBuild {
  readonly ilvl: number;
  start: number;
  format: string;
  text: string;
  styleId: string | undefined;
}

interface ParseContext {
  readonly abstracts: Map<string, AbstractDefinition>;
  readonly nums: Map<string, NumInstance>;
  abstractId: string | undefined;
  abstract: AbstractDefinition | undefined;
  numId: string | undefined;
  num: NumInstance | undefined;
  level: LevelBuild | undefined;
  overrideLevel: number | undefined;
}

function levelIndex(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,2}$/u.test(value)) return undefined;
  const index = Number(value);
  return index < MAX_LEVELS ? index : undefined;
}

function startValue(value: string | undefined): number {
  if (value === undefined || !/^-?\d{1,7}$/u.test(value)) return 1;
  return Math.max(0, Math.min(Number(value), MAX_LIST_NUMBER));
}

type ElementHandler = (context: ParseContext, tag: XmlTag, value: string | undefined) => void;

function openAbstract(context: ParseContext, tag: XmlTag): void {
  context.abstractId = attributeOf(tag, "w:abstractNumId");
  context.abstract = { levels: new Map(), numStyleLink: undefined };
}

function openNum(context: ParseContext, tag: XmlTag): void {
  context.numId = attributeOf(tag, "w:numId");
  context.num = { abstractId: "", startOverrides: new Map() };
}

function openLevel(context: ParseContext, tag: XmlTag): void {
  const ilvl = levelIndex(attributeOf(tag, "w:ilvl"));
  if (ilvl === undefined) return;
  context.level = { ilvl, start: 1, format: "decimal", text: "", styleId: undefined };
}

function openStartOverride(context: ParseContext, _tag: XmlTag, value: string | undefined): void {
  if (context.num === undefined || context.overrideLevel === undefined) return;
  context.num.startOverrides.set(context.overrideLevel, startValue(value));
}

const OPEN_HANDLERS: Readonly<Record<string, ElementHandler>> = {
  abstractNum: openAbstract,
  num: openNum,
  lvl: openLevel,
  lvlOverride: (context, tag) => {
    context.overrideLevel = levelIndex(attributeOf(tag, "w:ilvl"));
  },
  abstractNumId: (context, _tag, value) => {
    if (context.num !== undefined && value !== undefined) context.num.abstractId = value;
  },
  numStyleLink: (context, _tag, value) => {
    if (context.abstract !== undefined) context.abstract.numStyleLink = value;
  },
  startOverride: openStartOverride,
  start: (context, _tag, value) => {
    if (context.level !== undefined) context.level.start = startValue(value);
  },
  numFmt: (context, _tag, value) => {
    if (context.level !== undefined && value !== undefined) context.level.format = value;
  },
  lvlText: (context, _tag, value) => {
    if (context.level !== undefined) context.level.text = value ?? "";
  },
  pStyle: (context, _tag, value) => {
    if (context.level !== undefined) context.level.styleId = value;
  },
};

function closeLevel(context: ParseContext): void {
  const level = context.level;
  context.level = undefined;
  // A level inside a list instance only overrides; the definitions live in the abstract list.
  if (level === undefined || context.num !== undefined) return;
  context.abstract?.levels.set(level.ilvl, {
    start: level.start,
    format: level.format,
    text: level.text,
    styleId: level.styleId,
  });
}

function closeAbstract(context: ParseContext): void {
  if (context.abstractId !== undefined && context.abstract !== undefined) {
    context.abstracts.set(context.abstractId, context.abstract);
  }
  context.abstract = undefined;
  context.abstractId = undefined;
}

function closeNum(context: ParseContext): void {
  if (context.numId !== undefined && context.num !== undefined && context.num.abstractId !== "") {
    context.nums.set(context.numId, context.num);
  }
  context.num = undefined;
  context.numId = undefined;
}

const CLOSE_HANDLERS: Readonly<Record<string, (context: ParseContext) => void>> = {
  lvl: closeLevel,
  lvlOverride: (context) => {
    context.overrideLevel = undefined;
  },
  abstractNum: closeAbstract,
  num: closeNum,
};

function handlerOf<T>(table: Readonly<Record<string, T>>, local: string): T | undefined {
  return Object.hasOwn(table, local) ? table[local] : undefined;
}

/** Reads the abstract definitions and list instances of a `numbering.xml` part. */
export function parseNumberingCatalog(xml: string, maxDepth: number): NumberingCatalog {
  const context: ParseContext = {
    abstracts: new Map(),
    nums: new Map(),
    abstractId: undefined,
    abstract: undefined,
    numId: undefined,
    num: undefined,
    level: undefined,
    overrideLevel: undefined,
  };
  for (const tag of scanXmlTags(xml, maxDepth)) {
    if (tag.prefix !== "w") continue;
    if (!tag.closing)
      handlerOf(OPEN_HANDLERS, tag.local)?.(context, tag, attributeOf(tag, "w:val"));
    if (tag.closing || tag.selfClosing) handlerOf(CLOSE_HANDLERS, tag.local)?.(context);
  }
  return { abstracts: context.abstracts, nums: context.nums };
}

// ─── Number formats ──────────────────────────────────────────────────────────

const ROMAN_NUMERALS: readonly (readonly [number, string])[] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function roman(value: number): string {
  let rest = value;
  let out = "";
  for (const [size, glyph] of ROMAN_NUMERALS) {
    const count = Math.floor(rest / size);
    out += glyph.repeat(count);
    rest -= count * size;
  }
  return out;
}

function letters(value: number): string {
  let rest = value;
  let out = "";
  while (rest > 0) {
    const index = (rest - 1) % LETTER_COUNT;
    out = String.fromCodePoint(97 + index) + out;
    rest = Math.floor((rest - 1) / LETTER_COUNT);
  }
  return out;
}

function inRange(value: number, format: (value: number) => string): string {
  return value > 0 && value <= MAX_ROMAN ? format(value) : String(value);
}

const COUNTER_FORMATS: Readonly<Record<string, (value: number) => string>> = {
  lowerLetter: (value) => (value > 0 ? letters(value) : String(value)),
  upperLetter: (value) => (value > 0 ? letters(value).toUpperCase() : String(value)),
  lowerRoman: (value) => inRange(value, roman),
  upperRoman: (value) => inRange(value, (n) => roman(n).toUpperCase()),
  decimalZero: (value) => String(value).padStart(2, "0"),
};

function formatCounter(value: number, format: string): string {
  return handlerOf(COUNTER_FORMATS, format)?.(value) ?? String(value);
}

// ─── Counting paragraphs ─────────────────────────────────────────────────────

export interface NumberingTracker {
  /**
   * Advances the list the paragraph belongs to and returns the marker Word shows for it. A list
   * that cannot be resolved (no numbering part, unknown id) is a bullet, never a number.
   */
  mark(numId: string, ilvl: number | undefined, styleId: string | undefined): ListMarker;
}

interface ResolvedList {
  readonly abstractId: string;
  readonly abstract: AbstractDefinition;
}

function resolveList(
  catalog: NumberingCatalog,
  styles: StyleCatalog | undefined,
  numId: string,
): { readonly list: ResolvedList; readonly instance: NumInstance } | undefined {
  const instance = catalog.nums.get(numId);
  if (instance === undefined) return undefined;
  let abstractId = instance.abstractId;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    const abstract = catalog.abstracts.get(abstractId);
    if (abstract === undefined) return undefined;
    if (abstract.numStyleLink === undefined || abstract.levels.size > 0) {
      return { list: { abstractId, abstract }, instance };
    }
    const linked = resolveStyleNumbering(styles, abstract.numStyleLink);
    const next = linked === undefined ? undefined : catalog.nums.get(linked.numId);
    if (next === undefined) return undefined;
    abstractId = next.abstractId;
  }
  return undefined;
}

function levelLinkedTo(abstract: AbstractDefinition, styleId: string | undefined): number {
  if (styleId === undefined) return 0;
  for (const [index, level] of abstract.levels) {
    if (level.styleId === styleId) return index;
  }
  return 0;
}

function renderMarker(
  template: string,
  counters: readonly (number | undefined)[],
  abstract: AbstractDefinition,
  ilvl: number,
): string {
  const text = template.length > 0 ? template : `%${String(ilvl + 1)}.`;
  return text.replaceAll(/%([1-9])/gu, (_match, digit: string) => {
    const index = Number(digit) - 1;
    const definition = abstract.levels.get(index);
    const value = counters[index] ?? definition?.start ?? 1;
    return formatCounter(value, definition?.format ?? "decimal");
  });
}

/** Creates a tracker that counts list paragraphs in document order. */
export function createNumberingTracker(
  catalog: NumberingCatalog | undefined,
  styles: StyleCatalog | undefined,
): NumberingTracker {
  const counters = new Map<string, (number | undefined)[]>();
  const started = new Set<string>();

  function countersOf(list: ResolvedList): (number | undefined)[] {
    let current = counters.get(list.abstractId);
    if (current === undefined) {
      current = [];
      counters.set(list.abstractId, current);
    }
    return current;
  }

  function applyStartOverrides(numId: string, instance: NumInstance, list: ResolvedList): void {
    if (started.has(numId)) return;
    started.add(numId);
    const current = countersOf(list);
    for (const [level, start] of instance.startOverrides) {
      current[level] = start - 1;
      current.length = Math.min(current.length, level + 1);
    }
  }

  function advance(list: ResolvedList, ilvl: number, level: NumberingLevel): ListMarker {
    const current = countersOf(list);
    current[ilvl] = (current[ilvl] ?? level.start - 1) + 1;
    current.length = ilvl + 1;
    const text = renderMarker(level.text, current, list.abstract, ilvl).trim();
    return text.length === 0 ? noMarker(ilvl) : { kind: "number", text, level: ilvl };
  }

  return {
    mark(numId, ilvl, styleId): ListMarker {
      const resolved = catalog === undefined ? undefined : resolveList(catalog, styles, numId);
      if (resolved === undefined) return bulletMarker(ilvl ?? 0);
      applyStartOverrides(numId, resolved.instance, resolved.list);
      const index = ilvl ?? levelLinkedTo(resolved.list.abstract, styleId);
      const level = resolved.list.abstract.levels.get(index);
      if (level === undefined || level.format === "bullet") return bulletMarker(index);
      if (level.format === "none") return noMarker(index);
      return advance(resolved.list, index, level);
    },
  };
}
