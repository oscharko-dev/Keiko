import { Buffer } from "node:buffer";

import type {
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import yauzl from "yauzl";

import { diagnostic, emptyResult, oversizeDiagnostic, shouldStop } from "./_internal.js";
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
const DOCX_MEDIA =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCUMENT_XML_ENTRY = "word/document.xml";
const HEADING_STYLE_PATTERN = /<w:pStyle\b[^>]*w:val="Heading([1-6])"/i;
const PARAGRAPH_PATTERN = /<w:p\b[\s\S]*?<\/w:p>/gi;
const TEXT_RUN_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;

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
    input.extension.toLowerCase() === "docx" || input.mediaType.toLowerCase() === DOCX_MEDIA
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
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, decodeStrings: true }, (error, zip) => {
      if (error !== null) {
        reject(toError(error, "failed to open docx zip"));
        return;
      }
      resolve(zip);
    });
  });
}

function readEntryText(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(toError(error, "failed to open docx entry stream"));
        return;
      }
      const readStream = stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      readStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      readStream.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      readStream.on("error", (streamError: Error) => {
        reject(streamError);
      });
    });
  });
}

function readDocumentXmlFromZip(zip: ZipFileLike): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const resolveOnce = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
      resolve(value);
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
      rejectOnce(new Error("docx missing word/document.xml"));
    };

    const onError = (error: unknown): void => {
      rejectOnce(toError(error, "failed to read docx zip"));
    };

    const handleEntry = async (entry: yauzl.Entry): Promise<void> => {
      if (entry.fileName !== DOCUMENT_XML_ENTRY) {
        zip.readEntry();
        return;
      }
      try {
        const xml = await readEntryText(zip as yauzl.ZipFile, entry);
        resolveOnce(xml);
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

async function readDocumentXml(bytes: Uint8Array): Promise<string> {
  const zip = (await openZip(bytes)) as ZipFileLike;
  try {
    return await readDocumentXmlFromZip(zip);
  } finally {
    closeZipQuietly(zip);
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

interface Paragraph {
  readonly text: string;
  readonly headingLevel?: number;
}

function headingLevelOf(paragraphXml: string): number | undefined {
  const match = HEADING_STYLE_PATTERN.exec(paragraphXml);
  return match?.[1] === undefined ? undefined : Number(match[1]);
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

function parseParagraphs(xml: string): readonly Paragraph[] {
  const out: Paragraph[] = [];
  for (const match of xml.matchAll(PARAGRAPH_PATTERN)) {
    const paragraphXml = match[0];
    const text = paragraphText(paragraphXml);
    if (text.length === 0) continue;
    const headingLevel = headingLevelOf(paragraphXml);
    out.push(headingLevel === undefined ? { text } : { text, headingLevel });
  }
  return out;
}

interface HeadingParagraph extends Paragraph {
  readonly headingLevel: number;
}

interface HeadingEntry {
  readonly paragraph: HeadingParagraph;
  readonly index: number;
}

function paragraphStarts(paragraphs: readonly Paragraph[]): { readonly starts: readonly number[]; readonly end: number } {
  const starts: number[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    starts.push(cursor);
    cursor += paragraph.text.length + 1;
  }
  return { starts, end: Math.max(0, cursor - 1) };
}

function isHeadingEntry(
  entry: { readonly paragraph: Paragraph; readonly index: number },
): entry is HeadingEntry {
  return entry.paragraph.headingLevel !== undefined;
}

function collectHeadings(paragraphs: readonly Paragraph[]): readonly HeadingEntry[] {
  return paragraphs.map((paragraph, index) => ({ paragraph, index })).filter(isHeadingEntry);
}

function unsupportedMediaUnit(documentId: ParserSelectionInput["documentId"], reason: string): ParsedUnit {
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

function unsectionedRecords(
  input: ParserSelectionInput,
  end: number,
): { readonly sections: readonly SectionRecord[]; readonly units: readonly ParsedUnit[] } {
  const sectionRecord: SectionRecord = {
    documentId: input.documentId,
    sectionPath: [],
    characterStart: 0,
    characterEnd: end,
  };
  return {
    sections: [sectionRecord],
    units: [sectionUnit(sectionRecord)],
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

function appendLeadingPreambleSection(
  sections: SectionRecord[],
  units: ParsedUnit[],
  input: ParserSelectionInput,
  headings: readonly HeadingEntry[],
  offsets: { readonly starts: readonly number[]; readonly end: number },
): void {
  const firstHeading = headings[0];
  if (firstHeading === undefined) {
    return;
  }
  const firstHeadingStart = offsets.starts[firstHeading.index] ?? 0;
  if (firstHeadingStart > 0) {
    appendSectionRecord(sections, units, input, [], 0, firstHeadingStart);
  }
}

function buildSections(
  paragraphs: readonly Paragraph[],
  input: ParserSelectionInput,
): { readonly sections: readonly SectionRecord[]; readonly units: readonly ParsedUnit[] } {
  const stack: string[] = [];
  const sections: SectionRecord[] = [];
  const units: ParsedUnit[] = [];
  const offsets = paragraphStarts(paragraphs);
  const headings = collectHeadings(paragraphs);

  if (headings.length === 0) {
    return unsectionedRecords(input, offsets.end);
  }
  appendLeadingPreambleSection(sections, units, input, headings, offsets);

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    if (current === undefined) {
      continue;
    }
    const next = headings[i + 1];
    const level = current.paragraph.headingLevel;
    while (stack.length >= level) stack.pop();
    stack.push(current.paragraph.text);
    const start = offsets.starts[current.index] ?? 0;
    const end = next === undefined ? offsets.end : (offsets.starts[next.index] ?? offsets.end);
    appendSectionRecord(sections, units, input, [...stack], start, end);
  }

  return { sections, units };
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
    [diagnostic("UNSUPPORTED_FORMAT", "docx has no extractable text content", input.documentId, "info")],
    [unsupportedMediaUnit(input.documentId, "docx-no-text")],
  );
}

function docxParseResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  paragraphs: readonly Paragraph[],
): InternalParserResult {
  const { sections, units } = buildSections(paragraphs, input);
  const normalizedText = paragraphs.map((paragraph) => paragraph.text).join("\n");
  return {
    documentId: input.documentId,
    parser: { parserId: capability.parserId, parserVersion: capability.parserVersion },
    pages: [],
    sections,
    units,
    diagnostics: [] satisfies ParserDiagnostic[],
    extractedAt: options.now(),
    normalizedText,
  };
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
    return cancelled(capability, input, options);
  }

  const startedAt = options.now();
  try {
    const xml = await readDocumentXml(input.bytes);
    const limit = shouldStop(startedAt, options, 0);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      return emptyResult(capability, input.documentId, options, [
        diagnostic(limit.code, limit.message, input.documentId, "info"),
      ]);
    }
    const paragraphs = parseParagraphs(xml);
    if (paragraphs.length === 0) {
      return docxNoTextResult(capability, input, options);
    }
    return docxParseResult(capability, input, options, paragraphs);
  } catch (error) {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "MALFORMED_INPUT",
        error instanceof Error ? error.message : "failed to parse docx",
        input.documentId,
        "error",
      ),
    ]);
  }
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  matches: isDocx,
});

export const docxParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
