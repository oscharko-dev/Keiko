// Progressive PDF text-layer extractor (Epic #1160, Issue #1286).
//
// Reuses the existing pdfjs loader and per-page streaming text reader from `pdf-parser.ts`; the
// only behavior change is that pages are emitted in bounded windows instead of accumulated into
// one result. pdfjs-dist requires the whole byte buffer to open a document (documented upstream
// limitation), so the source's `loadFullBuffer` is used — but the extracted text, page records,
// and (downstream) chunks are flushed per window, so the extraction working set does not grow
// with document size and useful work begins after the first window.
//
// No-text-layer pages degrade gracefully: when an injected OCR capability is available, the
// page's OCR text is indexed with page provenance; otherwise a content-free partial-coverage
// quality warning is recorded and the page is skipped. Missing OCR never fails the job.

import type {
  DocumentId,
  ExtractionCapabilityStatus,
  ParserDependencyVersion,
  ParserDiagnostic,
} from "@oscharko-dev/keiko-contracts";
import { LARGE_DOCUMENT_DIAGNOSTIC_CODES } from "@oscharko-dev/keiko-contracts";

import { buildParserOptions } from "../registry.js";
import { loadPdfDocument, readPageText, type PdfDocumentLike } from "../pdf-parser.js";
import type { OcrPageResult } from "../ocr/types.js";
import type { ParserOptions, ParserSelectionInput } from "../types.js";

import { largeDocumentDiagnostic } from "./diagnostics.js";
import type {
  ProgressiveExtractionOptions,
  ProgressiveExtractionSource,
  ProgressiveExtractionWindow,
  ProgressiveExtractor,
} from "./progressive-extraction.js";
import { WindowTextBuilder } from "./window-builder.js";

const PARSER_ID = "progressive-pdf";
const PARSER_VERSION = "1";
const DEPENDENCY_VERSIONS: readonly ParserDependencyVersion[] = Object.freeze([
  Object.freeze({ packageName: "pdfjs-dist", version: "6.0.227" }),
]);

export type OcrPageFn = (input: {
  readonly pageNumber: number;
  readonly bytes: Uint8Array;
}) => Promise<OcrPageResult>;

export interface ProgressivePdfExtractorDeps {
  // Injectable so unit tests drive a fake PdfDocumentLike without real PDF bytes / pdfjs.
  readonly loadDocument?: (bytes: Uint8Array) => Promise<PdfDocumentLike>;
  // Optional OCR capability. When `status` is "available" the `ocrPage` adapter is consulted for
  // no-text-layer pages and its text is indexed with page provenance.
  readonly ocr?: { readonly status: ExtractionCapabilityStatus; readonly ocrPage: OcrPageFn };
}

function selectionInput(documentId: DocumentId): ParserSelectionInput {
  return {
    documentId,
    bytes: new Uint8Array(0),
    extension: "pdf",
    mediaType: "application/pdf",
  };
}

function parserOptionsFromPolicy(options: ProgressiveExtractionOptions): ParserOptions {
  const base: Partial<ParserOptions> = {
    maxBytes: options.policy.maxRawFileBytes,
    maxUnitsPerDocument: options.policy.maxParserUnits,
    maxObjectsPerDocument: options.policy.maxParserObjects,
    timeoutMs: options.policy.maxWallClockMs,
    now: options.now,
  };
  return buildParserOptions(
    options.signal === undefined ? base : { ...base, signal: options.signal },
  );
}

async function ocrTextForPage(
  deps: ProgressivePdfExtractorDeps,
  documentId: DocumentId,
  pageNumber: number,
): Promise<{ readonly text?: string; readonly diagnostic: ParserDiagnostic }> {
  if (deps.ocr?.status !== "available") {
    return {
      diagnostic: largeDocumentDiagnostic(
        LARGE_DOCUMENT_DIAGNOSTIC_CODES.OCR_CAPABILITY_UNAVAILABLE,
        "page has no extractable text layer and no OCR capability is configured; indexed with partial coverage",
        documentId,
        "warning",
        pageNumber,
      ),
    };
  }
  // A no-text-layer page needs a rasterized image for OCR. Keiko does not bundle a rasterizer, so
  // production OCR remains an injected capability; the injected adapter receives the page number
  // and returns text in tests. The empty byte view is the documented placeholder for the page
  // image the rasterizer would supply.
  const result = await deps.ocr.ocrPage({ pageNumber, bytes: new Uint8Array(0) });
  if (result.ok && result.text.trim().length > 0) {
    return { text: result.text, diagnostic: ocrIndexedDiagnostic(documentId, pageNumber) };
  }
  return {
    diagnostic: largeDocumentDiagnostic(
      LARGE_DOCUMENT_DIAGNOSTIC_CODES.PARTIAL_COVERAGE,
      "OCR returned no text for a no-text-layer page; indexed with partial coverage",
      documentId,
      "warning",
      pageNumber,
    ),
  };
}

function ocrIndexedDiagnostic(documentId: DocumentId, pageNumber: number): ParserDiagnostic {
  return largeDocumentDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.PARTIAL_COVERAGE,
    "page text recovered through the injected OCR capability with page provenance",
    documentId,
    "info",
    pageNumber,
  );
}

interface PageReadOutcome {
  readonly text?: string;
  readonly scannedObjects: number;
  readonly diagnostics: readonly ParserDiagnostic[];
}

// Internal extraction context: the public deps plus the per-run document id.
interface PdfExtractContext extends ProgressivePdfExtractorDeps {
  readonly documentId: DocumentId;
}

// Reads a single page's text layer, falling back to the injected OCR capability for no-text-layer
// pages. Never throws; capability gaps become content-free quality warnings.
async function readOrOcrPage(
  doc: PdfDocumentLike,
  pageNumber: number,
  ctx: PdfExtractContext,
  parserOptions: ParserOptions,
  startedAt: number,
  emittedUnits: number,
  scannedObjects: number,
): Promise<PageReadOutcome> {
  const page = await doc.getPage(pageNumber);
  const read = await readPageText(page, {
    input: selectionInput(ctx.documentId),
    options: parserOptions,
    startedAt,
    emittedUnits,
    scannedObjects,
  });
  const diagnostics: ParserDiagnostic[] = [];
  if (read.diagnostic !== undefined) diagnostics.push(read.diagnostic);
  if (read.text.length > 0) {
    return { text: read.text, scannedObjects: read.scannedObjects, diagnostics };
  }
  const ocr = await ocrTextForPage(ctx, ctx.documentId, pageNumber);
  diagnostics.push(ocr.diagnostic);
  return ocr.text === undefined
    ? { scannedObjects: read.scannedObjects, diagnostics }
    : { text: ocr.text, scannedObjects: read.scannedObjects, diagnostics };
}

interface PdfDriveState {
  cursor: number;
  anyPageEmitted: boolean;
  scannedObjects: number;
  emittedUnits: number;
  windowIndex: number;
}

async function extractPdfWindow(
  doc: PdfDocumentLike,
  firstPage: number,
  lastPage: number,
  state: PdfDriveState,
  ctx: PdfExtractContext,
  parserOptions: ParserOptions,
  startedAt: number,
): Promise<ProgressiveExtractionWindow> {
  const builder = new WindowTextBuilder(ctx.documentId, state.cursor, state.anyPageEmitted);
  const diagnostics: ParserDiagnostic[] = [];
  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
    const outcome = await readOrOcrPage(
      doc,
      pageNumber,
      ctx,
      parserOptions,
      startedAt,
      state.emittedUnits,
      state.scannedObjects,
    );
    state.scannedObjects = outcome.scannedObjects;
    diagnostics.push(...outcome.diagnostics);
    if (outcome.text !== undefined && outcome.text.length > 0) {
      builder.addPage(pageNumber, outcome.text);
      state.emittedUnits += 1;
    }
  }
  state.cursor = builder.nextCursor;
  state.anyPageEmitted = builder.hasEmittedAnyPage;
  const window: ProgressiveExtractionWindow = {
    windowIndex: state.windowIndex,
    pages: builder.snapshotPages(),
    units: builder.snapshotUnits(),
    text: builder.text(),
    characterStart: builder.characterStart,
    objectCursor: state.scannedObjects,
    lastPageNumber: lastPage,
    diagnostics,
  };
  state.windowIndex += 1;
  return window;
}

async function* pdfExtractWindows(
  loadDocument: (bytes: Uint8Array) => Promise<PdfDocumentLike>,
  ctx: PdfExtractContext,
  source: ProgressiveExtractionSource,
  options: ProgressiveExtractionOptions,
): AsyncIterable<ProgressiveExtractionWindow> {
  if (source.loadFullBuffer === undefined) return;
  const parserOptions = parserOptionsFromPolicy(options);
  const bytes = await source.loadFullBuffer();
  const doc = await loadDocument(bytes);
  const resumeFromPage = options.resumeFromPage ?? 0;
  const windowPages = Math.max(1, options.policy.extractionWindowPages);
  const startedAt = options.now();
  const state: PdfDriveState = {
    cursor: options.resumeCharacterStart ?? 0,
    anyPageEmitted: resumeFromPage > 0,
    scannedObjects: 0,
    emittedUnits: 0,
    windowIndex: 0,
  };
  for (let firstPage = resumeFromPage + 1; firstPage <= doc.numPages; firstPage += windowPages) {
    if (options.signal?.aborted === true) return;
    const lastPage = Math.min(firstPage + windowPages - 1, doc.numPages);
    yield extractPdfWindow(doc, firstPage, lastPage, state, ctx, parserOptions, startedAt);
  }
}

export function createProgressivePdfExtractor(
  deps: ProgressivePdfExtractorDeps = {},
): ProgressiveExtractor {
  const loadDocument = deps.loadDocument ?? loadPdfDocument;
  return {
    strategyId: "progressive-pdf",
    parserVersion: PARSER_VERSION,
    dependencyVersions: DEPENDENCY_VERSIONS,
    matches: (input) =>
      input.extension.toLowerCase() === "pdf" ||
      input.mediaType.toLowerCase() === "application/pdf",
    extractWindows: (source, options) =>
      pdfExtractWindows(loadDocument, { ...deps, documentId: options.documentId }, source, options),
  };
}

export const PROGRESSIVE_PDF_PARSER_ID = PARSER_ID;
export const PROGRESSIVE_PDF_PARSER_VERSION = PARSER_VERSION;
export const PROGRESSIVE_PDF_DEPENDENCY_VERSIONS = DEPENDENCY_VERSIONS;
