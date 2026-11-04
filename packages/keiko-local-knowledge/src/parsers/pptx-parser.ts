// PowerPoint (.pptx) text-layer parser. Reads the slide order from `ppt/presentation.xml` and its
// relationships, each slide's shape paragraphs and tables in reading order, the text of the charts
// and SmartArt diagrams the slide embeds, and the speaker notes linked through the slide's
// relationships. One section is emitted per slide that carries text, so a citation can point at
// "Slide N". Hidden slides stay indexed and are counted. Images and other embedded objects are
// never read, and no OCR runs. Bounds and fail-closed behaviour follow the docx adapter: the package is inflated
// in memory under entry-size, ratio and entry-count caps, and malformed markup is rejected.

import { posix } from "node:path";

import type {
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_PPTX_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";

import {
  diagnostic,
  emptyResult,
  encryptedOoxmlRefusal,
  objectLimitDiagnostic,
  oversizeDiagnostic,
  parserIdentity,
  shouldStop,
} from "./_internal.js";
import {
  classifyOoxmlZipError,
  isOoxmlEntryOversized,
  ooxmlEntryInflatedLimit,
  readOoxmlZipEntries,
  type OoxmlZipReadPlan,
} from "./ooxml-zip.js";
import { readChartLines, readDiagramLines, type EmbeddedRead } from "./pptx-embedded.js";
import { attributeOf, scanXmlTags } from "./pptx-xml.js";
import { walkPresentationPart, type PartItem, type SlidePosition } from "./pptx-walk.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "pptx";
// v2: speaker notes keep their paragraphs, shapes are read in reading order, bullet levels are kept,
// merged table cells repeat their value, alternate renderings are read once, and the text of
// embedded charts and SmartArt diagrams is indexed.
const PARSER_VERSION = "2";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "yauzl", version: "3.4.0" }),
]);
const PPTX_MEDIA = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PRESENTATION_ENTRY = "ppt/presentation.xml";
const PRESENTATION_RELS_ENTRY = "ppt/_rels/presentation.xml.rels";
const SLIDE_ENTRY_PATTERN = /^ppt\/slides\/[^/]+\.xml$/u;
const SLIDE_RELS_ENTRY_PATTERN = /^ppt\/slides\/_rels\/[^/]+\.xml\.rels$/u;
const NOTES_ENTRY_PATTERN = /^ppt\/notesSlides\/[^/]+\.xml$/u;
const CHART_ENTRY_PATTERN = /^ppt\/charts\/[^/]+\.xml$/u;
const DIAGRAM_DATA_ENTRY_PATTERN = /^ppt\/diagrams\/data[^/]*\.xml$/u;
const NOTES_RELATIONSHIP_SUFFIX = "/notesslide";
const CHART_RELATIONSHIP_SUFFIX = "/chart";
const DIAGRAM_RELATIONSHIP_SUFFIX = "/diagramdata";
// Shapes whose tops lie within one band read as a row, left to right.
const ROW_BAND_EMU = 457_200;
const MAX_PPTX_PART_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_PPTX_PACKAGE_INFLATED_BYTES = 128 * 1024 * 1024;
// A deck with a few hundred slides carries media, layouts and relationship parts well beyond a
// word-processing package; the ceiling still denies an archive padded with unbounded entries.
const MAX_PPTX_ZIP_ENTRIES = 16_384;
const MAX_TITLE_CHARACTERS = 120;
const TITLE_PLACEHOLDERS: ReadonlySet<string> = new Set(["title", "ctrTitle"]);
const CHROME_PLACEHOLDERS: ReadonlySet<string> = new Set(["sldNum", "dt", "ftr", "hdr", "sldImg"]);
const PPTX_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_PPTX_FILE_EXTENSIONS);

function isPptx(input: ParserSelectionInput): boolean {
  return (
    PPTX_EXTENSIONS.has(input.extension.toLowerCase()) ||
    input.mediaType.toLowerCase() === PPTX_MEDIA
  );
}

function isPptxEntry(name: string): boolean {
  return (
    name === PRESENTATION_ENTRY ||
    name === PRESENTATION_RELS_ENTRY ||
    SLIDE_ENTRY_PATTERN.test(name) ||
    SLIDE_RELS_ENTRY_PATTERN.test(name) ||
    NOTES_ENTRY_PATTERN.test(name) ||
    CHART_ENTRY_PATTERN.test(name) ||
    DIAGRAM_DATA_ENTRY_PATTERN.test(name)
  );
}

function zipPlan(options: ParserOptions): OoxmlZipReadPlan {
  return {
    format: "pptx",
    isWanted: isPptxEntry,
    maxEntries: MAX_PPTX_ZIP_ENTRIES,
    maxEntryInflatedBytes: ooxmlEntryInflatedLimit(options.maxBytes, MAX_PPTX_PART_INFLATED_BYTES),
    maxTotalInflatedBytes: ooxmlEntryInflatedLimit(
      options.maxBytes,
      MAX_PPTX_PACKAGE_INFLATED_BYTES,
    ),
  };
}

// ─── Relationships and slide order ───────────────────────────────────────────

interface Relationship {
  readonly type: string;
  readonly partName: string;
}

/** Resolves a relationship target against its source directory; escapes yield undefined. */
function resolvePartName(baseDirectory: string, target: string): string | undefined {
  const joined = target.startsWith("/") ? target.slice(1) : posix.join(baseDirectory, target);
  const normalized = posix.normalize(joined);
  return normalized.startsWith("..") || normalized.startsWith("/") ? undefined : normalized;
}

function parseRelationships(
  xml: string,
  baseDirectory: string,
  maxDepth: number,
): ReadonlyMap<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  for (const tag of scanXmlTags(xml, maxDepth)) {
    if (tag.closing || tag.local !== "Relationship") continue;
    const id = attributeOf(tag, "Id");
    const target = attributeOf(tag, "Target");
    if (id === undefined || target === undefined) continue;
    if (attributeOf(tag, "TargetMode")?.toLowerCase() === "external") continue;
    const partName = resolvePartName(baseDirectory, target);
    if (partName === undefined) continue;
    relationships.set(id, { type: (attributeOf(tag, "Type") ?? "").toLowerCase(), partName });
  }
  return relationships;
}

/** Slide part names in presentation order; an unresolvable slide id is reported as undefined. */
function readSlideOrder(
  parts: ReadonlyMap<string, string>,
  maxDepth: number,
): readonly (string | undefined)[] {
  const presentation = parts.get(PRESENTATION_ENTRY);
  const rels = parts.get(PRESENTATION_RELS_ENTRY);
  if (presentation === undefined || rels === undefined) {
    throw new Error("pptx missing presentation part");
  }
  const relationships = parseRelationships(rels, "ppt", maxDepth);
  const order: (string | undefined)[] = [];
  for (const tag of scanXmlTags(presentation, maxDepth)) {
    if (tag.closing || tag.local !== "sldId") continue;
    const relationshipId = attributeOf(tag, "r:id");
    order.push(
      relationshipId === undefined ? undefined : relationships.get(relationshipId)?.partName,
    );
  }
  return order;
}

function slideRelationships(
  parts: ReadonlyMap<string, string>,
  slidePart: string,
  maxDepth: number,
): ReadonlyMap<string, Relationship> {
  const directory = posix.dirname(slidePart);
  const relsXml = parts.get(`${directory}/_rels/${posix.basename(slidePart)}.rels`);
  return relsXml === undefined ? new Map() : parseRelationships(relsXml, directory, maxDepth);
}

function notesPartOf(relationships: ReadonlyMap<string, Relationship>): string | undefined {
  for (const relationship of relationships.values()) {
    if (relationship.type.endsWith(NOTES_RELATIONSHIP_SUFFIX)) return relationship.partName;
  }
  return undefined;
}

// ─── Slide text projection ───────────────────────────────────────────────────

interface SlideText {
  readonly label: string;
  readonly lines: readonly string[];
}

function normalizeHeaders(cells: readonly string[]): readonly string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, index) => {
    const base = cell.trim().length > 0 ? cell.trim() : `Column ${String(index + 1)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} ${String(count + 1)}`;
  });
}

function columnLabel(index: number): string {
  return `Column ${String(index + 1)}`;
}

function projectTable(item: Extract<PartItem, { kind: "table" }>): readonly string[] {
  const useHeader = item.headerRow && item.rows.length > 1;
  const headers = useHeader ? normalizeHeaders(item.rows[0] ?? []) : [];
  const dataRows = useHeader ? item.rows.slice(1) : item.rows;
  return dataRows
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells, rowIndex) => {
      const projected = cells
        .map((cell, index) => `${headers[index] ?? columnLabel(index)}=${cell}`)
        .join(" | ");
      return `Table row ${String(rowIndex + 1)}: ${projected}`;
    });
}

function titleParagraphsOf(items: readonly PartItem[]): readonly string[] {
  return items.flatMap((item) =>
    item.kind === "shape" && TITLE_PLACEHOLDERS.has(item.placeholder ?? "") ? item.paragraphs : [],
  );
}

interface SlideTitle {
  /** Shortened title for the section label (the citation path); never the indexed content. */
  readonly label: string;
  /** Complete title paragraphs that the shortened label cannot carry; empty when it fits. */
  readonly overflow: readonly string[];
}

function titleOf(items: readonly PartItem[]): SlideTitle {
  const paragraphs = titleParagraphsOf(items);
  const title = paragraphs.join(" ").replaceAll(/\s+/gu, " ").trim();
  const characters = Array.from(title);
  return {
    label: characters.slice(0, MAX_TITLE_CHARACTERS).join(""),
    overflow: characters.length > MAX_TITLE_CHARACTERS ? paragraphs : [],
  };
}

function bodyLines(items: readonly PartItem[]): readonly string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "table") {
      lines.push(...projectTable(item));
    } else if (
      item.kind === "shape" &&
      !TITLE_PLACEHOLDERS.has(item.placeholder ?? "") &&
      !isChrome(item.placeholder)
    ) {
      lines.push(...item.paragraphs);
    }
  }
  return lines;
}

function isChrome(placeholder: string | undefined): boolean {
  return placeholder !== undefined && CHROME_PLACEHOLDERS.has(placeholder);
}

/** The first note paragraph carries the label; every paragraph stays its own line. */
function noteLines(items: readonly PartItem[]): readonly string[] {
  const paragraphs = items.flatMap((item) =>
    item.kind === "shape" && item.placeholder === "body" ? item.paragraphs : [],
  );
  const [first, ...rest] = paragraphs;
  return first === undefined ? [] : [`Speaker notes: ${first}`, ...rest];
}

// ─── Reading order ───────────────────────────────────────────────────────────

interface Placed {
  readonly item: PartItem;
  readonly index: number;
  readonly band: number;
  readonly x: number;
}

function placementOf(position: SlidePosition | undefined): Pick<Placed, "band" | "x"> {
  return position === undefined
    ? { band: Number.NEGATIVE_INFINITY, x: Number.NEGATIVE_INFINITY }
    : { band: Math.floor(position.y / ROW_BAND_EMU), x: position.x };
}

/**
 * Orders items top to bottom, then left to right, the way the slide is read. An item without a
 * position of its own (a placeholder that inherits it from the layout) stays right behind the
 * item before it, and ties keep document order, so a slide without positions is unchanged.
 */
function inReadingOrder(items: readonly PartItem[]): readonly PartItem[] {
  let last: SlidePosition | undefined;
  const placed: Placed[] = items.map((item, index) => {
    if (item.position !== undefined) last = item.position;
    return { item, index, ...placementOf(item.position ?? last) };
  });
  placed.sort((a, b) => {
    if (a.band !== b.band) return a.band < b.band ? -1 : 1;
    if (a.x !== b.x) return a.x < b.x ? -1 : 1;
    return a.index - b.index;
  });
  return placed.map((entry) => entry.item);
}

function slideTextOf(
  number: number,
  slideItems: readonly PartItem[],
  notesItems: readonly PartItem[],
): SlideText | undefined {
  const title = titleOf(slideItems);
  const lines = [...title.overflow, ...bodyLines(slideItems), ...noteLines(notesItems)];
  if (title.label.length === 0 && lines.length === 0) return undefined;
  const label =
    title.label.length === 0
      ? `Slide ${String(number)}`
      : `Slide ${String(number)}: ${title.label}`;
  return { label, lines };
}

// ─── Deck assembly ───────────────────────────────────────────────────────────

interface DeckRead {
  readonly slides: readonly SlideText[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

interface DeckContext {
  readonly parts: ReadonlyMap<string, string>;
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
}

function missingSlidesDiagnostic(input: ParserSelectionInput, missing: number): ParserDiagnostic {
  return diagnostic(
    "MALFORMED_INPUT",
    `pptx lists ${String(missing)} slide part(s) that the package does not contain`,
    input.documentId,
    "warning",
  );
}

function hiddenSlidesDiagnostic(input: ParserSelectionInput, hidden: number): ParserDiagnostic {
  return diagnostic(
    "HIDDEN_SLIDE_INDEXED",
    `indexed ${String(hidden)} hidden slide(s); hidden slides stay searchable`,
    input.documentId,
    "info",
  );
}

function walkPart(
  context: DeckContext,
  partName: string | undefined,
  remainingObjects: number,
): {
  readonly items: readonly PartItem[];
  readonly objectCount: number;
  readonly limit: boolean;
  readonly hidden: boolean;
} {
  const xml = partName === undefined ? undefined : context.parts.get(partName);
  if (xml === undefined) return { items: [], objectCount: 0, limit: false, hidden: false };
  const walked = walkPresentationPart(xml, {
    maxDepth: context.options.maxNestingDepth,
    maxObjects: remainingObjects,
  });
  return {
    items: walked.items,
    objectCount: walked.objectCount,
    limit: walked.limitReached,
    hidden: walked.hidden,
  };
}

interface ObjectBudget {
  remaining: number;
}

interface SlideRead {
  readonly text: SlideText | undefined;
  readonly limitReached: boolean;
  readonly hidden: boolean;
}

/** Part a chart or diagram reference resolves to, when the relationship has the right type. */
function embeddedPartOf(
  item: Extract<PartItem, { kind: "embedded" }>,
  relationships: ReadonlyMap<string, Relationship>,
): string | undefined {
  const relationship = relationships.get(item.relationshipId);
  const suffix = item.flavor === "chart" ? CHART_RELATIONSHIP_SUFFIX : DIAGRAM_RELATIONSHIP_SUFFIX;
  return relationship?.type.endsWith(suffix) === true ? relationship.partName : undefined;
}

function readEmbedded(
  context: DeckContext,
  item: Extract<PartItem, { kind: "embedded" }>,
  partName: string | undefined,
  budget: ObjectBudget,
): EmbeddedRead | undefined {
  const xml = partName === undefined ? undefined : context.parts.get(partName);
  if (xml === undefined) return undefined;
  const limits = { maxDepth: context.options.maxNestingDepth, maxObjects: budget.remaining };
  const read =
    item.flavor === "chart" ? readChartLines(xml, limits) : readDiagramLines(xml, limits);
  budget.remaining -= read.objectCount;
  return read;
}

interface ResolvedItems {
  readonly items: readonly PartItem[];
  readonly limitReached: boolean;
}

/** Replaces each chart or diagram reference by the shape of text read from its part. */
function resolveEmbedded(
  context: DeckContext,
  items: readonly PartItem[],
  relationships: ReadonlyMap<string, Relationship>,
  budget: ObjectBudget,
): ResolvedItems {
  const resolved: PartItem[] = [];
  let limitReached = false;
  for (const item of items) {
    if (item.kind !== "embedded") {
      resolved.push(item);
      continue;
    }
    const read = readEmbedded(context, item, embeddedPartOf(item, relationships), budget);
    if (read === undefined) continue;
    limitReached ||= read.limitReached;
    if (read.lines.length > 0) {
      resolved.push({
        kind: "shape",
        placeholder: undefined,
        paragraphs: read.lines,
        position: item.position,
      });
    }
  }
  return { items: resolved, limitReached };
}

function readSlide(
  context: DeckContext,
  slidePart: string,
  number: number,
  budget: ObjectBudget,
): SlideRead {
  const slide = walkPart(context, slidePart, budget.remaining);
  budget.remaining -= slide.objectCount;
  const relationships = slideRelationships(
    context.parts,
    slidePart,
    context.options.maxNestingDepth,
  );
  const embedded = resolveEmbedded(context, slide.items, relationships, budget);
  const notes = walkPart(context, notesPartOf(relationships), budget.remaining);
  budget.remaining -= notes.objectCount;
  return {
    text: slideTextOf(number, inReadingOrder(embedded.items), notes.items),
    limitReached: slide.limit || notes.limit || embedded.limitReached,
    hidden: slide.hidden,
  };
}

function stopDiagnostic(context: DeckContext): ParserDiagnostic | undefined {
  const stop = shouldStop(context.startedAt, context.options, 0);
  if (!stop.stop || stop.code === undefined || stop.message === undefined) return undefined;
  return diagnostic(stop.code, stop.message, context.input.documentId, "info");
}

interface DeckTally {
  readonly slides: SlideText[];
  readonly diagnostics: ParserDiagnostic[];
  missing: number;
  hidden: number;
}

/** Reads the listed slide parts in order; returns false once the read must stop. */
function readListedSlide(
  context: DeckContext,
  tally: DeckTally,
  slidePart: string | undefined,
  index: number,
  budget: ObjectBudget,
): boolean {
  const stopped = stopDiagnostic(context);
  if (stopped !== undefined) {
    tally.diagnostics.push(stopped);
    return false;
  }
  if (slidePart === undefined || !context.parts.has(slidePart)) {
    tally.missing += 1;
    return true;
  }
  const read = readSlide(context, slidePart, index + 1, budget);
  if (read.text !== undefined) {
    tally.slides.push(read.text);
    if (read.hidden) tally.hidden += 1;
  }
  if (!read.limitReached) return true;
  const { input, options } = context;
  tally.diagnostics.push(objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument));
  return false;
}

function readDeck(context: DeckContext): DeckRead {
  const { options, input } = context;
  const order = readSlideOrder(context.parts, options.maxNestingDepth);
  const tally: DeckTally = { slides: [], diagnostics: [], missing: 0, hidden: 0 };
  const budget: ObjectBudget = { remaining: options.maxObjectsPerDocument };
  for (const [index, slidePart] of order.entries()) {
    if (!readListedSlide(context, tally, slidePart, index, budget)) break;
  }
  if (order.length > 0 && tally.missing === order.length) {
    throw new Error("pptx slide parts missing");
  }
  if (tally.missing > 0) tally.diagnostics.push(missingSlidesDiagnostic(input, tally.missing));
  if (tally.hidden > 0) tally.diagnostics.push(hiddenSlidesDiagnostic(input, tally.hidden));
  return { slides: tally.slides, diagnostics: tally.diagnostics };
}

interface SectionBuild {
  readonly sections: readonly SectionRecord[];
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

function slideSections(
  texts: readonly string[],
  slides: readonly SlideText[],
  context: DeckContext,
): SectionBuild {
  const sections: SectionRecord[] = [];
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const total = texts.join("\n").length;
  let start = 0;
  for (const [index, text] of texts.entries()) {
    const stop = shouldStop(context.startedAt, context.options, units.length);
    if (stop.stop && stop.code !== undefined && stop.message !== undefined) {
      const severity = stop.code === "UNIT_LIMIT_REACHED" ? "warning" : "info";
      diagnostics.push(diagnostic(stop.code, stop.message, context.input.documentId, severity));
      break;
    }
    const end = index === texts.length - 1 ? total : start + text.length + 1;
    const section: SectionRecord = {
      documentId: context.input.documentId,
      sectionPath: [slides[index]?.label ?? ""],
      characterStart: start,
      characterEnd: end,
    };
    sections.push(section);
    units.push({
      kind: "section",
      documentId: section.documentId,
      sectionPath: section.sectionPath,
      characterStart: section.characterStart,
      characterEnd: section.characterEnd,
    });
    start = end;
  }
  return { sections, units, diagnostics };
}

function noTextResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  diagnostics: readonly ParserDiagnostic[],
): ParserResult {
  if (diagnostics.length > 0)
    return emptyResult(capability, input.documentId, options, diagnostics);
  return emptyResult(
    capability,
    input.documentId,
    options,
    [diagnostic("UNSUPPORTED_FORMAT", "pptx has no extractable text content", input.documentId)],
    [{ kind: "unsupported-media", documentId: input.documentId, reason: "pptx-no-text" }],
  );
}

function deckResult(
  capability: ParserCapability,
  context: DeckContext,
  deck: DeckRead,
): InternalParserResult {
  const texts = deck.slides.map((slide) => [slide.label, ...slide.lines].join("\n"));
  const built = slideSections(texts, deck.slides, context);
  return {
    documentId: context.input.documentId,
    parser: parserIdentity(capability),
    pages: [],
    sections: built.sections,
    units: built.units,
    diagnostics: [...deck.diagnostics, ...built.diagnostics],
    extractedAt: context.options.now(),
    normalizedText: texts.join("\n"),
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

function failureDiagnostic(
  failure: ReturnType<typeof classifyOoxmlZipError>,
  input: ParserSelectionInput,
): ParserDiagnostic {
  switch (failure) {
    case "cancelled":
      return diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info");
    case "budget":
      return diagnostic(
        "PARSER_TIMEOUT",
        "pptx zip scan exceeded budget before the presentation was read",
        input.documentId,
        "info",
      );
    case "malformed":
      return diagnostic(
        "MALFORMED_INPUT",
        "pptx parser rejected malformed or unsupported presentation",
        input.documentId,
        "error",
      );
  }
}

function oversizedPartDiagnostic(
  error: unknown,
  input: ParserSelectionInput,
): ParserDiagnostic | undefined {
  if (!isOoxmlEntryOversized(error)) return undefined;
  return diagnostic(
    "OVERSIZED_FILE",
    "pptx part exceeds the inflated size limit of the parser",
    input.documentId,
    "info",
  );
}

function failureResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  error: unknown,
): ParserResult {
  const entry =
    oversizedPartDiagnostic(error, input) ?? failureDiagnostic(classifyOoxmlZipError(error), input);
  return emptyResult(capability, input.documentId, options, [entry]);
}

async function asyncParse(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): Promise<ParserResult> {
  if (input.bytes.byteLength > options.maxBytes) {
    return emptyResult(capability, input.documentId, options, [
      oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
    ]);
  }
  if (options.signal?.aborted === true) {
    return emptyResult(capability, input.documentId, options, [
      diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info"),
    ]);
  }
  const encrypted = encryptedOoxmlRefusal(capability, input, options, "pptx");
  if (encrypted !== undefined) return encrypted;
  const startedAt = options.now();
  try {
    const parts = await readOoxmlZipEntries(input.bytes, options, startedAt, zipPlan(options));
    const context: DeckContext = { parts, input, options, startedAt };
    const deck = readDeck(context);
    return deck.slides.length === 0
      ? noTextResult(capability, input, options, deck.diagnostics)
      : deckResult(capability, context, deck);
  } catch (error) {
    return failureResult(capability, input, options, error);
  }
}

function syncFallback(capability: ParserCapability): ParserAdapter["parse"] {
  return (input, options) =>
    emptyResult(
      capability,
      input.documentId,
      options,
      [
        diagnostic(
          "UNSUPPORTED_FORMAT",
          "pptx parser requires async caller; use parseAsync via discovery",
          input.documentId,
        ),
      ],
      [{ kind: "unsupported-media", documentId: input.documentId, reason: "pptx-async-required" }],
    );
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  dependencyVersions: DEPENDENCY_VERSIONS,
  matches: isPptx,
});

export const pptxParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
