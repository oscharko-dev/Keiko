import type {
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";

import {
  diagnostic,
  emptyResult,
  encryptedOoxmlRefusal,
  objectLimitDiagnostic,
  oversizeDiagnostic,
  parserIdentity,
  shouldStop,
} from "./_internal.js";
import { joinBlocks, layoutOfBlocks } from "./block-text.js";
import { projectBody, unreferencedNotes, type Paragraph } from "./docx-blocks.js";
import {
  createNumberingTracker,
  parseNumberingCatalog,
  type NumberingCatalog,
} from "./docx-numbering.js";
import { parseStyleCatalog, type StyleCatalog } from "./docx-styles.js";
import { countWordElements, readWordPart, type WordPartRead } from "./docx-xml.js";
import {
  classifyOoxmlZipError,
  isOoxmlEntryOversized,
  ooxmlEntryInflatedLimit,
  readOoxmlZipEntries,
  type OoxmlZipReadPlan,
} from "./ooxml-zip.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "docx";
// v2: tabs, soft breaks and non-breaking hyphens are read in run order; headings resolve through
// styles.xml and nest by level; lists carry real markers; table headers, spans and merges follow
// the grid; text boxes, notes and hidden or placeholder text are placed or excluded explicitly.
const PARSER_VERSION = "2";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "yauzl", version: "3.4.0" }),
]);
const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCUMENT_XML_ENTRY = "word/document.xml";
const FOOTNOTES_XML_ENTRY = "word/footnotes.xml";
const ENDNOTES_XML_ENTRY = "word/endnotes.xml";
const STYLES_XML_ENTRY = "word/styles.xml";
const NUMBERING_XML_ENTRY = "word/numbering.xml";
const COMMENTS_XML_ENTRY = "word/comments.xml";
const DOCX_XML_ENTRIES: ReadonlySet<string> = new Set([
  DOCUMENT_XML_ENTRY,
  FOOTNOTES_XML_ENTRY,
  ENDNOTES_XML_ENTRY,
  STYLES_XML_ENTRY,
  NUMBERING_XML_ENTRY,
  COMMENTS_XML_ENTRY,
]);
const MAX_DOCUMENT_XML_INFLATED_BYTES = 16 * 1024 * 1024;
// KEIKO-0428: cap the number of central-directory entries the zip scan is willing to walk before
// aborting. A real .docx has on the order of a few dozen entries (`word/document.xml`,
// `word/footnotes.xml`, styles, themes, media, `[Content_Types].xml`); the ceiling here is a
// generous multiple that admits every realistic template while denying an adversarial ZIP with
// hundreds of thousands of tiny non-matching entries (each entry costs ~46 bytes of central
// directory + filename, so a maxBytes budget in the tens of MB comfortably admits that regime).
const MAX_DOCX_ZIP_ENTRIES = 4_096;
const DOCX_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS);

function isDocx(input: ParserSelectionInput): boolean {
  return (
    DOCX_EXTENSIONS.has(input.extension.toLowerCase()) ||
    input.mediaType.toLowerCase() === DOCX_MEDIA
  );
}

function cancelled(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult {
  return emptyResult(capability, input.documentId, options, [
    diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info"),
  ]);
}

function syncFallback(capability: ParserCapability): ParserAdapter["parse"] {
  return (input, options) => {
    return emptyResult(
      capability,
      input.documentId,
      options,
      [
        diagnostic(
          "UNSUPPORTED_FORMAT",
          "docx parser requires async caller; use parseAsync via discovery",
          input.documentId,
          "info",
        ),
      ],
      [unsupportedMediaUnit(input.documentId, "docx-async-required")],
    );
  };
}

function docxZipPlan(options: ParserOptions): OoxmlZipReadPlan {
  return {
    format: "docx",
    isWanted: (name) => DOCX_XML_ENTRIES.has(name),
    maxEntries: MAX_DOCX_ZIP_ENTRIES,
    maxEntryInflatedBytes: ooxmlEntryInflatedLimit(
      options.maxBytes,
      MAX_DOCUMENT_XML_INFLATED_BYTES,
    ),
    duplicateParts: "replace",
  };
}

interface SectionBuildResult {
  readonly sections: readonly SectionRecord[];
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

/** A section cut leaves text without a section path, so it is a warning, not a note. */
function limitDiagnostic(
  input: ParserSelectionInput,
  limit: ReturnType<typeof shouldStop>,
): ParserDiagnostic | undefined {
  if (!limit.stop || limit.code === undefined || limit.message === undefined) {
    return undefined;
  }
  const severity = limit.code === "UNIT_LIMIT_REACHED" ? "warning" : "info";
  return diagnostic(limit.code, limit.message, input.documentId, severity);
}

// ─── Reading the parts ───────────────────────────────────────────────────────

interface DocxCatalogs {
  readonly styles: StyleCatalog | undefined;
  readonly numbering: NumberingCatalog | undefined;
}

interface ReadContext {
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly diagnostics: ParserDiagnostic[];
}

function recordUnreadablePart(context: ReadContext, entry: string): void {
  context.diagnostics.push(
    diagnostic(
      "PART_SKIPPED",
      `docx ${entry} could not be read and was skipped`,
      context.input.documentId,
      "warning",
    ),
  );
}

/** An auxiliary part that cannot be read degrades the result; it never fails the document. */
function readAuxiliary<T>(
  context: ReadContext,
  entry: string,
  xml: string | undefined,
  read: (xml: string) => T,
): T | undefined {
  if (xml === undefined) return undefined;
  try {
    return read(xml);
  } catch {
    recordUnreadablePart(context, entry);
    return undefined;
  }
}

function readCatalogs(context: ReadContext, parts: ReadonlyMap<string, string>): DocxCatalogs {
  const maxDepth = context.options.maxNestingDepth;
  return {
    styles: readAuxiliary(context, STYLES_XML_ENTRY, parts.get(STYLES_XML_ENTRY), (xml) =>
      parseStyleCatalog(xml, maxDepth),
    ),
    numbering: readAuxiliary(context, NUMBERING_XML_ENTRY, parts.get(NUMBERING_XML_ENTRY), (xml) =>
      parseNumberingCatalog(xml, maxDepth),
    ),
  };
}

function wordLimits(context: ReadContext): Parameters<typeof readWordPart>[1] {
  const { options, startedAt } = context;
  return {
    maxDepth: options.maxNestingDepth,
    maxObjects: options.maxObjectsPerDocument,
    interrupt: () => shouldStop(startedAt, options, 0).stop,
  };
}

/** The notes of a footnotes or endnotes part; what it excludes is counted with the body's. */
function readNotes(
  context: ReadContext,
  entry: string,
  xml: string | undefined,
): Pick<WordPartRead, "notes" | "hiddenCount" | "placeholderCount"> {
  const read = readAuxiliary(context, entry, xml, (part) =>
    readWordPart(part, wordLimits(context)),
  );
  return {
    notes: read?.notes ?? new Map(),
    hiddenCount: read?.hiddenCount ?? 0,
    placeholderCount: read?.placeholderCount ?? 0,
  };
}

function countComments(context: ReadContext, xml: string | undefined): number {
  return (
    readAuxiliary(context, COMMENTS_XML_ENTRY, xml, (part) =>
      countWordElements(part, "comment", context.options.maxNestingDepth),
    ) ?? 0
  );
}

function exclusionDiagnostics(
  input: ParserSelectionInput,
  counts: { readonly hidden: number; readonly placeholders: number; readonly comments: number },
): readonly ParserDiagnostic[] {
  const out: ParserDiagnostic[] = [];
  if (counts.hidden > 0) {
    out.push(
      diagnostic(
        "HIDDEN_CONTENT_EXCLUDED",
        `excluded ${String(counts.hidden)} hidden text run(s) that a reader cannot see`,
        input.documentId,
        "info",
      ),
    );
  }
  if (counts.placeholders > 0) {
    out.push(
      diagnostic(
        "PLACEHOLDER_CONTENT_EXCLUDED",
        `excluded ${String(counts.placeholders)} content-control placeholder(s)`,
        input.documentId,
        "info",
      ),
    );
  }
  if (counts.comments > 0) {
    out.push(
      diagnostic(
        "COMMENTS_NOT_INDEXED",
        `${String(counts.comments)} review comment(s) are not indexed`,
        input.documentId,
        "info",
      ),
    );
  }
  return out;
}

function readStopDiagnostic(context: ReadContext, main: WordPartRead): ParserDiagnostic[] {
  const { input, options, startedAt } = context;
  if (main.limitReached)
    return [objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument)];
  if (!main.interrupted) return [];
  const stopped = limitDiagnostic(input, shouldStop(startedAt, options, 0));
  return stopped === undefined ? [] : [stopped];
}

interface ParagraphParseResult {
  readonly paragraphs: readonly Paragraph[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

function parseParagraphs(
  parts: ReadonlyMap<string, string>,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): ParagraphParseResult {
  const context: ReadContext = { input, options, startedAt, diagnostics: [] };
  const catalogs = readCatalogs(context, parts);
  const documentXml = parts.get(DOCUMENT_XML_ENTRY);
  if (documentXml === undefined) throw new Error("docx missing word/document.xml");
  const main = readWordPart(documentXml, wordLimits(context));
  const footnotes = readNotes(context, FOOTNOTES_XML_ENTRY, parts.get(FOOTNOTES_XML_ENTRY));
  const endnotes = readNotes(context, ENDNOTES_XML_ENTRY, parts.get(ENDNOTES_XML_ENTRY));
  const projection = {
    styles: catalogs.styles,
    numbering: createNumberingTracker(catalogs.numbering, catalogs.styles),
    footnotes: footnotes.notes,
    endnotes: endnotes.notes,
    placed: new Set<string>(),
  };
  const body = projectBody(main.blocks, projection);
  const comments = countComments(context, parts.get(COMMENTS_XML_ENTRY));
  return {
    paragraphs: [...body, ...unreferencedNotes(projection)],
    diagnostics: [
      ...context.diagnostics,
      ...readStopDiagnostic(context, main),
      ...exclusionDiagnostics(input, {
        hidden: main.hiddenCount + footnotes.hiddenCount + endnotes.hiddenCount,
        placeholders:
          main.placeholderCount + footnotes.placeholderCount + endnotes.placeholderCount,
        comments,
      }),
    ],
  };
}

// ─── Sections ────────────────────────────────────────────────────────────────

interface HeadingParagraph extends Paragraph {
  readonly headingLevel: number;
}

interface HeadingEntry {
  readonly paragraph: HeadingParagraph;
  readonly index: number;
}

function isHeadingEntry(entry: {
  readonly paragraph: Paragraph;
  readonly index: number;
}): entry is HeadingEntry {
  return entry.paragraph.headingLevel !== undefined;
}

function collectHeadings(paragraphs: readonly Paragraph[]): readonly HeadingEntry[] {
  return paragraphs.map((paragraph, index) => ({ paragraph, index })).filter(isHeadingEntry);
}

function unsupportedMediaUnit(
  documentId: ParserSelectionInput["documentId"],
  reason: string,
): ParsedUnit {
  return { kind: "unsupported-media", documentId, reason };
}

function sectionUnit(section: SectionRecord): ParsedUnit {
  return {
    kind: "section",
    documentId: section.documentId,
    sectionPath: section.sectionPath,
    characterStart: section.characterStart,
    characterEnd: section.characterEnd,
  };
}

function appendSectionRecord(
  sections: SectionRecord[],
  units: ParsedUnit[],
  input: ParserSelectionInput,
  sectionPath: readonly string[],
  start: number,
  end: number,
): void {
  const sectionRecord: SectionRecord = {
    documentId: input.documentId,
    sectionPath,
    characterStart: start,
    characterEnd: end,
  };
  sections.push(sectionRecord);
  units.push(sectionUnit(sectionRecord));
}

interface AppendLimitedSectionRecordArgs {
  readonly diagnostics: ParserDiagnostic[];
  readonly end: number;
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly sectionPath: readonly string[];
  readonly sections: SectionRecord[];
  readonly start: number;
  readonly startedAt: number;
  readonly units: ParsedUnit[];
}

function appendLimitedSectionRecord(args: AppendLimitedSectionRecordArgs): boolean {
  const limit = shouldStop(args.startedAt, args.options, args.units.length);
  const stopped = limitDiagnostic(args.input, limit);
  if (stopped !== undefined) {
    args.diagnostics.push(stopped);
    return false;
  }
  appendSectionRecord(
    args.sections,
    args.units,
    args.input,
    args.sectionPath,
    args.start,
    args.end,
  );
  return true;
}

function buildUnsectionedSections(
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
  end: number,
): SectionBuildResult {
  const sections: SectionRecord[] = [];
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  appendLimitedSectionRecord({
    diagnostics,
    end,
    input,
    options,
    sectionPath: [],
    sections,
    start: 0,
    startedAt,
    units,
  });
  return { sections, units, diagnostics };
}

interface AppendLeadingPreambleSectionArgs {
  readonly diagnostics: ParserDiagnostic[];
  readonly headings: readonly HeadingEntry[];
  readonly input: ParserSelectionInput;
  readonly offsets: { readonly starts: readonly number[]; readonly end: number };
  readonly options: ParserOptions;
  readonly sections: SectionRecord[];
  readonly startedAt: number;
  readonly units: ParsedUnit[];
}

function appendLeadingPreambleSection(args: AppendLeadingPreambleSectionArgs): boolean {
  const firstHeading = args.headings[0];
  if (firstHeading === undefined) {
    return true;
  }
  const firstHeadingStart = args.offsets.starts[firstHeading.index] ?? 0;
  if (firstHeadingStart > 0) {
    return appendLimitedSectionRecord({
      diagnostics: args.diagnostics,
      end: firstHeadingStart,
      input: args.input,
      options: args.options,
      sectionPath: [],
      sections: args.sections,
      start: 0,
      startedAt: args.startedAt,
      units: args.units,
    });
  }
  return true;
}

interface OpenHeading {
  readonly level: number;
  readonly text: string;
}

interface HeadingSectionState {
  readonly sections: SectionRecord[];
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly offsets: { readonly starts: readonly number[]; readonly end: number };
  /** Enclosing headings of the current one, shallowest first. */
  readonly stack: OpenHeading[];
}

function appendHeadingSection(
  state: HeadingSectionState,
  current: HeadingEntry,
  next: HeadingEntry | undefined,
): boolean {
  // A heading closes every open heading of its own or a deeper level, whatever levels were
  // skipped in between: after H1, H3, H3 the second H3 sits under the H1, not under the first H3.
  const level = current.paragraph.headingLevel;
  while ((state.stack.at(-1)?.level ?? -1) >= level) state.stack.pop();
  state.stack.push({ level, text: current.paragraph.text });
  const start = state.offsets.starts[current.index] ?? 0;
  const end =
    next === undefined
      ? state.offsets.end
      : (state.offsets.starts[next.index] ?? state.offsets.end);
  return appendLimitedSectionRecord({
    diagnostics: state.diagnostics,
    end,
    input: state.input,
    options: state.options,
    sectionPath: state.stack.map((heading) => heading.text),
    sections: state.sections,
    start,
    startedAt: state.startedAt,
    units: state.units,
  });
}

function appendHeadingSections(
  state: HeadingSectionState,
  headings: readonly HeadingEntry[],
): void {
  for (const [i, current] of headings.entries()) {
    if (!appendHeadingSection(state, current, headings[i + 1])) {
      return;
    }
  }
}

function buildSections(
  paragraphs: readonly Paragraph[],
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): SectionBuildResult {
  const stack: OpenHeading[] = [];
  const sections: SectionRecord[] = [];
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const offsets = layoutOfBlocks(paragraphs);
  const headings = collectHeadings(paragraphs);

  if (headings.length === 0) {
    return buildUnsectionedSections(input, options, startedAt, offsets.end);
  }
  if (
    !appendLeadingPreambleSection({
      diagnostics,
      headings,
      input,
      offsets,
      options,
      sections,
      startedAt,
      units,
    })
  ) {
    return { sections, units, diagnostics };
  }

  appendHeadingSections(
    { sections, units, diagnostics, input, options, startedAt, offsets, stack },
    headings,
  );
  return { sections, units, diagnostics };
}

function docxNoTextResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  notes: readonly ParserDiagnostic[],
): ParserResult {
  return emptyResult(
    capability,
    input.documentId,
    options,
    [
      diagnostic(
        "UNSUPPORTED_FORMAT",
        "docx has no extractable text content",
        input.documentId,
        "info",
      ),
      ...notes,
    ],
    [unsupportedMediaUnit(input.documentId, "docx-no-text")],
  );
}

function docxParseResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  paragraphs: readonly Paragraph[],
  diagnostics: readonly ParserDiagnostic[],
  startedAt: number,
): InternalParserResult {
  const built = buildSections(paragraphs, input, options, startedAt);
  const normalizedText = joinBlocks(paragraphs);
  return {
    documentId: input.documentId,
    parser: parserIdentity(capability),
    pages: [],
    sections: built.sections,
    units: built.units,
    diagnostics: [...diagnostics, ...built.diagnostics],
    extractedAt: options.now(),
    normalizedText,
  };
}

// ─── Failures ────────────────────────────────────────────────────────────────

function oversizedPartDiagnostic(input: ParserSelectionInput): ParserDiagnostic {
  return diagnostic(
    "OVERSIZED_FILE",
    "docx part exceeds the inflated size limit of the parser",
    input.documentId,
    "info",
  );
}

// KEIKO-0428: the catch surface distinguishes the scan-budget stop from every other reject
// path so the diagnostic code matches the shared shouldStop deadline outcome. Kept as its own
// helper so asyncParse's cyclomatic complexity stays within the repo bar.
function docxAsyncParseError(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  error: unknown,
): ParserResult {
  const failure = classifyOoxmlZipError(error);
  if (failure === "cancelled") {
    return emptyResult(capability, input.documentId, options, [
      diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info"),
    ]);
  }
  if (failure === "budget") {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "PARSER_TIMEOUT",
        "docx zip scan exceeded budget before word/document.xml was reached",
        input.documentId,
        "info",
      ),
    ]);
  }
  if (isOoxmlEntryOversized(error)) {
    return emptyResult(capability, input.documentId, options, [oversizedPartDiagnostic(input)]);
  }
  return emptyResult(capability, input.documentId, options, [
    diagnostic(
      "MALFORMED_INPUT",
      "docx parser rejected malformed or unsupported document",
      input.documentId,
      "error",
    ),
  ]);
}

function docxPreflightRefusal(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult | undefined {
  if (input.bytes.byteLength > options.maxBytes) {
    return emptyResult(capability, input.documentId, options, [
      oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
    ]);
  }
  if (options.signal?.aborted === true) {
    return cancelled(capability, input, options);
  }
  return encryptedOoxmlRefusal(capability, input, options, "docx");
}

async function asyncParse(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): Promise<ParserResult> {
  const refusal = docxPreflightRefusal(capability, input, options);
  if (refusal !== undefined) return refusal;

  const startedAt = options.now();
  try {
    const parts = await readOoxmlZipEntries(input.bytes, options, startedAt, docxZipPlan(options));
    const limit = shouldStop(startedAt, options, 0);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      return emptyResult(capability, input.documentId, options, [
        diagnostic(limit.code, limit.message, input.documentId, "info"),
      ]);
    }
    const parsed = parseParagraphs(parts, input, options, startedAt);
    if (parsed.paragraphs.length === 0) {
      if (parsed.diagnostics.some((entry) => entry.severity !== "info")) {
        return emptyResult(capability, input.documentId, options, parsed.diagnostics);
      }
      return docxNoTextResult(capability, input, options, parsed.diagnostics);
    }
    return docxParseResult(
      capability,
      input,
      options,
      parsed.paragraphs,
      parsed.diagnostics,
      startedAt,
    );
  } catch (error) {
    return docxAsyncParseError(capability, input, options, error);
  }
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  dependencyVersions: DEPENDENCY_VERSIONS,
  matches: isDocx,
});

export const docxParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
