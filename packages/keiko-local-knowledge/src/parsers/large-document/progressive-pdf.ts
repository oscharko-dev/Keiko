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
// quality warning is recorded and an empty PageRecord is still emitted. Missing OCR never fails
// the job.

import type {
  DocumentId,
  ExtractionCapabilityStatus,
  ParserDependencyVersion,
  ParserDiagnostic,
} from "@oscharko-dev/keiko-contracts";
import { LARGE_DOCUMENT_DIAGNOSTIC_CODES } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-large-document";

import { buildParserOptions } from "../registry.js";
import {
  loadPdfDocumentFromSource,
  pageFurnitureDiagnostic,
  readPageLayout,
  type PageLayoutReadResult,
  type PdfDocumentLike,
} from "../pdf-parser.js";
import {
  composePages,
  hasPageContent,
  joinAcrossPages,
  type PageEdge,
  type PageLayout,
} from "../pdf-layout.js";
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
const PARSER_VERSION = "2";
const DEPENDENCY_VERSIONS: readonly ParserDependencyVersion[] = Object.freeze([
  Object.freeze({ packageName: "pdfjs-dist", version: "6.0.227" }),
]);

export type OcrPageFn = (input: {
  readonly pageNumber: number;
  readonly bytes: Uint8Array;
}) => Promise<OcrPageResult>;

export interface ProgressivePdfExtractorDeps {
  // Injectable so unit tests drive a fake PdfDocumentLike without real PDF bytes / pdfjs.
  readonly loadDocument?: (source: ProgressiveExtractionSource) => Promise<PdfDocumentLike>;
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
  // A page with a text layer carries its layout; a page OCR recovered carries OCR's text.
  readonly layout?: PageLayout;
  readonly text?: string;
  readonly scannedObjects: number;
  readonly diagnostics: readonly ParserDiagnostic[];
}

// Internal extraction context: the public deps plus the per-run document id.
interface PdfExtractContext extends ProgressivePdfExtractorDeps {
  readonly documentId: DocumentId;
}

// Reads a single page's text layer, falling back to the injected OCR capability for no-text-layer
// pages. A page that cannot be read becomes an empty page with a content-free warning: one broken
// page never ends the document, as it does not in the full-buffer route.
async function readOrOcrPage(
  doc: PdfDocumentLike,
  pageNumber: number,
  ctx: PdfExtractContext,
  parserOptions: ParserOptions,
  startedAt: number,
  emittedUnits: number,
  scannedObjects: number,
): Promise<PageReadOutcome> {
  let read: PageLayoutReadResult;
  try {
    const page = await doc.getPage(pageNumber);
    read = await readPageLayout(page, {
      input: selectionInput(ctx.documentId),
      options: parserOptions,
      startedAt,
      emittedUnits,
      scannedObjects,
    });
  } catch {
    return {
      scannedObjects,
      diagnostics: [unreadablePageDiagnostic(ctx.documentId, pageNumber)],
    };
  }
  const diagnostics: ParserDiagnostic[] = [];
  if (read.diagnostic !== undefined) diagnostics.push(read.diagnostic);
  if (hasPageContent(read.layout)) {
    return { layout: read.layout, scannedObjects: read.scannedObjects, diagnostics };
  }
  const ocr = await ocrTextForPage(ctx, ctx.documentId, pageNumber);
  diagnostics.push(ocr.diagnostic);
  return ocr.text === undefined
    ? { scannedObjects: read.scannedObjects, diagnostics }
    : { text: ocr.text, scannedObjects: read.scannedObjects, diagnostics };
}

function unreadablePageDiagnostic(documentId: DocumentId, pageNumber: number): ParserDiagnostic {
  return largeDocumentDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.PARTIAL_COVERAGE,
    "page text could not be read; indexed page provenance without text",
    documentId,
    "warning",
    pageNumber,
  );
}

interface PdfDriveState {
  cursor: number;
  anyPageEmitted: boolean;
  scannedObjects: number;
  emittedUnits: number;
  windowIndex: number;
  // What earlier windows of this run proved to be repeated page furniture.
  furniture: ReadonlySet<string>;
  // How the last page of the window before ended, for a paragraph that goes on behind it.
  lastEdge: PageEdge | undefined;
}

async function pageLabelsFor(doc: PdfDocumentLike): Promise<readonly (string | null)[]> {
  try {
    return (await doc.getPageLabels?.()) ?? [];
  } catch {
    return [];
  }
}

function pageLabelFor(labels: readonly (string | null)[], pageNumber: number): string | undefined {
  return labels[pageNumber - 1] ?? undefined;
}

interface ExtractPdfWindowOptions {
  readonly firstPage: number;
  readonly lastPage: number;
  readonly state: PdfDriveState;
  readonly ctx: PdfExtractContext;
  readonly parserOptions: ParserOptions;
  readonly startedAt: number;
  readonly pageLabels: readonly (string | null)[];
}

function addComposedPages(
  builder: WindowTextBuilder,
  outcomes: readonly PageReadOutcome[],
  args: {
    readonly firstPage: number;
    readonly state: PdfDriveState;
    readonly ctx: PdfExtractContext;
    readonly pageLabels: readonly (string | null)[];
    readonly diagnostics: ParserDiagnostic[];
  },
): void {
  const composed = composePages(
    outcomes.flatMap((outcome) => (outcome.layout === undefined ? [] : [outcome.layout])),
    args.state.furniture,
  );
  args.state.furniture = composed.furniture;
  const furnitureDiagnostic = pageFurnitureDiagnostic(args.ctx.documentId, composed.removedRows);
  if (furnitureDiagnostic !== undefined) args.diagnostics.push(furnitureDiagnostic);
  let composedIndex = 0;
  const placed = outcomes.map((outcome) => {
    if (outcome.layout === undefined) return { text: outcome.text ?? "", edge: undefined };
    const index = composedIndex;
    composedIndex += 1;
    return { text: composed.texts[index] ?? "", edge: composed.edges[index] };
  });
  const joined = joinAcrossPages(
    placed.map(({ text }) => text),
    placed.map(({ edge }) => edge),
    args.state.lastEdge,
  );
  args.state.lastEdge = joined.lastEdge;
  outcomes.forEach((_outcome, index) => {
    const pageNumber = args.firstPage + index;
    builder.addPage(
      pageNumber,
      joined.texts[index] ?? "",
      pageLabelFor(args.pageLabels, pageNumber),
      joined.separators[index],
    );
  });
}

async function extractPdfWindow(
  doc: PdfDocumentLike,
  options: ExtractPdfWindowOptions,
): Promise<ProgressiveExtractionWindow> {
  const { firstPage, lastPage, state, ctx, parserOptions, startedAt, pageLabels } = options;
  const builder = new WindowTextBuilder(ctx.documentId, state.cursor, state.anyPageEmitted);
  const diagnostics: ParserDiagnostic[] = [];
  const outcomes: PageReadOutcome[] = [];
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
    outcomes.push(outcome);
    state.emittedUnits += 1;
  }
  addComposedPages(builder, outcomes, { firstPage, state, ctx, pageLabels, diagnostics });
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

// A checkpoint carries no page furniture and no page edge, so a resumed run would otherwise start
// knowing nothing: it would keep the headers of a short last window that a continuous run removes,
// and end a paragraph at the resume point. The run before it is read again, text layer only and
// without emitting anything, to learn both back.
async function learnedBeforeResume(
  doc: PdfDocumentLike,
  args: {
    readonly ctx: PdfExtractContext;
    readonly parserOptions: ParserOptions;
    readonly startedAt: number;
    readonly resumeFromPage: number;
    readonly windowPages: number;
  },
): Promise<{ readonly furniture: ReadonlySet<string>; readonly lastEdge: PageEdge | undefined }> {
  const first = Math.max(1, args.resumeFromPage - args.windowPages + 1);
  const pageNumbers = Array.from(
    { length: args.resumeFromPage - first + 1 },
    (_, index) => first + index,
  );
  const read = async (pageNumber: number): Promise<PageLayout | undefined> => {
    try {
      const result = await readPageLayout(await doc.getPage(pageNumber), {
        input: selectionInput(args.ctx.documentId),
        options: args.parserOptions,
        startedAt: args.startedAt,
        emittedUnits: 0,
        scannedObjects: 0,
      });
      return hasPageContent(result.layout) ? result.layout : undefined;
    } catch {
      // A page that cannot be read teaches nothing; the window itself reports it when it is read.
      return undefined;
    }
  };
  const layouts = await Promise.all(pageNumbers.map((pageNumber) => read(pageNumber)));
  const composed = composePages(layouts.filter((layout) => layout !== undefined));
  return {
    furniture: composed.furniture,
    // The page right before the resume point has an edge only if it has text.
    lastEdge: layouts.at(-1) === undefined ? undefined : composed.edges.at(-1),
  };
}

async function* pdfExtractWindows(
  loadDocument: (source: ProgressiveExtractionSource) => Promise<PdfDocumentLike>,
  ctx: PdfExtractContext,
  source: ProgressiveExtractionSource,
  options: ProgressiveExtractionOptions,
): AsyncIterable<ProgressiveExtractionWindow> {
  const parserOptions = parserOptionsFromPolicy(options);
  const doc = await loadDocument(source);
  const pageLabels = await pageLabelsFor(doc);
  const resumeFromPage = options.resumeFromPage ?? 0;
  const windowPages = Math.max(1, options.policy.extractionWindowPages);
  const startedAt = options.now();
  const state: PdfDriveState = {
    cursor: options.resumeCharacterStart ?? 0,
    // KEIKO-0172: seed from the caller-supplied prior-emitted flag when available; fall back
    // to the `resumeFromPage > 0` proxy for pre-migration checkpoints that do not carry it.
    // See ProgressiveExtractionOptions.resumeAnyPageEmitted for the full rationale.
    anyPageEmitted: options.resumeAnyPageEmitted ?? resumeFromPage > 0,
    scannedObjects: options.resumeObjectCursor ?? 0,
    emittedUnits: 0,
    windowIndex: options.resumeWindowIndex ?? 0,
    furniture: new Set(),
    lastEdge: undefined,
  };
  if (resumeFromPage > 0) {
    const learned = await learnedBeforeResume(doc, {
      ctx,
      parserOptions,
      startedAt,
      resumeFromPage,
      windowPages,
    });
    state.furniture = learned.furniture;
    state.lastEdge = learned.lastEdge;
  }
  for (let firstPage = resumeFromPage + 1; firstPage <= doc.numPages; firstPage += windowPages) {
    if (options.signal?.aborted === true) return;
    const lastPage = Math.min(firstPage + windowPages - 1, doc.numPages);
    yield extractPdfWindow(doc, {
      firstPage,
      lastPage,
      state,
      ctx,
      parserOptions,
      startedAt,
      pageLabels,
    });
  }
}

export function createProgressivePdfExtractor(
  deps: ProgressivePdfExtractorDeps = {},
): ProgressiveExtractor {
  const loadDocument = deps.loadDocument ?? loadPdfDocumentFromSource;
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
