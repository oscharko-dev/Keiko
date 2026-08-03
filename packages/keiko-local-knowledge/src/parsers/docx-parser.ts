import { Buffer } from "node:buffer";

import type {
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts";
import yauzl from "yauzl";

import {
  decodeXmlEntities as decodeXmlEntitiesShared,
  diagnostic,
  emptyResult,
  objectLimitDiagnostic,
  oversizeDiagnostic,
  parserIdentity,
  shouldStop,
} from "./_internal.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "docx";
const PARSER_VERSION = "1";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "yauzl", version: "3.4.0" }),
]);
const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCUMENT_XML_ENTRY = "word/document.xml";
const FOOTNOTES_XML_ENTRY = "word/footnotes.xml";
const MAX_DOCUMENT_XML_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_XML_INFLATE_RATIO = 100;
const HEADING_STYLE_PATTERN = /<w:pStyle\b[^>]*w:val="Heading([1-6])"/i;
const PARAGRAPH_PATTERN = /<w:p\b[\s\S]*?<\/w:p>/gi;
const TEXT_RUN_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
const WORD_STRUCTURE_TAG_PATTERN = /<(\/?)w:(p|tbl|tr|tc)\b[^>]*>/giu;
const DOCX_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS);

interface ZipFileLike {
  readonly readEntry: () => void;
  readonly close: () => void;
  readonly openReadStream: (
    entry: yauzl.Entry,
    callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
  ) => void;
  readonly on: (event: string, listener: (...args: readonly unknown[]) => void) => ZipFileLike;
  readonly once: (event: string, listener: (...args: readonly unknown[]) => void) => ZipFileLike;
  readonly removeListener: (
    event: string,
    listener: (...args: readonly unknown[]) => void,
  ) => ZipFileLike;
}

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

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function closeZipQuietly(zip: ZipFileLike): void {
  try {
    zip.close();
  } catch {
    // Close failures are non-fatal during parser cleanup.
  }
}

function openZip(bytes: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true },
      (error, zip) => {
        if (error !== null) {
          reject(toError(error, "failed to open docx zip"));
          return;
        }
        resolve(zip);
      },
    );
  });
}

interface DocxZipLimits {
  readonly maxInflatedEntryBytes: number;
  readonly maxInflateRatio: number;
}

function maxInflatedEntryBytes(maxInputBytes: number): number {
  const inputCap = Math.max(1, Math.floor(maxInputBytes));
  return Math.min(MAX_DOCUMENT_XML_INFLATED_BYTES, inputCap * 10);
}

function assertEntryWithinLimits(entry: yauzl.Entry, limits: DocxZipLimits): void {
  if (entry.uncompressedSize > limits.maxInflatedEntryBytes) {
    throw new Error(
      `docx document.xml inflated size ${String(entry.uncompressedSize)} exceeds limit ${String(
        limits.maxInflatedEntryBytes,
      )}`,
    );
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > limits.maxInflateRatio
  ) {
    throw new Error("docx document.xml compression ratio exceeds limit");
  }
}

function destroyStream(readStream: NodeJS.ReadableStream, error: Error): void {
  const destroy = (readStream as { readonly destroy?: (cause?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(readStream, error);
  }
}

function readEntryText(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  limits: DocxZipLimits,
): Promise<string> {
  assertEntryWithinLimits(entry, limits);
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(toError(error, "failed to open docx entry stream"));
        return;
      }
      const readStream = stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      let inflatedBytes = 0;
      let settled = false;
      const rejectOnce = (streamError: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(streamError);
        destroyStream(readStream, streamError);
      };
      readStream.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        inflatedBytes += chunk.byteLength;
        if (inflatedBytes > limits.maxInflatedEntryBytes) {
          rejectOnce(new Error("docx document.xml inflated stream exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      readStream.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      readStream.on("error", (streamError: Error) => {
        rejectOnce(streamError);
      });
    });
  });
}

interface DocxXmlParts {
  readonly documentXml: string;
  readonly footnotesXml?: string;
}

function isDocxXmlEntry(name: string): boolean {
  return name === DOCUMENT_XML_ENTRY || name === FOOTNOTES_XML_ENTRY;
}

// eslint-disable-next-line max-lines-per-function
function readDocxXmlPartsFromZip(zip: ZipFileLike, limits: DocxZipLimits): Promise<DocxXmlParts> {
  // eslint-disable-next-line max-lines-per-function
  return new Promise((resolve, reject) => {
    const parts: { documentXml?: string; footnotesXml?: string } = {};
    let settled = false;

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      if (parts.documentXml === undefined) {
        rejectOnce(new Error("docx missing word/document.xml"));
        return;
      }
      settled = true;
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
      resolve({
        documentXml: parts.documentXml,
        ...(parts.footnotesXml ? { footnotesXml: parts.footnotesXml } : {}),
      });
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
      reject(error);
    };

    const onEnd = (): void => {
      resolveOnce();
    };

    const onError = (error: unknown): void => {
      rejectOnce(toError(error, "failed to read docx zip"));
    };

    const handleEntry = async (entry: yauzl.Entry): Promise<void> => {
      if (!isDocxXmlEntry(entry.fileName)) {
        zip.readEntry();
        return;
      }
      try {
        const xml = await readEntryText(zip as yauzl.ZipFile, entry, limits);
        if (entry.fileName === DOCUMENT_XML_ENTRY) {
          parts.documentXml = xml;
        } else {
          parts.footnotesXml = xml;
        }
        zip.readEntry();
      } catch (error) {
        rejectOnce(toError(error, "failed to read docx entry"));
      }
    };

    const onEntry = (entry: unknown): void => {
      void handleEntry(entry as yauzl.Entry);
    };

    zip.on("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

async function readDocxXmlParts(bytes: Uint8Array, maxInputBytes: number): Promise<DocxXmlParts> {
  const zip = (await openZip(bytes)) as ZipFileLike;
  try {
    return await readDocxXmlPartsFromZip(zip, {
      maxInflatedEntryBytes: maxInflatedEntryBytes(maxInputBytes),
      maxInflateRatio: MAX_DOCUMENT_XML_INFLATE_RATIO,
    });
  } finally {
    closeZipQuietly(zip);
  }
}

// GRD-027: delegate to the shared decoder so docx text runs also resolve numeric character
// references (smart quotes, accented letters) instead of surfacing literal `&#8217;`.
function decodeXmlEntities(value: string): string {
  return decodeXmlEntitiesShared(value);
}

interface Paragraph {
  readonly text: string;
  readonly headingLevel?: number;
}

interface ParagraphParseResult {
  readonly paragraphs: readonly Paragraph[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

interface SectionBuildResult {
  readonly sections: readonly SectionRecord[];
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

function limitDiagnostic(
  input: ParserSelectionInput,
  limit: ReturnType<typeof shouldStop>,
): ParserDiagnostic | undefined {
  if (!limit.stop || limit.code === undefined || limit.message === undefined) {
    return undefined;
  }
  return diagnostic(limit.code, limit.message, input.documentId, "info");
}

function headingLevelOf(paragraphXml: string): number | undefined {
  const match = HEADING_STYLE_PATTERN.exec(paragraphXml);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function isListParagraph(paragraphXml: string): boolean {
  return /<w:numPr\b/i.test(paragraphXml);
}

function paragraphText(paragraphXml: string): string {
  const withBreaks = paragraphXml
    .replaceAll(/<w:tab\s*\/>/gi, "\t")
    .replaceAll(/<w:br\s*\/>/gi, "\n")
    .replaceAll(/<w:cr\s*\/>/gi, "\n");
  const parts = Array.from(withBreaks.matchAll(TEXT_RUN_PATTERN))
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .filter((part) => part.length > 0);
  return parts.join("").trim();
}

function parseParagraphXml(paragraphXml: string): Paragraph | undefined {
  const text = paragraphText(paragraphXml);
  if (text.length === 0) return undefined;
  const headingLevel = headingLevelOf(paragraphXml);
  const projected =
    headingLevel === undefined && isListParagraph(paragraphXml) ? `- ${text}` : text;
  return headingLevel === undefined ? { text: projected } : { text: projected, headingLevel };
}

function bodyXml(xml: string): string {
  return /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/iu.exec(xml)?.[1] ?? xml;
}

function normalizeTableHeaders(cells: readonly string[]): readonly string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, index) => {
    const base = cell.trim().length > 0 ? cell.trim() : `Column ${String(index + 1)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} ${String(count + 1)}`;
  });
}

type WordElementName = "p" | "tbl" | "tr" | "tc";

interface WordXmlTag {
  readonly name: WordElementName;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly start: number;
  readonly end: number;
}

interface WordXmlElement {
  readonly name: WordElementName;
  readonly xml: string;
  readonly innerXml: string;
  readonly start: number;
  readonly end: number;
}

function wordElementName(value: string | undefined): WordElementName | undefined {
  if (value === "p" || value === "tbl" || value === "tr" || value === "tc") return value;
  return undefined;
}

function nextWordXmlTag(xml: string, from: number): WordXmlTag | undefined {
  WORD_STRUCTURE_TAG_PATTERN.lastIndex = from;
  const match = WORD_STRUCTURE_TAG_PATTERN.exec(xml);
  if (match === null) return undefined;
  const name = wordElementName(match[2]?.toLowerCase());
  if (name === undefined) return undefined;
  const raw = match[0];
  return {
    name,
    closing: match[1] === "/",
    selfClosing: raw.slice(0, -1).trimEnd().endsWith("/"),
    start: match.index,
    end: match.index + raw.length,
  };
}

function matchingWordElementEnd(xml: string, opening: WordXmlTag): WordXmlTag {
  let depth = 1;
  let cursor = opening.end;
  while (cursor < xml.length) {
    const tag = nextWordXmlTag(xml, cursor);
    if (tag === undefined) break;
    cursor = tag.end;
    if (tag.name !== opening.name || tag.selfClosing) continue;
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return tag;
  }
  throw new Error(`unterminated w:${opening.name} element`);
}

function extractWordElements(
  xml: string,
  names: ReadonlySet<WordElementName>,
): readonly WordXmlElement[] {
  const elements: WordXmlElement[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const opening = nextWordXmlTag(xml, cursor);
    if (opening === undefined) break;
    cursor = opening.end;
    if (opening.closing || opening.selfClosing || !names.has(opening.name)) continue;
    const closing = matchingWordElementEnd(xml, opening);
    elements.push({
      name: opening.name,
      xml: xml.slice(opening.start, closing.end),
      innerXml: xml.slice(opening.end, closing.start),
      start: opening.start,
      end: closing.end,
    });
    cursor = closing.end;
  }
  return elements;
}

const PARAGRAPH_ELEMENTS: ReadonlySet<WordElementName> = new Set(["p"]);
const TABLE_ELEMENTS: ReadonlySet<WordElementName> = new Set(["tbl"]);
const ROW_ELEMENTS: ReadonlySet<WordElementName> = new Set(["tr"]);
const CELL_ELEMENTS: ReadonlySet<WordElementName> = new Set(["tc"]);
const DOCUMENT_BLOCK_ELEMENTS: ReadonlySet<WordElementName> = new Set(["p", "tbl"]);

function removeNestedTables(cellXml: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const table of extractWordElements(cellXml, TABLE_ELEMENTS)) {
    parts.push(cellXml.slice(cursor, table.start));
    cursor = table.end;
  }
  parts.push(cellXml.slice(cursor));
  return parts.join("");
}

function cellText(cellXml: string): string {
  return extractWordElements(removeNestedTables(cellXml), PARAGRAPH_ELEMENTS)
    .map((paragraph) => paragraphText(paragraph.xml))
    .filter((part) => part.length > 0)
    .join(" ")
    .trim();
}

function projectTableRow(
  cells: readonly string[],
  rowIndex: number,
  headers: readonly string[],
): Paragraph {
  const projected = cells
    .map((cell, cellIndex) => {
      const fallbackLabel = `Column ${String(cellIndex + 1)}`;
      return `${headers[cellIndex] ?? fallbackLabel}=${cell}`;
    })
    .join(" | ");
  return { text: `Table row ${String(rowIndex + 1)}: ${projected}` };
}

type TableTraversalItem =
  | { readonly kind: "paragraph"; readonly paragraph: Paragraph }
  | { readonly kind: "table"; readonly tableXml: string };

function nestedTableItems(cells: readonly WordXmlElement[]): readonly TableTraversalItem[] {
  const items: TableTraversalItem[] = [];
  for (const cell of cells) {
    for (const nested of extractWordElements(cell.innerXml, TABLE_ELEMENTS)) {
      items.push({ kind: "table", tableXml: nested.innerXml });
    }
  }
  return items;
}

function tableTraversalItems(tableXml: string): readonly TableTraversalItem[] {
  const rows = extractWordElements(tableXml, ROW_ELEMENTS);
  const cellRows = rows.map((row) => extractWordElements(row.innerXml, CELL_ELEMENTS));
  const values = cellRows.map((cells) => cells.map((cell) => cellText(cell.innerXml)));
  const headerIsSchema =
    values.length > 1 && (values[0] ?? []).some((cell) => /[A-Za-z_ÄÖÜäöüß]/u.test(cell));
  const headers = headerIsSchema ? normalizeTableHeaders(values[0] ?? []) : [];
  const items: TableTraversalItem[] = [];
  let dataRowIndex = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (!headerIsSchema || rowIndex > 0) {
      items.push({
        kind: "paragraph",
        paragraph: projectTableRow(values[rowIndex] ?? [], dataRowIndex, headers),
      });
      dataRowIndex += 1;
    }
    items.push(...nestedTableItems(cellRows[rowIndex] ?? []));
  }
  return items;
}

function tableTreeRows(tableXml: string): readonly Paragraph[] {
  const pending: TableTraversalItem[] = [{ kind: "table", tableXml }];
  const paragraphs: Paragraph[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.kind === "paragraph") {
      paragraphs.push(current.paragraph);
      continue;
    }
    const items = tableTraversalItems(current.tableXml);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item !== undefined) pending.push(item);
    }
  }
  return paragraphs;
}

function parseDocumentBlocks(xml: string): readonly Paragraph[] {
  const body = bodyXml(xml);
  const blocks: Paragraph[] = [];
  for (const block of extractWordElements(body, DOCUMENT_BLOCK_ELEMENTS)) {
    if (block.name === "tbl") {
      blocks.push(...tableTreeRows(block.innerXml));
      continue;
    }
    const paragraph = parseParagraphXml(block.xml);
    if (paragraph !== undefined) blocks.push(paragraph);
  }
  return blocks;
}

function parseFootnotes(xml: string | undefined): readonly Paragraph[] {
  if (xml === undefined) return [];
  const out: Paragraph[] = [];
  for (const match of xml.matchAll(/<w:footnote\b[^>]*>[\s\S]*?<\/w:footnote>/gi)) {
    const footnoteXml = match[0];
    const tag = /^<w:footnote\b[^>]*>/iu.exec(footnoteXml)?.[0] ?? "";
    const id = /w:id="([^"]+)"/iu.exec(tag)?.[1];
    if (id === "-1" || id === "0") continue;
    const text = Array.from(footnoteXml.matchAll(PARAGRAPH_PATTERN))
      .map((paragraph) => paragraphText(paragraph[0]))
      .filter((part) => part.length > 0)
      .join(" ");
    if (text.length > 0) out.push({ text: `Footnote ${id ?? "?"}: ${text}` });
  }
  return out;
}

function parseParagraphs(
  xml: string,
  footnotesXml: string | undefined,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): ParagraphParseResult {
  const out: Paragraph[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  let scannedParagraphs = 0;
  const paragraphs = [...parseDocumentBlocks(xml), ...parseFootnotes(footnotesXml)];
  for (const paragraph of paragraphs) {
    if (scannedParagraphs >= options.maxObjectsPerDocument) {
      diagnostics.push(objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument));
      break;
    }
    const limit = shouldStop(startedAt, options, scannedParagraphs);
    const stopped = limitDiagnostic(input, limit);
    if (stopped !== undefined) {
      diagnostics.push(stopped);
      break;
    }
    scannedParagraphs += 1;
    out.push(paragraph);
  }
  return { paragraphs: out, diagnostics };
}

interface HeadingParagraph extends Paragraph {
  readonly headingLevel: number;
}

interface HeadingEntry {
  readonly paragraph: HeadingParagraph;
  readonly index: number;
}

function paragraphStarts(paragraphs: readonly Paragraph[]): {
  readonly starts: readonly number[];
  readonly end: number;
} {
  const starts: number[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    starts.push(cursor);
    cursor += paragraph.text.length + 1;
  }
  return { starts, end: Math.max(0, cursor - 1) };
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

interface HeadingSectionState {
  readonly sections: SectionRecord[];
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly offsets: { readonly starts: readonly number[]; readonly end: number };
  readonly stack: string[];
}

function appendHeadingSection(
  state: HeadingSectionState,
  current: HeadingEntry,
  next: HeadingEntry | undefined,
): boolean {
  const level = current.paragraph.headingLevel;
  while (state.stack.length >= level) state.stack.pop();
  state.stack.push(current.paragraph.text);
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
    sectionPath: [...state.stack],
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
  const stack: string[] = [];
  const sections: SectionRecord[] = [];
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const offsets = paragraphStarts(paragraphs);
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
  const normalizedText = paragraphs.map((paragraph) => paragraph.text).join("\n");
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

// eslint-disable-next-line max-lines-per-function
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
    return cancelled(capability, input, options);
  }

  const startedAt = options.now();
  try {
    const xmlParts = await readDocxXmlParts(input.bytes, options.maxBytes);
    const limit = shouldStop(startedAt, options, 0);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      return emptyResult(capability, input.documentId, options, [
        diagnostic(limit.code, limit.message, input.documentId, "info"),
      ]);
    }
    const parsed = parseParagraphs(
      xmlParts.documentXml,
      xmlParts.footnotesXml,
      input,
      options,
      startedAt,
    );
    if (parsed.paragraphs.length === 0) {
      if (parsed.diagnostics.length > 0) {
        return emptyResult(capability, input.documentId, options, parsed.diagnostics);
      }
      return docxNoTextResult(capability, input, options);
    }
    return docxParseResult(
      capability,
      input,
      options,
      parsed.paragraphs,
      parsed.diagnostics,
      startedAt,
    );
  } catch {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "MALFORMED_INPUT",
        "docx parser rejected malformed or unsupported document",
        input.documentId,
        "error",
      ),
    ]);
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
