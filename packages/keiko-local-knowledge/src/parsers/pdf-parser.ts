import type {
  PageRecord,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { diagnostic, emptyResult, oversizeDiagnostic, shouldStop } from "./_internal.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "pdf";
const PARSER_VERSION = "1";
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

interface PdfTextItem {
  readonly str?: string;
}

interface PdfTextContent {
  readonly items: readonly PdfTextItem[];
}

interface PdfPageLike {
  readonly getTextContent: () => Promise<PdfTextContent>;
}

interface PdfDocumentLike {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfPageLike>;
}

interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function isPdf(input: ParserSelectionInput): boolean {
  return (
    input.extension.toLowerCase() === "pdf" ||
    input.mediaType.toLowerCase() === "application/pdf" ||
    hasPdfMagic(input.bytes)
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
          "pdf parser requires async caller; use parseAsync via discovery",
          input.documentId,
          "info",
        ),
      ],
      [unsupportedMediaUnit(input.documentId, "pdf-async-required")],
    );
  };
}

function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentLike> {
  const task = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    verbosity: 0,
  }) as unknown as PdfLoadingTaskLike;
  return task.promise;
}

function unsupportedMediaUnit(documentId: ParserSelectionInput["documentId"], reason: string): ParsedUnit {
  return { kind: "unsupported-media", documentId, reason };
}

function pageUnit(page: PageRecord): ParsedUnit {
  return page.pageLabel === undefined
    ? {
        kind: "page",
        documentId: page.documentId,
        pageNumber: page.pageNumber,
        characterStart: page.characterStart,
        characterEnd: page.characterEnd,
      }
    : {
        kind: "page",
        documentId: page.documentId,
        pageNumber: page.pageNumber,
        pageLabel: page.pageLabel,
        characterStart: page.characterStart,
        characterEnd: page.characterEnd,
      };
}

function normalisePageText(items: readonly PdfTextItem[]): string {
  const tokens: string[] = [];
  for (const item of items) {
    const value = item.str?.trim();
    if (value !== undefined && value.length > 0) {
      tokens.push(value);
    }
  }
  return tokens.join(" ").trim();
}

function appendPageRecord(
  pages: PageRecord[],
  units: ParsedUnit[],
  input: ParserSelectionInput,
  pageNumber: number,
  text: string,
  cursor: number,
): number {
  const pageStart = cursor;
  const pageEnd = cursor + text.length;
  const pageLabel = String(pageNumber);
  const pageRecord: PageRecord = {
    documentId: input.documentId,
    pageNumber,
    pageLabel,
    characterStart: pageStart,
    characterEnd: pageEnd,
  };
  pages.push(pageRecord);
  units.push(pageUnit(pageRecord));
  return pageEnd + 2;
}

function noTextResult(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  diagnostics: readonly ParserDiagnostic[] = [],
): ParserResult {
  if (diagnostics.length > 0) {
    return emptyResult(capability, input.documentId, options, diagnostics);
  }
  return emptyResult(
    capability,
    input.documentId,
    options,
    [diagnostic("UNSUPPORTED_FORMAT", "pdf has no extractable text layer", input.documentId, "info")],
    [unsupportedMediaUnit(input.documentId, "pdf-no-text-layer")],
  );
}

async function extractPages(
  doc: PdfDocumentLike,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): Promise<{
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly pages: readonly PageRecord[];
  readonly units: readonly ParsedUnit[];
  readonly pageTexts: readonly string[];
}> {
  const diagnostics: ParserDiagnostic[] = [];
  const pages: PageRecord[] = [];
  const units: ParsedUnit[] = [];
  const pageTexts: string[] = [];
  let cursor = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop) {
      if (limit.code !== undefined && limit.message !== undefined) {
        diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      }
      break;
    }

    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalisePageText(content.items);
    if (text.length === 0) {
      continue;
    }
    pageTexts.push(text);
    cursor = appendPageRecord(pages, units, input, pageNumber, text, cursor);
  }

  return { diagnostics, pages, units, pageTexts };
}

async function asyncParse(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): Promise<InternalParserResult> {
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
    const doc = await loadPdfDocument(input.bytes);
    const { diagnostics, pages, units, pageTexts } = await extractPages(doc, input, options, startedAt);

    if (isAborted(options.signal)) {
      return cancelled(capability, input, options);
    }
    if (pages.length === 0) {
      return noTextResult(capability, input, options, diagnostics);
    }

    return {
      documentId: input.documentId,
      parser: { parserId: capability.parserId, parserVersion: capability.parserVersion },
      pages,
      sections: [],
      units,
      diagnostics,
      extractedAt: options.now(),
      normalizedText: pageTexts.join("\n\n"),
    } satisfies InternalParserResult;
  } catch (error) {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "MALFORMED_INPUT",
        error instanceof Error ? error.message : "failed to parse pdf",
        input.documentId,
        "error",
      ),
    ]);
  }
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  matches: isPdf,
});

export const pdfParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
