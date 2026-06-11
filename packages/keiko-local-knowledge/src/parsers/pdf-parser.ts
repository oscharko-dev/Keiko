import type {
  PageRecord,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";

import {
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

const PARSER_ID = "pdf";
const PARSER_VERSION = "1";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "pdfjs-dist", version: "6.0.227" }),
  Object.freeze({ packageName: "@napi-rs/canvas", version: "1.0.0" }),
]);
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

export interface PdfTextItem {
  readonly str?: string;
}

export interface PdfTextContentChunk {
  readonly items: readonly PdfTextItem[];
}

export interface PdfPageLike {
  readonly streamTextContent: () => ReadableStream<PdfTextContentChunk>;
}

export interface PdfDocumentLike {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfPageLike>;
}

interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
}

interface PdfJsModule {
  readonly getDocument: (params: {
    readonly data: Uint8Array;
    readonly useWorkerFetch: false;
    readonly verbosity: 0;
  }) => PdfLoadingTaskLike;
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

async function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentLike> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
  const task = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    verbosity: 0,
  });
  return task.promise;
}

function unsupportedMediaUnit(
  documentId: ParserSelectionInput["documentId"],
  reason: string,
): ParsedUnit {
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

interface PageTextReadState {
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly emittedUnits: number;
  readonly scannedObjects: number;
}

interface PageTextReadResult {
  readonly text: string;
  readonly scannedObjects: number;
  readonly diagnostic?: ParserDiagnostic;
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

function pageTextStopDiagnostic(state: PageTextReadState): ParserDiagnostic | undefined {
  if (state.scannedObjects >= state.options.maxObjectsPerDocument) {
    return objectLimitDiagnostic(state.input.documentId, state.options.maxObjectsPerDocument);
  }
  return limitDiagnostic(
    state.input,
    shouldStop(state.startedAt, state.options, state.emittedUnits),
  );
}

function appendPdfTextItems(
  tokens: string[],
  items: readonly PdfTextItem[],
  state: PageTextReadState,
): { readonly state: PageTextReadState; readonly diagnostic?: ParserDiagnostic } {
  let next = state;
  for (const item of items) {
    const stopped = pageTextStopDiagnostic(next);
    if (stopped !== undefined) {
      return { state: next, diagnostic: stopped };
    }
    next = { ...next, scannedObjects: next.scannedObjects + 1 };
    const value = item.str?.trim();
    if (value !== undefined && value.length > 0) {
      tokens.push(value);
    }
  }
  return { state: next };
}

async function cancelTextReader(
  reader: ReadableStreamDefaultReader<PdfTextContentChunk>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Stream cancellation is best-effort cleanup after parser limits have already fired.
  }
}

async function readPageText(
  page: PdfPageLike,
  state: PageTextReadState,
): Promise<PageTextReadResult> {
  const reader = page.streamTextContent().getReader();
  const tokens: string[] = [];
  let next = state;
  try {
    for (;;) {
      const stopped = pageTextStopDiagnostic(next);
      if (stopped !== undefined) {
        await cancelTextReader(reader);
        return {
          text: tokens.join(" ").trim(),
          scannedObjects: next.scannedObjects,
          diagnostic: stopped,
        };
      }
      const read = await reader.read();
      if (read.done) {
        return { text: tokens.join(" ").trim(), scannedObjects: next.scannedObjects };
      }
      const chunk = read.value;
      const appended = appendPdfTextItems(tokens, chunk.items, next);
      next = appended.state;
      if (appended.diagnostic !== undefined) {
        await cancelTextReader(reader);
        return {
          text: tokens.join(" ").trim(),
          scannedObjects: next.scannedObjects,
          diagnostic: appended.diagnostic,
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
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
    [
      diagnostic(
        "UNSUPPORTED_FORMAT",
        "pdf has no extractable text layer",
        input.documentId,
        "info",
      ),
    ],
    [unsupportedMediaUnit(input.documentId, "pdf-no-text-layer")],
  );
}

export async function extractPages(
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
  let scannedObjects = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop) {
      if (limit.code !== undefined && limit.message !== undefined) {
        diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      }
      break;
    }

    const page = await doc.getPage(pageNumber);
    const textResult = await readPageText(page, {
      input,
      options,
      startedAt,
      emittedUnits: units.length,
      scannedObjects,
    });
    scannedObjects = textResult.scannedObjects;
    if (textResult.diagnostic !== undefined) {
      diagnostics.push(textResult.diagnostic);
      break;
    }
    if (textResult.text.length === 0) {
      continue;
    }
    pageTexts.push(textResult.text);
    cursor = appendPageRecord(pages, units, input, pageNumber, textResult.text, cursor);
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
    const { diagnostics, pages, units, pageTexts } = await extractPages(
      doc,
      input,
      options,
      startedAt,
    );

    if (isAborted(options.signal)) {
      return cancelled(capability, input, options);
    }
    if (pages.length === 0) {
      return noTextResult(capability, input, options, diagnostics);
    }

    return {
      documentId: input.documentId,
      parser: parserIdentity(capability),
      pages,
      sections: [],
      units,
      diagnostics,
      extractedAt: options.now(),
      normalizedText: pageTexts.join("\n\n"),
    } satisfies InternalParserResult;
  } catch {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "MALFORMED_INPUT",
        "pdf parser rejected malformed or unsupported document",
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
  matches: isPdf,
});

export const pdfParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
