// WordprocessingML structure reader for the docx parser. One linear pass over the XML tokens of a
// part (document, footnotes or endnotes) in document order builds a plain block model - paragraphs
// with their style and numbering references, and tables with their cells - so that every later
// decision (headings, list numbers, table headers) works on what Word actually stored instead of
// on regular expressions over markup. The reader decides only what the markup itself settles:
//   - which text is visible: runs hidden with `w:vanish`, tracked deletions and moved-away text,
//     the unused branch of `mc:AlternateContent`, tracked formatting history and content-control
//     placeholders are excluded, and the exclusions are counted;
//   - which characters a run element stands for: tabs, line breaks, non-breaking hyphens and
//     symbols are read in run order rather than discarded;
//   - where text boxes and notes belong: box paragraphs become their own blocks right after their
//     anchor paragraph, and note references are recorded for the caller to place the note text.
// Styles and numbering definitions live in other parts and are resolved by the caller.

import { attributeOf, scanXmlTags, scanXmlTokens, type XmlTag } from "./pptx-xml.js";

export interface NoteRef {
  readonly kind: "footnote" | "endnote";
  readonly id: string;
}

export interface RawParagraph {
  /** Visible text with tabs and line breaks in place; untrimmed. */
  readonly text: string;
  readonly styleId: string | undefined;
  /** Direct `w:numPr` of the paragraph; `numId` "0" means the paragraph is explicitly not a list. */
  readonly numId: string | undefined;
  /** The paragraph carries a `w:numPr` element, whether or not it names a list. */
  readonly hasNumPr: boolean;
  readonly ilvl: number | undefined;
  /** Direct `w:outlineLvl` (0-based; 9 is body text). */
  readonly outlineLvl: number | undefined;
  /** True when every visible text run of the paragraph is bold. */
  readonly allBold: boolean;
  readonly noteRefs: readonly NoteRef[];
}

export type RawBlock =
  | { readonly kind: "p"; readonly paragraph: RawParagraph }
  | { readonly kind: "tbl"; readonly table: RawTable };

export interface RawTable {
  readonly rows: readonly RawRow[];
}

export interface RawRow {
  readonly cells: readonly RawCell[];
  /** `w:tblHeader` is set on the row. */
  readonly headerMarked: boolean;
  /** Grid columns skipped before the first cell. */
  readonly gridBefore: number;
}

export interface RawCell {
  readonly span: number;
  readonly vMerge: "restart" | "continue" | undefined;
  readonly blocks: readonly RawBlock[];
}

export interface WordPartLimits {
  readonly maxDepth: number;
  /** Paragraph + cell budget; the read stops when it is exceeded. */
  readonly maxObjects: number;
  /** Polled every few hundred objects; returning true ends the read with `interrupted`. */
  readonly interrupt?: () => boolean;
}

export interface WordPartRead {
  /** Top-level blocks of the part (the document body). */
  readonly blocks: readonly RawBlock[];
  /** Note bodies keyed `footnote:<id>` / `endnote:<id>`; separators are never listed. */
  readonly notes: ReadonlyMap<string, readonly RawBlock[]>;
  /** Hidden text elements that carried text and were excluded. */
  readonly hiddenCount: number;
  /** Content-control placeholders that were excluded. */
  readonly placeholderCount: number;
  readonly limitReached: boolean;
  readonly interrupted: boolean;
}

// ─── Walk state ──────────────────────────────────────────────────────────────

interface ParagraphFrame {
  readonly kind: "p";
  readonly parts: string[];
  readonly noteRefs: NoteRef[];
  /** Blocks born inside the paragraph (text boxes); emitted right after it. */
  readonly deferred: RawBlock[];
  styleId: string | undefined;
  numId: string | undefined;
  hasNumPr: boolean;
  ilvl: number | undefined;
  outlineLvl: number | undefined;
  textTokens: number;
  boldTokens: number;
  inPPr: boolean;
  inNumPr: boolean;
  inRPr: boolean;
  inRun: boolean;
  inText: boolean;
  hidden: boolean;
  bold: boolean;
  hiddenText: boolean;
}

interface ContainerFrame {
  readonly kind: "container";
  readonly role: "body" | "cell" | "txbx" | "note";
  readonly blocks: RawBlock[];
  span: number;
  vMerge: "restart" | "continue" | undefined;
  noteKey: string | undefined;
}

interface TableFrame {
  readonly kind: "tbl";
  readonly rows: RawRow[];
}

interface RowFrame {
  readonly kind: "row";
  readonly cells: RawCell[];
  headerMarked: boolean;
  gridBefore: number;
  deleted: boolean;
  inTrPr: boolean;
}

type Frame = ParagraphFrame | ContainerFrame | TableFrame | RowFrame;

interface WalkState {
  readonly frames: Frame[];
  /** Choice branch already taken, one entry per open `mc:AlternateContent`. */
  readonly alternates: boolean[];
  /** Placeholder flag, one entry per open `w:sdt`. */
  readonly sdts: boolean[];
  readonly notes: Map<string, RawBlock[]>;
  depth: number;
  skipDepth: number;
  hiddenCount: number;
  placeholderCount: number;
  objectCount: number;
}

type TagHandler = (state: WalkState, tag: XmlTag) => void;

const NO_SKIP = -1;
const SPECIAL_NOTE_TYPES: ReadonlySet<string> = new Set([
  "separator",
  "continuationSeparator",
  "continuationNotice",
]);
const INTERRUPT_POLL_MASK = 0xff;

function newParagraph(): ParagraphFrame {
  return {
    kind: "p",
    parts: [],
    noteRefs: [],
    deferred: [],
    styleId: undefined,
    numId: undefined,
    hasNumPr: false,
    ilvl: undefined,
    outlineLvl: undefined,
    textTokens: 0,
    boldTokens: 0,
    inPPr: false,
    inNumPr: false,
    inRPr: false,
    inRun: false,
    inText: false,
    hidden: false,
    bold: false,
    hiddenText: false,
  };
}

function newContainer(role: ContainerFrame["role"], noteKey?: string): ContainerFrame {
  return { kind: "container", role, blocks: [], span: 1, vMerge: undefined, noteKey };
}

function topFrame(state: WalkState): Frame | undefined {
  return state.frames.at(-1);
}

function topParagraph(state: WalkState): ParagraphFrame | undefined {
  const top = topFrame(state);
  return top?.kind === "p" ? top : undefined;
}

function topRow(state: WalkState): RowFrame | undefined {
  const top = topFrame(state);
  return top?.kind === "row" ? top : undefined;
}

function topCell(state: WalkState): ContainerFrame | undefined {
  const top = topFrame(state);
  return top?.kind === "container" && top.role === "cell" ? top : undefined;
}

/** The list that receives a finished block: the nearest container, or a paragraph's deferred blocks. */
function sinkOf(state: WalkState): RawBlock[] {
  for (let index = state.frames.length - 1; index >= 0; index -= 1) {
    const frame = state.frames[index];
    if (frame?.kind === "container") return frame.blocks;
    if (frame?.kind === "p") return frame.deferred;
  }
  throw new Error("ooxml xml has no container for a block");
}

function isOn(value: string | undefined): boolean {
  if (value === undefined) return true;
  const lowered = value.toLowerCase();
  return lowered !== "0" && lowered !== "false" && lowered !== "off";
}

function integerAttribute(tag: XmlTag, name: string): number | undefined {
  const raw = attributeOf(tag, name);
  if (raw === undefined || !/^-?\d{1,6}$/u.test(raw)) return undefined;
  return Number(raw);
}

// ─── Run content ─────────────────────────────────────────────────────────────

/** Paragraph that currently accepts visible run content; undefined when hidden or outside a run. */
function visibleRun(state: WalkState): ParagraphFrame | undefined {
  const paragraph = topParagraph(state);
  return paragraph !== undefined && paragraph.inRun && !paragraph.hidden ? paragraph : undefined;
}

function appendRunText(state: WalkState, text: string): void {
  const paragraph = visibleRun(state);
  if (paragraph !== undefined) paragraph.parts.push(text);
}

// Private-use code points that Symbol/Wingdings runs use for common bullet-like glyphs.
const SYMBOL_GLYPHS: ReadonlyMap<number, string> = new Map([
  [0xb7, "•"],
  [0xa7, "▪"],
  [0xfc, "✓"],
  [0xd8, "➢"],
  [0x76, "❖"],
  [0x6e, "■"],
  [0x71, "❑"],
]);

function symbolText(tag: XmlTag): string {
  const raw = attributeOf(tag, "w:char");
  if (raw === undefined || !/^[0-9a-fA-F]{1,6}$/u.test(raw)) return "";
  const codePoint = Number.parseInt(raw, 16);
  if (codePoint >= 0xf000 && codePoint <= 0xf0ff)
    return SYMBOL_GLYPHS.get(codePoint - 0xf000) ?? "";
  if (codePoint < 0x20 || codePoint > 0x10ffff) return "";
  return String.fromCodePoint(codePoint);
}

function openText(state: WalkState): void {
  const paragraph = topParagraph(state);
  if (paragraph !== undefined) paragraph.inText = true;
}

function closeText(state: WalkState): void {
  const paragraph = topParagraph(state);
  if (paragraph === undefined) return;
  paragraph.inText = false;
  if (!paragraph.hiddenText) return;
  paragraph.hiddenText = false;
  state.hiddenCount += 1;
}

function addText(state: WalkState, value: string): void {
  const paragraph = topParagraph(state);
  if (paragraph?.inText !== true) return;
  const blank = value.trim().length === 0;
  if (paragraph.hidden) {
    if (!blank) paragraph.hiddenText = true;
    return;
  }
  paragraph.parts.push(value);
  if (blank) return;
  paragraph.textTokens += 1;
  if (paragraph.bold) paragraph.boldTokens += 1;
}

// ─── Paragraph and run properties ────────────────────────────────────────────

function setParagraphProperty(state: WalkState, update: (p: ParagraphFrame) => void): void {
  const paragraph = topParagraph(state);
  if (paragraph?.inPPr === true) update(paragraph);
}

function openRun(state: WalkState): void {
  const paragraph = topParagraph(state);
  if (paragraph === undefined) return;
  paragraph.inRun = true;
  paragraph.hidden = false;
  paragraph.bold = false;
}

function closeRun(state: WalkState): void {
  const paragraph = topParagraph(state);
  if (paragraph === undefined) return;
  paragraph.inRun = false;
  paragraph.hidden = false;
  paragraph.bold = false;
}

function setRunProperty(state: WalkState, tag: XmlTag, update: (p: ParagraphFrame) => void): void {
  const paragraph = topParagraph(state);
  if (
    paragraph?.inRPr === true &&
    paragraph.inRun &&
    !paragraph.inPPr &&
    isOn(attributeOf(tag, "w:val"))
  ) {
    update(paragraph);
  }
}

// ─── Blocks: paragraphs, tables, containers ──────────────────────────────────

function openParagraph(state: WalkState): void {
  state.frames.push(newParagraph());
}

function closeParagraph(state: WalkState): void {
  const frame = state.frames.pop();
  if (frame?.kind !== "p") return;
  state.objectCount += 1;
  const paragraph: RawParagraph = {
    text: frame.parts.join(""),
    styleId: frame.styleId,
    numId: frame.numId,
    hasNumPr: frame.hasNumPr,
    ilvl: frame.ilvl,
    outlineLvl: frame.outlineLvl,
    allBold: frame.textTokens > 0 && frame.boldTokens === frame.textTokens,
    noteRefs: frame.noteRefs,
  };
  const sink = sinkOf(state);
  sink.push({ kind: "p", paragraph }, ...frame.deferred);
}

function openTable(state: WalkState): void {
  state.frames.push({ kind: "tbl", rows: [] });
}

function closeTable(state: WalkState): void {
  const frame = state.frames.pop();
  if (frame?.kind !== "tbl") return;
  sinkOf(state).push({ kind: "tbl", table: { rows: frame.rows } });
}

function openRow(state: WalkState): void {
  state.frames.push({
    kind: "row",
    cells: [],
    headerMarked: false,
    gridBefore: 0,
    deleted: false,
    inTrPr: false,
  });
}

function closeRow(state: WalkState): void {
  const frame = state.frames.pop();
  const table = topFrame(state);
  if (frame?.kind !== "row" || table?.kind !== "tbl" || frame.deleted) return;
  table.rows.push({
    cells: frame.cells,
    headerMarked: frame.headerMarked,
    gridBefore: frame.gridBefore,
  });
}

function openCell(state: WalkState): void {
  state.frames.push(newContainer("cell"));
}

function closeCell(state: WalkState): void {
  const frame = state.frames.pop();
  const row = topFrame(state);
  state.objectCount += 1;
  if (frame?.kind !== "container" || row?.kind !== "row") return;
  row.cells.push({ span: frame.span, vMerge: frame.vMerge, blocks: frame.blocks });
}

function openTextBox(state: WalkState): void {
  state.frames.push(newContainer("txbx"));
}

function closeTextBox(state: WalkState): void {
  const frame = state.frames.pop();
  if (frame?.kind === "container") sinkOf(state).push(...frame.blocks);
}

function openNote(state: WalkState, tag: XmlTag): void {
  const kind = tag.local === "footnote" ? "footnote" : "endnote";
  const id = attributeOf(tag, "w:id");
  const type = attributeOf(tag, "w:type");
  const special = (type !== undefined && SPECIAL_NOTE_TYPES.has(type)) || id === undefined;
  state.frames.push(newContainer("note", special ? undefined : `${kind}:${id}`));
}

function closeNote(state: WalkState): void {
  const frame = state.frames.pop();
  if (frame?.kind !== "container" || frame.noteKey === undefined) return;
  state.notes.set(frame.noteKey, frame.blocks);
}

function addNoteRef(state: WalkState, tag: XmlTag): void {
  const paragraph = visibleRun(state);
  const id = attributeOf(tag, "w:id");
  if (paragraph === undefined || id === undefined) return;
  const kind = tag.local === "footnoteReference" ? "footnote" : "endnote";
  paragraph.noteRefs.push({ kind, id });
}

// ─── Table properties ────────────────────────────────────────────────────────

function openRowProperties(state: WalkState): void {
  const row = topRow(state);
  if (row !== undefined) row.inTrPr = true;
}

function closeRowProperties(state: WalkState): void {
  const row = topRow(state);
  if (row !== undefined) row.inTrPr = false;
}

function markHeaderRow(state: WalkState, tag: XmlTag): void {
  const row = topRow(state);
  if (row?.inTrPr === true && isOn(attributeOf(tag, "w:val"))) row.headerMarked = true;
}

function setGridBefore(state: WalkState, tag: XmlTag): void {
  const row = topRow(state);
  const value = integerAttribute(tag, "w:val");
  if (row?.inTrPr === true && value !== undefined && value > 0) row.gridBefore = value;
}

function markDeletedRow(state: WalkState): void {
  const row = topRow(state);
  if (row?.inTrPr === true) row.deleted = true;
}

function setGridSpan(state: WalkState, tag: XmlTag): void {
  const cell = topCell(state);
  const value = integerAttribute(tag, "w:val");
  if (cell !== undefined && value !== undefined && value > 1) cell.span = value;
}

function setVerticalMerge(state: WalkState, tag: XmlTag): void {
  const cell = topCell(state);
  if (cell === undefined) return;
  cell.vMerge = attributeOf(tag, "w:val") === "restart" ? "restart" : "continue";
}

// ─── Alternate content and content controls ──────────────────────────────────

function openAlternate(state: WalkState): void {
  state.alternates.push(false);
}

function closeAlternate(state: WalkState): void {
  state.alternates.pop();
}

function takeChoice(state: WalkState): void {
  if (state.alternates.length > 0) state.alternates[state.alternates.length - 1] = true;
}

function openControl(state: WalkState): void {
  state.sdts.push(false);
}

function closeControl(state: WalkState): void {
  state.sdts.pop();
}

function markPlaceholder(state: WalkState, tag: XmlTag): void {
  if (state.sdts.length > 0 && isOn(attributeOf(tag, "w:val"))) {
    state.sdts[state.sdts.length - 1] = true;
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

const OPEN_HANDLERS: Readonly<Record<string, TagHandler>> = {
  "w:p": openParagraph,
  "w:pPr": (state) => {
    const paragraph = topParagraph(state);
    if (paragraph !== undefined) paragraph.inPPr = true;
  },
  "w:pStyle": (state, tag) => {
    setParagraphProperty(state, (p) => {
      p.styleId = attributeOf(tag, "w:val");
    });
  },
  "w:outlineLvl": (state, tag) => {
    setParagraphProperty(state, (p) => {
      p.outlineLvl = integerAttribute(tag, "w:val");
    });
  },
  "w:numPr": (state) => {
    setParagraphProperty(state, (p) => {
      p.inNumPr = true;
      p.hasNumPr = true;
    });
  },
  "w:numId": (state, tag) => {
    const paragraph = topParagraph(state);
    if (paragraph?.inNumPr === true) paragraph.numId = attributeOf(tag, "w:val");
  },
  "w:ilvl": (state, tag) => {
    const paragraph = topParagraph(state);
    if (paragraph?.inNumPr === true) paragraph.ilvl = integerAttribute(tag, "w:val");
  },
  "w:r": openRun,
  "w:rPr": (state) => {
    const paragraph = topParagraph(state);
    if (paragraph !== undefined) paragraph.inRPr = true;
  },
  "w:vanish": (state, tag) => {
    setRunProperty(state, tag, (p) => {
      p.hidden = true;
    });
  },
  "w:specVanish": (state, tag) => {
    setRunProperty(state, tag, (p) => {
      p.hidden = true;
    });
  },
  "w:b": (state, tag) => {
    setRunProperty(state, tag, (p) => {
      p.bold = true;
    });
  },
  "w:t": openText,
  "m:t": openText,
  "w:tab": (state) => {
    appendRunText(state, "\t");
  },
  "w:ptab": (state) => {
    appendRunText(state, "\t");
  },
  "w:br": (state) => {
    appendRunText(state, "\n");
  },
  "w:cr": (state) => {
    appendRunText(state, "\n");
  },
  "w:noBreakHyphen": (state) => {
    appendRunText(state, "-");
  },
  "w:sym": (state, tag) => {
    appendRunText(state, symbolText(tag));
  },
  "w:footnoteReference": addNoteRef,
  "w:endnoteReference": addNoteRef,
  "w:tbl": openTable,
  "w:tr": openRow,
  "w:trPr": openRowProperties,
  "w:tblHeader": markHeaderRow,
  "w:gridBefore": setGridBefore,
  "w:del": markDeletedRow,
  "w:tc": openCell,
  "w:gridSpan": setGridSpan,
  "w:vMerge": setVerticalMerge,
  "w:txbxContent": openTextBox,
  "w:footnote": openNote,
  "w:endnote": openNote,
  "w:sdt": openControl,
  "w:showingPlcHdr": markPlaceholder,
  "mc:AlternateContent": openAlternate,
  "mc:Choice": takeChoice,
};

const CLOSE_HANDLERS: Readonly<Record<string, TagHandler>> = {
  "w:p": closeParagraph,
  "w:pPr": (state) => {
    const paragraph = topParagraph(state);
    if (paragraph !== undefined) paragraph.inPPr = false;
  },
  "w:numPr": (state) => {
    const paragraph = topParagraph(state);
    if (paragraph !== undefined) paragraph.inNumPr = false;
  },
  "w:r": closeRun,
  "w:rPr": (state) => {
    const paragraph = topParagraph(state);
    if (paragraph !== undefined) paragraph.inRPr = false;
  },
  "w:t": closeText,
  "m:t": closeText,
  "w:tbl": closeTable,
  "w:tr": closeRow,
  "w:trPr": closeRowProperties,
  "w:tc": closeCell,
  "w:txbxContent": closeTextBox,
  "w:footnote": closeNote,
  "w:endnote": closeNote,
  "w:sdt": closeControl,
  "mc:AlternateContent": closeAlternate,
};

function handlerFor(
  table: Readonly<Record<string, TagHandler>>,
  tag: XmlTag,
): TagHandler | undefined {
  const key = `${tag.prefix}:${tag.local}`;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// ─── Excluded subtrees ───────────────────────────────────────────────────────

/**
 * Whether the element's whole subtree is not visible document content: tracked deletions and
 * moved-away text, the fallback rendering (or any later branch) of alternate content, formatting
 * history, and the placeholder text of a content control that shows its prompt.
 */
function isExcludedSubtree(state: WalkState, tag: XmlTag): boolean {
  if (tag.prefix === "mc") {
    return tag.local === "Fallback" || (tag.local === "Choice" && state.alternates.at(-1) === true);
  }
  if (tag.prefix !== "w") return false;
  if (tag.local === "del" || tag.local === "moveFrom") return true;
  if (tag.local.endsWith("PrChange") || tag.local === "tblGridChange") return true;
  return tag.local === "sdtContent" && state.sdts.at(-1) === true;
}

function applyOpenTag(state: WalkState, tag: XmlTag): void {
  handlerFor(OPEN_HANDLERS, tag)?.(state, tag);
  if (tag.selfClosing) handlerFor(CLOSE_HANDLERS, tag)?.(state, tag);
}

function applyClosingTag(state: WalkState, tag: XmlTag): void {
  state.depth -= 1;
  if (state.skipDepth === NO_SKIP) handlerFor(CLOSE_HANDLERS, tag)?.(state, tag);
  else if (state.depth === state.skipDepth) state.skipDepth = NO_SKIP;
}

function enterExcludedSubtree(state: WalkState, tag: XmlTag): void {
  if (tag.local === "sdtContent") state.placeholderCount += 1;
  state.skipDepth = state.depth;
  state.depth += 1;
}

function applyTag(state: WalkState, tag: XmlTag): void {
  if (tag.closing) {
    applyClosingTag(state, tag);
    return;
  }
  if (state.skipDepth !== NO_SKIP) {
    if (!tag.selfClosing) state.depth += 1;
    return;
  }
  if (!tag.selfClosing && isExcludedSubtree(state, tag)) {
    enterExcludedSubtree(state, tag);
    return;
  }
  if (!tag.selfClosing) state.depth += 1;
  applyOpenTag(state, tag);
}

function initialState(): WalkState {
  return {
    frames: [newContainer("body")],
    alternates: [],
    sdts: [],
    notes: new Map(),
    depth: 0,
    skipDepth: NO_SKIP,
    hiddenCount: 0,
    placeholderCount: 0,
    objectCount: 0,
  };
}

function finish(
  state: WalkState,
  outcome: { readonly limitReached: boolean; readonly interrupted: boolean },
): WordPartRead {
  const body = state.frames[0];
  return {
    blocks: body?.kind === "container" ? body.blocks : [],
    notes: state.notes,
    hiddenCount: state.hiddenCount,
    placeholderCount: state.placeholderCount,
    ...outcome,
  };
}

/**
 * Reads one WordprocessingML part. Malformed markup and nesting beyond `maxDepth` throw; the
 * object budget and the interrupt poll end the read early and say so in the result.
 */
export function readWordPart(xml: string, limits: WordPartLimits): WordPartRead {
  const state = initialState();
  let polled = 0;
  for (const token of scanXmlTokens(xml, limits.maxDepth)) {
    if (token.kind === "text") {
      if (state.skipDepth === NO_SKIP) addText(state, token.value);
      continue;
    }
    applyTag(state, token);
    if (state.objectCount > limits.maxObjects) {
      return finish(state, { limitReached: true, interrupted: false });
    }
    if (state.objectCount >= polled + INTERRUPT_POLL_MASK + 1) {
      polled = state.objectCount;
      if (limits.interrupt?.() === true) {
        return finish(state, { limitReached: false, interrupted: true });
      }
    }
  }
  return finish(state, { limitReached: false, interrupted: false });
}

/** Counts the `w:<local>` elements of a part (the review comments of `comments.xml`, say). */
export function countWordElements(xml: string, local: string, maxDepth: number): number {
  let count = 0;
  for (const tag of scanXmlTags(xml, maxDepth)) {
    if (!tag.closing && tag.prefix === "w" && tag.local === local) count += 1;
  }
  return count;
}
