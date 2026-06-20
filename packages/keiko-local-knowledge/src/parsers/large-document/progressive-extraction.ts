// Progressive (page-windowed) extraction contract + driver for bounded large-document
// ingestion (Epic #1160, Issue #1286).
//
// This contract coexists with the existing full-buffer `ParserAdapter`/`AsyncParserAdapter`
// contracts. A `ProgressiveExtractor` yields the document as an ordered sequence of bounded
// `ProgressiveExtractionWindow` values. The driver `runProgressiveExtraction` pulls one window
// at a time, hands it to a sink that persists it durably, and never retains more than one
// window's text — so the extraction working set does not scale with document size.
//
// The `ProgressiveExtractionSource` abstracts byte access: a `loadFullBuffer` source backs the
// real PDF strategy (pdfjs-dist requires the whole buffer to open a document — see the
// architecture doc), while a `readWindow` source backs truly-streaming inputs that never
// materialize the whole document (used by the bounded-RSS regression).

import type {
  CoverageQuality,
  DocumentId,
  LargeDocumentExtractionStrategy,
  LargeDocumentResourcePolicy,
  PageRecord,
  ParsedUnit,
  ParserDependencyVersion,
  ParserDiagnostic,
} from "@oscharko-dev/keiko-contracts";
import { LARGE_DOCUMENT_DIAGNOSTIC_CODES } from "@oscharko-dev/keiko-contracts";

import { largeDocumentDiagnostic } from "./diagnostics.js";

// ─── Byte source ──────────────────────────────────────────────────────────────
export interface ProgressiveExtractionSource {
  readonly totalBytes: number;
  // Whole-buffer load for parsers that cannot stream (pdfjs-dist). Omitted by streaming sources.
  readonly loadFullBuffer?: () => Promise<Uint8Array>;
  // Bounded windowed read for native-streaming sources. Returns the bytes in
  // [startByte, startByte + length).
  readonly readWindow?: (startByte: number, length: number) => Promise<Uint8Array>;
}

// ─── Window ───────────────────────────────────────────────────────────────────
export interface ProgressiveExtractionWindow {
  readonly windowIndex: number;
  // Pages contained in this window. Character offsets are document-relative.
  readonly pages: readonly PageRecord[];
  readonly units: readonly ParsedUnit[];
  // The exact text to append to the document's persisted text so the concatenation of every
  // window's text equals the full normalized text. Bounded to this window; the driver flushes
  // it before requesting the next window.
  readonly text: string;
  // Document-relative character offset where this window's text begins.
  readonly characterStart: number;
  // Cumulative count of parser objects scanned through the end of this window.
  readonly objectCursor: number;
  // The 1-based page number of the last page in this window (resume cursor anchor).
  readonly lastPageNumber: number;
  readonly diagnostics: readonly ParserDiagnostic[];
}

// ─── Options ──────────────────────────────────────────────────────────────────
export interface ProgressiveExtractionOptions {
  readonly documentId: DocumentId;
  readonly extension: string;
  readonly mediaType: string;
  readonly policy: LargeDocumentResourcePolicy;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  // Resume: the extractor skips pages at or before this page number and continues from the
  // recorded character offset so document-relative offsets stay aligned.
  readonly resumeFromPage?: number;
  readonly resumeCharacterStart?: number;
  readonly resumeWindowIndex?: number;
  readonly resumeObjectCursor?: number;
  readonly resumeExtractedTextBytes?: number;
}

// ─── Extractor ────────────────────────────────────────────────────────────────
export interface ProgressiveExtractor {
  readonly strategyId: LargeDocumentExtractionStrategy;
  readonly parserVersion: string;
  readonly dependencyVersions?: readonly ParserDependencyVersion[];
  readonly matches: (input: { readonly extension: string; readonly mediaType: string }) => boolean;
  readonly extractWindows: (
    source: ProgressiveExtractionSource,
    options: ProgressiveExtractionOptions,
  ) => AsyncIterable<ProgressiveExtractionWindow>;
}

// ─── Sink + summary ───────────────────────────────────────────────────────────
export interface ProgressiveExtractionSink {
  // Persists one window durably (append text, pages, units, chunks) and advances the
  // checkpoint. MUST NOT retain the window text past the call.
  readonly onWindow: (window: ProgressiveExtractionWindow) => Promise<void> | void;
}

export type ProgressiveStopReason =
  | "completed"
  | "cancelled"
  | "extracted-text-limit"
  | "object-limit"
  | "unit-limit"
  | "timeout";

export interface ProgressiveExtractionSummary {
  readonly pageCount: number;
  readonly windowCount: number;
  readonly extractedTextBytes: number;
  readonly objectCursor: number;
  readonly lastPageNumber: number;
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly stopReason: ProgressiveStopReason;
  readonly coverage: CoverageQuality;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface DriveState {
  pageCount: number;
  windowCount: number;
  extractedTextBytes: number;
  objectCursor: number;
  lastPageNumber: number;
}

// Evaluates the policy against the state that *would* result from accepting `window`. Returns a
// stop reason when the window would breach a bound, so the over-limit window is never persisted.
function limitStop(
  state: DriveState,
  window: ProgressiveExtractionWindow,
  options: ProgressiveExtractionOptions,
  startedAt: number,
): ProgressiveStopReason | undefined {
  const { policy } = options;
  if (isAborted(options.signal)) return "cancelled";
  if (options.now() - startedAt > policy.maxWallClockMs) return "timeout";
  if (state.extractedTextBytes + utf8ByteLength(window.text) > policy.maxExtractedTextBytes) {
    return "extracted-text-limit";
  }
  if (
    state.extractedTextBytes + utf8ByteLength(window.text) >
    policy.maxPersistedStorageGrowthBytes
  ) {
    return "extracted-text-limit";
  }
  if (window.objectCursor > policy.maxParserObjects) return "object-limit";
  if (state.pageCount + window.pages.length > policy.maxParserUnits) return "unit-limit";
  return undefined;
}

function stopDiagnostic(
  reason: ProgressiveStopReason,
  documentId: DocumentId,
): ParserDiagnostic | undefined {
  switch (reason) {
    case "extracted-text-limit":
    case "object-limit":
    case "unit-limit":
      return largeDocumentDiagnostic(
        LARGE_DOCUMENT_DIAGNOSTIC_CODES.RESOURCE_POLICY_EXCEEDED,
        `extraction stopped at the ${reason} resource bound; document indexed with partial coverage`,
        documentId,
        "warning",
      );
    case "timeout":
      return largeDocumentDiagnostic(
        LARGE_DOCUMENT_DIAGNOSTIC_CODES.RESOURCE_POLICY_EXCEEDED,
        "extraction stopped at the wall-clock deadline; document indexed with partial coverage",
        documentId,
        "warning",
      );
    case "cancelled":
    case "completed":
      return undefined;
  }
}

function hasPartialCoverageWarning(diagnostics: readonly ParserDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.severity !== "info" &&
      (diagnostic.code === LARGE_DOCUMENT_DIAGNOSTIC_CODES.PARTIAL_COVERAGE ||
        diagnostic.code === LARGE_DOCUMENT_DIAGNOSTIC_CODES.OCR_CAPABILITY_UNAVAILABLE ||
        diagnostic.code === LARGE_DOCUMENT_DIAGNOSTIC_CODES.MULTIMODAL_CAPABILITY_UNAVAILABLE),
  );
}

function coverageFor(
  stopReason: ProgressiveStopReason,
  pageCount: number,
  diagnostics: readonly ParserDiagnostic[],
): CoverageQuality {
  if (pageCount === 0) return "none";
  if (hasPartialCoverageWarning(diagnostics)) return "partial";
  if (stopReason === "completed") return "complete";
  if (stopReason === "cancelled") return "partial";
  // A resource/timeout stop means useful text was indexed but the document was truncated.
  return "partial";
}

function appendDiagnostics(
  target: ParserDiagnostic[],
  diagnostics: readonly ParserDiagnostic[],
): void {
  target.push(...diagnostics);
}

// Pulls windows one at a time, enforces the resource policy between windows, and flushes each
// window through the sink. Returns a content-free summary. The driver never holds more than one
// window's text in memory.
export async function runProgressiveExtraction(
  extractor: ProgressiveExtractor,
  source: ProgressiveExtractionSource,
  options: ProgressiveExtractionOptions,
  sink: ProgressiveExtractionSink,
): Promise<ProgressiveExtractionSummary> {
  const startedAt = options.now();
  const diagnostics: ParserDiagnostic[] = [];
  const state: DriveState = {
    pageCount: options.resumeFromPage ?? 0,
    windowCount: options.resumeWindowIndex ?? 0,
    extractedTextBytes: options.resumeExtractedTextBytes ?? utf8ByteLength(""),
    objectCursor: options.resumeObjectCursor ?? 0,
    lastPageNumber: options.resumeFromPage ?? 0,
  };
  let stopReason: ProgressiveStopReason = "completed";

  for await (const window of extractor.extractWindows(source, options)) {
    const stop = limitStop(state, window, options, startedAt);
    if (stop !== undefined) {
      stopReason = stop;
      break;
    }
    appendDiagnostics(diagnostics, window.diagnostics);
    state.pageCount += window.pages.length;
    state.windowCount += 1;
    state.extractedTextBytes += utf8ByteLength(window.text);
    state.objectCursor = window.objectCursor;
    state.lastPageNumber = window.lastPageNumber;

    await sink.onWindow(window);

    // Re-check cancellation between sink flushes so cancellation lands within one window.
    if (isAborted(options.signal)) {
      stopReason = "cancelled";
      break;
    }
  }

  const stopDiag = stopDiagnostic(stopReason, options.documentId);
  if (stopDiag !== undefined) diagnostics.push(stopDiag);

  return {
    pageCount: state.pageCount,
    windowCount: state.windowCount,
    extractedTextBytes: state.extractedTextBytes,
    objectCursor: state.objectCursor,
    lastPageNumber: state.lastPageNumber,
    diagnostics,
    stopReason,
    coverage: coverageFor(stopReason, state.pageCount, diagnostics),
  };
}
