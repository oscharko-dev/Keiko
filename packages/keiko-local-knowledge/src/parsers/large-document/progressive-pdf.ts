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

import { emitPageReadFailure } from "../../indexing/page-read-activity.js";
import { knowledgeErrorKind } from "../../knowledge-log.js";
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
  endsInOpenHyphen,
  hasPageContent,
  joinAcrossPages,
  openingOfRun,
  type PageEdge,
  type PageLayout,
} from "../pdf-layout.js";
import type { OcrPageResult } from "../ocr/types.js";
import type { ParserOptions, ParserSelectionInput } from "../types.js";

import { largeDocumentDiagnostic } from "./diagnostics.js";
import type {
  ProgressiveExtractionLog,
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

// Internal extraction context: the public deps plus the per-run document id and log port.
interface PdfExtractContext extends ProgressivePdfExtractorDeps {
  readonly documentId: DocumentId;
  readonly log: ProgressiveExtractionLog | undefined;
}

// Without a wired port the line is lost and counted as lost; these values never reach a file.
const UNWIRED_LOG_CONTEXT: ProgressiveExtractionLog["context"] = {
  jobId: "unwired",
  capsuleIdDigest: "0000000000000000",
  documentIdDigest: "0000000000000000",
};

// One broken page never ends the document, so nothing above this layer learns of the failure. This
// line keeps its classified cause under the job's correlation; never its message or the page text.
function recordPageReadFailure(
  ctx: PdfExtractContext,
  stage: "window" | "resume",
  pageNumber: number,
  cause: unknown,
): void {
  emitPageReadFailure(ctx.log?.sink, {
    context: ctx.log?.context ?? UNWIRED_LOG_CONTEXT,
    stage,
    pageNumber,
    failureKind: knowledgeErrorKind(cause),
  });
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
  } catch (cause) {
    recordPageReadFailure(ctx, "window", pageNumber, cause);
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

// A page before the resume point that cannot be read again costs no text: its text is stored. All a
// run can lose is that the paragraph going on behind the resume point starts a new block.
function unreadableBeforeResumeDiagnostic(
  documentId: DocumentId,
  pageNumber: number,
): ParserDiagnostic {
  return largeDocumentDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.PARTIAL_COVERAGE,
    "page before the resume point could not be read again; a paragraph over the resume point may be split",
    documentId,
    "info",
    pageNumber,
  );
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
  // What the extractor has to say about pages it read again before the first window it emits.
  pendingDiagnostics: readonly ParserDiagnostic[];
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

async function addComposedPages(
  builder: WindowTextBuilder,
  outcomes: readonly PageReadOutcome[],
  args: {
    readonly doc: PdfDocumentLike;
    readonly firstPage: number;
    readonly lastPage: number;
    readonly state: PdfDriveState;
    readonly ctx: PdfExtractContext;
    readonly parserOptions: ParserOptions;
    readonly startedAt: number;
    readonly pageLabels: readonly (string | null)[];
    readonly diagnostics: ParserDiagnostic[];
  },
): Promise<void> {
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
  const texts = placed.map(({ text }) => text);
  const edges = placed.map(({ edge }) => edge);
  const next = endsInOpenHyphen(texts, edges)
    ? await openingAfterWindow(args.doc, args, composed.furniture)
    : undefined;
  const joined = joinAcrossPages(texts, edges, args.state.lastEdge, next);
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
  const { firstPage, lastPage, state, ctx, parserOptions, startedAt } = options;
  const builder = new WindowTextBuilder(ctx.documentId, state.cursor, state.anyPageEmitted);
  const diagnostics: ParserDiagnostic[] = [...state.pendingDiagnostics];
  state.pendingDiagnostics = [];
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
  await addComposedPages(builder, outcomes, { ...options, doc, diagnostics });
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
    learnedFurniture: [...state.furniture],
  };
  state.windowIndex += 1;
  return window;
}

// A checkpoint carries what earlier windows learned, but no page edge: how a page ended is made of
// its text. The last window is read again, text layer only and emitting nothing, and composed with
// what it knew, which gives the edge a continuous run would hand on.
interface LayoutRead {
  readonly ctx: PdfExtractContext;
  readonly parserOptions: ParserOptions;
  readonly startedAt: number;
}

/** A page's text layer, read outside its own turn: it emits nothing and runs no OCR. */
async function layoutOutOfTurn(
  doc: PdfDocumentLike,
  pageNumber: number,
  read: LayoutRead,
): Promise<PageLayout | undefined> {
  const result = await readPageLayout(await doc.getPage(pageNumber), {
    input: selectionInput(read.ctx.documentId),
    options: read.parserOptions,
    startedAt: read.startedAt,
    emittedUnits: 0,
    scannedObjects: 0,
  });
  return hasPageContent(result.layout) ? result.layout : undefined;
}

/**
 * How the window after this one opens, composed as its own turn will compose it. A window is handed
 * on as it stands, so it has to know this when its last word may run over: the same word is spelled
 * the same way wherever a window happens to end. A page that cannot be read reports itself again in
 * its own turn, where it stops the paragraph, so here it stops the word too.
 */
async function openingAfterWindow(
  doc: PdfDocumentLike,
  args: LayoutRead & { readonly firstPage: number; readonly lastPage: number },
  furniture: ReadonlySet<string>,
): Promise<ReturnType<typeof openingOfRun>> {
  const windowPages = args.lastPage - args.firstPage + 1;
  const last = Math.min(args.lastPage + windowPages, doc.numPages);
  const pageNumbers = Array.from(
    { length: Math.max(0, last - args.lastPage) },
    (_, index) => args.lastPage + 1 + index,
  );
  const read = async (pageNumber: number): Promise<PageLayout | undefined> => {
    try {
      return await layoutOutOfTurn(doc, pageNumber, args);
    } catch (cause) {
      recordPageReadFailure(args.ctx, "window", pageNumber, cause);
      return undefined;
    }
  };
  const layouts = await Promise.all(pageNumbers.map((pageNumber) => read(pageNumber)));
  if (layouts[0] === undefined) return undefined;
  return openingOfRun(
    layouts.filter((layout) => layout !== undefined),
    furniture,
  );
}

async function edgeBeforeResume(
  doc: PdfDocumentLike,
  args: LayoutRead & {
    readonly resumeFromPage: number;
    readonly windowPages: number;
    readonly furniture: ReadonlySet<string>;
  },
): Promise<{
  readonly lastEdge: PageEdge | undefined;
  readonly diagnostics: readonly ParserDiagnostic[];
}> {
  const first = Math.max(1, args.resumeFromPage - args.windowPages + 1);
  const pageNumbers = Array.from(
    { length: args.resumeFromPage - first + 1 },
    (_, index) => first + index,
  );
  const diagnostics: ParserDiagnostic[] = [];
  const read = async (pageNumber: number): Promise<PageLayout | undefined> => {
    try {
      return await layoutOutOfTurn(doc, pageNumber, args);
    } catch (cause) {
      recordPageReadFailure(args.ctx, "resume", pageNumber, cause);
      diagnostics.push(unreadableBeforeResumeDiagnostic(args.ctx.documentId, pageNumber));
      return undefined;
    }
  };
  const layouts = await Promise.all(pageNumbers.map((pageNumber) => read(pageNumber)));
  const composed = composePages(
    layouts.filter((layout) => layout !== undefined),
    args.furniture,
  );
  return {
    // The page right before the resume point has an edge only if it has text.
    lastEdge: layouts.at(-1) === undefined ? undefined : composed.edges.at(-1),
    diagnostics,
  };
}

function initialDriveState(
  options: ProgressiveExtractionOptions,
  resumeFromPage: number,
): PdfDriveState {
  return {
    cursor: options.resumeCharacterStart ?? 0,
    // KEIKO-0172: seed from the caller-supplied prior-emitted flag when available; fall back
    // to the `resumeFromPage > 0` proxy for pre-migration checkpoints that do not carry it.
    // See ProgressiveExtractionOptions.resumeAnyPageEmitted for the full rationale.
    anyPageEmitted: options.resumeAnyPageEmitted ?? resumeFromPage > 0,
    scannedObjects: options.resumeObjectCursor ?? 0,
    // Every page counts one unit in a continuous run, so the pages before the resume point do too.
    emittedUnits: resumeFromPage,
    windowIndex: options.resumeWindowIndex ?? 0,
    furniture: new Set(options.resumeLearnedFurniture ?? []),
    lastEdge: undefined,
    pendingDiagnostics: [],
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
  const state = initialDriveState(options, resumeFromPage);
  if (resumeFromPage > 0) {
    const before = await edgeBeforeResume(doc, {
      ctx,
      parserOptions,
      startedAt,
      resumeFromPage,
      windowPages,
      furniture: state.furniture,
    });
    state.lastEdge = before.lastEdge;
    state.pendingDiagnostics = before.diagnostics;
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
      pdfExtractWindows(
        loadDocument,
        { ...deps, documentId: options.documentId, log: options.log },
        source,
        options,
      ),
  };
}

export const PROGRESSIVE_PDF_PARSER_ID = PARSER_ID;
export const PROGRESSIVE_PDF_PARSER_VERSION = PARSER_VERSION;
export const PROGRESSIVE_PDF_DEPENDENCY_VERSIONS = DEPENDENCY_VERSIONS;
