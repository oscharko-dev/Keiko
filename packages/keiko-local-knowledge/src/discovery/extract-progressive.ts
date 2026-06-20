// Progressive large-document extraction wiring (Epic #1160, Issue #1286).
//
// Routes a preflight-classified large document through the page-windowed ProgressiveExtractor and
// persists each window in its own transaction so the JS working set never holds the whole document
// text and an interrupted job leaves durable, resumable progress. Extracted text is stored as
// bounded per-window rows (document_text_windows) instead of a single document_texts column; the
// orchestrator's bounded chunk/embed pass reads it back through readDocumentTextSpan.
//
// Extraction itself is re-run wholesale on resume (it is deterministic and cheap relative to
// embedding); the expensive chunking/embedding resume happens at chunk granularity in the
// orchestrator. The checkpoint records the phase/cursors so cancellation has a visible state.

import { createHash } from "node:crypto";

import type {
  CheckpointFingerprint,
  CoverageQuality,
  DocumentId,
  DocumentRecord,
  EmbeddingModelIdentity,
  ExtractionCapabilityAvailability,
  ExtractionPhase,
  LargeDocumentExtractionStrategy,
  LargeDocumentResourcePolicy,
  ParserDiagnostic,
} from "@oscharko-dev/keiko-contracts";
import { largeDocumentPolicyFingerprint } from "@oscharko-dev/keiko-contracts";

import { getCapsule } from "../capsule-lifecycle.js";
import {
  runProgressiveExtraction,
  type ProgressiveExtractionOptions,
  type ProgressiveExtractionSource,
  type ProgressiveExtractionSummary,
  type ProgressiveExtractionWindow,
  type ProgressiveExtractor,
} from "../parsers/index.js";
import { upsertExtractionCheckpoint } from "../indexing/checkpoint-persist.js";
import type { KnowledgeStore } from "../store.js";
import { basenameOf, extensionOf, mediaTypeFor } from "./media-type.js";
import {
  deleteDependentRows,
  insertDiagnosticRow,
  insertDocumentRow,
  insertDocumentTextWindowRow,
  insertPageRow,
  insertParsedUnitRow,
  updateDocumentStatusRow,
} from "./persist.js";
import { documentIdFor, type ExtractionResult } from "./types.js";
import type { ExtractDocumentDeps, ExtractDocumentParams } from "./extract.js";

export interface ProgressiveExtractContext {
  readonly policy: LargeDocumentResourcePolicy;
  readonly capabilities: ExtractionCapabilityAvailability;
  readonly extractors: readonly ProgressiveExtractor[];
  readonly jobId: string;
  readonly chunkingStrategyVersion: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly signal?: AbortSignal;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function selectProgressiveExtractor(
  context: ProgressiveExtractContext,
  extension: string,
  mediaType: string,
): ProgressiveExtractor | undefined {
  return context.extractors.find((e) => e.matches({ extension, mediaType }));
}

// A bounded byte source: pdfjs needs the whole buffer, so the bytes are read once and cached.
// readWindow lets a streaming/synthetic extractor slice without re-reading.
function cachedBufferSource(bytes: Uint8Array): ProgressiveExtractionSource {
  return {
    totalBytes: bytes.byteLength,
    loadFullBuffer: () => Promise.resolve(bytes),
    readWindow: (start, len) => Promise.resolve(bytes.subarray(start, start + len)),
  };
}

interface SinkDeps {
  readonly store: KnowledgeStore;
  readonly capsuleId: ExtractDocumentParams["capsuleId"];
  readonly sourceId: string;
  readonly documentId: DocumentId;
  readonly jobId: string;
  readonly strategy: LargeDocumentExtractionStrategy;
  readonly fingerprint: CheckpointFingerprint;
  readonly now: () => number;
}

interface SinkState {
  unitIndex: number;
  pageCursor: number;
  objectCursor: number;
  extractedTextBytes: number;
}

function checkpointFor(
  deps: SinkDeps,
  state: SinkState,
  phase: ExtractionPhase,
  coverage: CoverageQuality,
  diagnostics: readonly ParserDiagnostic[],
): void {
  const at = deps.now();
  upsertExtractionCheckpoint(deps.store._internal.db, {
    capsuleId: deps.capsuleId,
    documentId: deps.documentId,
    jobId: deps.jobId,
    strategy: deps.strategy,
    phase,
    pageCursor: state.pageCursor,
    sectionCursor: 0,
    objectCursor: state.objectCursor,
    extractedTextBytes: state.extractedTextBytes,
    chunkCursor: 0,
    embeddedChunkCursor: 0,
    retryCount: 0,
    coverage,
    fingerprint: deps.fingerprint,
    terminalDiagnostics: diagnostics,
    createdAt: at,
    updatedAt: at,
  });
}

// Persists one window in its own transaction: pages + parsed units + the bounded text window, then
// advances the checkpoint. Never retains more than this window's text.
function persistWindow(
  deps: SinkDeps,
  state: SinkState,
  window: ProgressiveExtractionWindow,
): void {
  const db = deps.store._internal.db;
  db.exec("BEGIN");
  try {
    for (const page of window.pages) insertPageRow(db, deps.capsuleId, page);
    for (const unit of window.units) {
      insertParsedUnitRow(
        db,
        deps.capsuleId,
        `${String(deps.documentId)}#u${String(state.unitIndex)}`,
        unit,
      );
      state.unitIndex += 1;
    }
    insertDocumentTextWindowRow(db, {
      capsuleId: deps.capsuleId,
      documentId: deps.documentId,
      windowIndex: window.windowIndex,
      characterStart: window.characterStart,
      characterEnd: window.characterStart + window.text.length,
      normalizedText: window.text,
    });
    state.pageCursor = window.lastPageNumber;
    state.objectCursor = window.objectCursor;
    state.extractedTextBytes += Buffer.byteLength(window.text, "utf8");
    checkpointFor(deps, state, "extracting", "partial", []);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function persistDiagnostics(deps: SinkDeps, diagnostics: readonly ParserDiagnostic[]): void {
  const db = deps.store._internal.db;
  diagnostics.forEach((diagnostic, index) => {
    insertDiagnosticRow(db, {
      id: `${String(deps.documentId)}#d${String(index)}`,
      capsuleId: deps.capsuleId,
      diagnostic: { ...diagnostic, documentId: deps.documentId },
      createdAt: deps.now(),
    });
  });
}

function documentStatusFor(summary: ProgressiveExtractionSummary): DocumentRecord["status"] {
  if (summary.stopReason === "cancelled") return "pending";
  return summary.pageCount > 0 ? "extracted" : "unsupported";
}

function finalizePhaseFor(summary: ProgressiveExtractionSummary): ExtractionPhase {
  if (summary.stopReason === "cancelled") return "cancelled";
  return "extracted";
}

// Finalizes a progressive extraction: updates the document status, persists redacted diagnostics,
// and writes the terminal extraction checkpoint with the measured coverage.
function finalize(
  deps: SinkDeps,
  state: SinkState,
  summary: ProgressiveExtractionSummary,
  diagnostics: readonly ParserDiagnostic[],
): DocumentRecord["status"] {
  const db = deps.store._internal.db;
  const status = documentStatusFor(summary);
  db.exec("BEGIN");
  try {
    updateDocumentStatusRow(db, deps.capsuleId, deps.documentId, status);
    persistDiagnostics(deps, diagnostics);
    checkpointFor(deps, state, finalizePhaseFor(summary), summary.coverage, diagnostics);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
  return status;
}

function buildFingerprint(
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  contentHash: string,
  embeddingIdentity: EmbeddingModelIdentity,
): CheckpointFingerprint {
  return {
    sourceContentHash: contentHash,
    parserVersion: `${extractor.strategyId}@${extractor.parserVersion}`,
    policyFingerprint: largeDocumentPolicyFingerprint(context.policy),
    chunkingStrategyVersion: context.chunkingStrategyVersion,
    embeddingIdentity,
  };
}

function progressiveDocumentRecord(
  params: ExtractDocumentParams,
  documentId: DocumentId,
  extractor: ProgressiveExtractor,
  contentHash: string,
  status: DocumentRecord["status"],
  now: number,
): DocumentRecord {
  return {
    id: documentId,
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    documentPath: params.file.relativePath,
    sizeBytes: params.file.sizeBytes,
    mediaType: mediaTypeFor(extensionOf(params.file.relativePath)),
    contentHash,
    parser:
      extractor.dependencyVersions === undefined
        ? { parserId: extractor.strategyId, parserVersion: extractor.parserVersion }
        : {
            parserId: extractor.strategyId,
            parserVersion: extractor.parserVersion,
            dependencyVersions: extractor.dependencyVersions,
          },
    lastExtractedAt: now,
    status,
    safeDisplayName: basenameOf(params.file.relativePath),
  };
}

function progressiveResult(
  params: ExtractDocumentParams,
  document: DocumentRecord,
  summary: ProgressiveExtractionSummary,
): ExtractionResult {
  if (summary.stopReason === "cancelled") {
    return {
      capsuleId: params.capsuleId,
      sourceId: params.source.id,
      relativePath: params.file.relativePath,
      outcome: {
        kind: "failed",
        document,
        error: {
          code: "CANCELLED",
          message: "progressive extraction cancelled with persisted partial progress",
          relativePath: params.file.relativePath,
        },
      },
      diagnostics: summary.diagnostics,
    };
  }
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome: { kind: "persisted", document },
    diagnostics: summary.diagnostics,
  };
}

// Inserts the document row (pending) and clears prior dependents/windows before the first window so
// the page/parsed-unit foreign keys resolve and a re-extract is idempotent.
function insertPendingDocument(
  sinkDeps: SinkDeps,
  params: ExtractDocumentParams,
  extractor: ProgressiveExtractor,
  contentHash: string,
  state: SinkState,
): void {
  const db = sinkDeps.store._internal.db;
  db.exec("BEGIN");
  try {
    insertDocumentRow(db, {
      id: sinkDeps.documentId,
      capsuleId: params.capsuleId,
      sourceId: sinkDeps.sourceId,
      documentPath: params.file.relativePath,
      sizeBytes: params.file.sizeBytes,
      mediaType: mediaTypeFor(extensionOf(params.file.relativePath)),
      contentHash,
      parserId: extractor.strategyId,
      parserVersion: extractor.parserVersion,
      lastExtractedAt: sinkDeps.now(),
      status: "pending",
      safeDisplayName: basenameOf(params.file.relativePath),
    });
    deleteDependentRows(db, params.capsuleId, sinkDeps.documentId);
    checkpointFor(sinkDeps, state, "extracting", "none", []);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function extractionOptionsFor(
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  documentId: DocumentId,
  now: () => number,
): ProgressiveExtractionOptions {
  const extension = extensionOf(params.file.relativePath);
  return {
    documentId,
    extension,
    mediaType: mediaTypeFor(extension),
    policy: context.policy,
    now,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

function buildSinkDeps(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  documentId: DocumentId,
  contentHash: string,
): SinkDeps {
  const capsule = getCapsule(deps.store, params.capsuleId);
  if (capsule === undefined) {
    throw new Error(
      `progressive extraction requires an existing capsule: ${String(params.capsuleId)}`,
    );
  }
  return {
    store: deps.store,
    capsuleId: params.capsuleId,
    sourceId: String(params.source.id),
    documentId,
    jobId: context.jobId,
    strategy: extractor.strategyId,
    fingerprint: buildFingerprint(context, extractor, contentHash, capsule.embeddingModelIdentity),
    now: deps.store._internal.now,
  };
}

// Runs the page-windowed progressive extraction for one large document and persists it bounded.
// `bytes` are read once by the caller (pdfjs requires the whole buffer); the extracted text, pages,
// and checkpoints are flushed per window so peak memory does not scale with the document.
export async function extractDocumentProgressive(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  bytes: Uint8Array,
  extractor: ProgressiveExtractor,
): Promise<ExtractionResult> {
  const now = deps.store._internal.now;
  const documentId = documentIdFor({
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: context.relativePath,
  });
  const contentHash = hashBytes(bytes);
  const sinkDeps = buildSinkDeps(deps, params, context, extractor, documentId, contentHash);
  const state: SinkState = { unitIndex: 0, pageCursor: 0, objectCursor: 0, extractedTextBytes: 0 };
  insertPendingDocument(sinkDeps, params, extractor, contentHash, state);

  const summary = await runProgressiveExtraction(
    extractor,
    cachedBufferSource(bytes),
    extractionOptionsFor(params, context, documentId, now),
    {
      onWindow: (window): void => {
        persistWindow(sinkDeps, state, window);
      },
    },
  );

  const status = finalize(sinkDeps, state, summary, summary.diagnostics);
  const document = progressiveDocumentRecord(
    params,
    documentId,
    extractor,
    contentHash,
    status,
    now(),
  );
  return progressiveResult(params, document, summary);
}
