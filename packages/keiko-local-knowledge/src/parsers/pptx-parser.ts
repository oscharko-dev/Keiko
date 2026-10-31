// PowerPoint (.pptx) text-layer parser. Reads the slide order from `ppt/presentation.xml` and its
// relationships, each slide's shape paragraphs and tables, and the speaker notes linked through
// the slide's relationships. One section is emitted per slide that carries text, so a citation
// can point at "Slide N". Images, charts, SmartArt and embedded objects are never read, and no
// OCR runs. Bounds and fail-closed behaviour follow the docx adapter: the package is inflated
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
  objectLimitDiagnostic,
  oversizeDiagnostic,
  parserIdentity,
  shouldStop,
} from "./_internal.js";
import {
  classifyOoxmlZipError,
  ooxmlEntryInflatedLimit,
  readOoxmlZipEntries,
  type OoxmlZipReadPlan,
} from "./ooxml-zip.js";
import { attributeOf, scanXmlTags, walkPresentationPart, type PartItem } from "./pptx-xml.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "pptx";
const PARSER_VERSION = "1";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "yauzl", version: "3.4.0" }),
]);
const PPTX_MEDIA = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PRESENTATION_ENTRY = "ppt/presentation.xml";
const PRESENTATION_RELS_ENTRY = "ppt/_rels/presentation.xml.rels";
const SLIDE_ENTRY_PATTERN = /^ppt\/slides\/[^/]+\.xml$/u;
const SLIDE_RELS_ENTRY_PATTERN = /^ppt\/slides\/_rels\/[^/]+\.xml\.rels$/u;
const NOTES_ENTRY_PATTERN = /^ppt\/notesSlides\/[^/]+\.xml$/u;
const NOTES_RELATIONSHIP_SUFFIX = "/notesslide";
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
    NOTES_ENTRY_PATTERN.test(name)
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

function notesPartOf(
  parts: ReadonlyMap<string, string>,
  slidePart: string,
  maxDepth: number,
): string | undefined {
  const directory = posix.dirname(slidePart);
  const relsXml = parts.get(`${directory}/_rels/${posix.basename(slidePart)}.rels`);
  if (relsXml === undefined) return undefined;
  for (const relationship of parseRelationships(relsXml, directory, maxDepth).values()) {
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
    } else if (!TITLE_PLACEHOLDERS.has(item.placeholder ?? "") && !isChrome(item.placeholder)) {
      lines.push(...item.paragraphs);
    }
  }
  return lines;
}

function isChrome(placeholder: string | undefined): boolean {
  return placeholder !== undefined && CHROME_PLACEHOLDERS.has(placeholder);
}

function noteLines(items: readonly PartItem[]): readonly string[] {
  const paragraphs = items.flatMap((item) =>
    item.kind === "shape" && item.placeholder === "body" ? item.paragraphs : [],
  );
  return paragraphs.length === 0 ? [] : [`Speaker notes: ${paragraphs.join(" ")}`];
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

function walkPart(
  context: DeckContext,
  partName: string | undefined,
  remainingObjects: number,
): { readonly items: readonly PartItem[]; readonly objectCount: number; readonly limit: boolean } {
  const xml = partName === undefined ? undefined : context.parts.get(partName);
  if (xml === undefined) return { items: [], objectCount: 0, limit: false };
  const walked = walkPresentationPart(xml, {
    maxDepth: context.options.maxNestingDepth,
    maxObjects: remainingObjects,
  });
  return { items: walked.items, objectCount: walked.objectCount, limit: walked.limitReached };
}

interface ObjectBudget {
  remaining: number;
}

interface SlideRead {
  readonly text: SlideText | undefined;
  readonly limitReached: boolean;
}

function readSlide(
  context: DeckContext,
  slidePart: string,
  number: number,
  budget: ObjectBudget,
): SlideRead {
  const slide = walkPart(context, slidePart, budget.remaining);
  budget.remaining -= slide.objectCount;
  const notesPart = notesPartOf(context.parts, slidePart, context.options.maxNestingDepth);
  const notes = walkPart(context, notesPart, budget.remaining);
  budget.remaining -= notes.objectCount;
  return {
    text: slideTextOf(number, slide.items, notes.items),
    limitReached: slide.limit || notes.limit,
  };
}

function stopDiagnostic(context: DeckContext): ParserDiagnostic | undefined {
  const stop = shouldStop(context.startedAt, context.options, 0);
  if (!stop.stop || stop.code === undefined || stop.message === undefined) return undefined;
  return diagnostic(stop.code, stop.message, context.input.documentId, "info");
}

function readDeck(context: DeckContext): DeckRead {
  const { options, input } = context;
  const order = readSlideOrder(context.parts, options.maxNestingDepth);
  const slides: SlideText[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const budget: ObjectBudget = { remaining: options.maxObjectsPerDocument };
  let missing = 0;
  for (const [index, slidePart] of order.entries()) {
    const stopped = stopDiagnostic(context);
    if (stopped !== undefined) {
      diagnostics.push(stopped);
      break;
    }
    if (slidePart === undefined || !context.parts.has(slidePart)) {
      missing += 1;
      continue;
    }
    const read = readSlide(context, slidePart, index + 1, budget);
    if (read.text !== undefined) slides.push(read.text);
    if (read.limitReached) {
      diagnostics.push(objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument));
      break;
    }
  }
  if (order.length > 0 && missing === order.length) throw new Error("pptx slide parts missing");
  if (missing > 0) diagnostics.push(missingSlidesDiagnostic(input, missing));
  return { slides, diagnostics };
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
      diagnostics.push(diagnostic(stop.code, stop.message, context.input.documentId, "info"));
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

function failureResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  error: unknown,
): ParserResult {
  const entry = failureDiagnostic(classifyOoxmlZipError(error), input);
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
