// Progressive large-document extraction wiring (Epic #1160, Issue #1286).
//
// Routes a preflight-classified large document through the page-windowed ProgressiveExtractor and
// persists each window in its own transaction so the JS working set never holds the whole document
// text and an interrupted job leaves durable, resumable progress. Extracted text is stored as
// bounded per-window rows (document_text_windows) instead of a single document_texts column; the
// orchestrator's bounded chunk/embed pass reads it back through readDocumentTextSpan.
//
// Extraction resumes from the durable page/text-window checkpoint when the source, parser, policy,
// chunking, and embedding fingerprint remain compatible. Chunking/embedding resume still happens
// downstream through chunk/vector coverage reconciliation.

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
import {
  checkpointCompatibility,
  LARGE_DOCUMENT_DIAGNOSTIC_CODES,
  largeDocumentPolicyFingerprint,
} from "@oscharko-dev/keiko-contracts";

import { getCapsule } from "../capsule-lifecycle.js";
import {
  runProgressiveExtraction,
  type ProgressiveExtractionOptions,
  type ProgressiveExtractionSource,
  type ProgressiveExtractionSummary,
  type ProgressiveExtractionWindow,
  type ProgressiveExtractor,
} from "../parsers/index.js";
import {
  selectExtractionCheckpoint,
  upsertExtractionCheckpoint,
} from "../indexing/checkpoint-persist.js";
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
import { redactDiagnosticMessage } from "../privacy/diagnostic-redactor.js";

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

export function selectProgressiveExtractor(
  context: ProgressiveExtractContext,
  extension: string,
  mediaType: string,
): ProgressiveExtractor | undefined {
  return context.extractors.find((e) => e.matches({ extension, mediaType }));
}

interface SinkDeps {
  readonly store: KnowledgeStore;
  readonly capsuleId: ExtractDocumentParams["capsuleId"];
  readonly sourceId: string;
  readonly documentId: DocumentId;
  readonly jobId: string;
  readonly strategy: LargeDocumentExtractionStrategy;
  readonly fingerprint: CheckpointFingerprint;
  readonly retryCount: number;
  readonly createdAt: number;
  readonly now: () => number;
}

interface SinkState {
  unitIndex: number;
  windowIndex: number;
  pageCursor: number;
  objectCursor: number;
  characterCursor: number;
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
    retryCount: deps.retryCount,
    coverage,
    fingerprint: deps.fingerprint,
    terminalDiagnostics: diagnostics,
    createdAt: deps.createdAt,
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
    insertDocumentTextWindowRow(db, deps.store._internal.contentCipher, {
      capsuleId: deps.capsuleId,
      documentId: deps.documentId,
      windowIndex: state.windowIndex,
      characterStart: window.characterStart,
      characterEnd: window.characterStart + window.text.length,
      normalizedText: window.text,
    });
    state.windowIndex += 1;
    state.pageCursor = window.lastPageNumber;
    state.objectCursor = window.objectCursor;
    state.characterCursor = window.characterStart + window.text.length;
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

function parserDiagnostic(
  code: string,
  message: string,
  documentId: DocumentId,
  severity: ParserDiagnostic["severity"] = "warning",
): ParserDiagnostic {
  return { code, message, severity, documentId };
}

function redactionPrefixFor(params: ExtractDocumentParams): string {
  const { scope } = params.source;
  if (scope.kind === "folder") return scope.rootPath;
  if (scope.kind === "repository") return scope.repositoryRoot;
  return scope.rootPath;
}

function redactDiagnostic(
  diagnostic: ParserDiagnostic,
  params: ExtractDocumentParams,
): ParserDiagnostic {
  return {
    ...diagnostic,
    message: redactDiagnosticMessage(diagnostic.message, redactionPrefixFor(params)),
  };
}

function redactDiagnostics(
  diagnostics: readonly ParserDiagnostic[],
  params: ExtractDocumentParams,
): readonly ParserDiagnostic[] {
  return diagnostics.map((diagnostic) => redactDiagnostic(diagnostic, params));
}

function checkpointIncompatibleDiagnostic(
  documentId: DocumentId,
  reasons: readonly string[],
): ParserDiagnostic {
  return parserDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.CHECKPOINT_INCOMPATIBLE,
    `resume refused and restarted; changed: ${reasons.join(", ")}`,
    documentId,
    "warning",
  );
}

function retryLimitDiagnostic(documentId: DocumentId): ParserDiagnostic {
  return parserDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.RESOURCE_POLICY_EXCEEDED,
    "large-document retry count exceeded the configured resource policy",
    documentId,
    "error",
  );
}

function parserFailureDiagnostic(documentId: DocumentId): ParserDiagnostic {
  return parserDiagnostic(
    "MALFORMED_INPUT",
    "progressive parser rejected malformed or unsupported document",
    documentId,
    "error",
  );
}

function multimodalCapabilityDiagnostic(documentId: DocumentId): ParserDiagnostic {
  return parserDiagnostic(
    LARGE_DOCUMENT_DIAGNOSTIC_CODES.MULTIMODAL_CAPABILITY_UNAVAILABLE,
    "page image and diagram semantics were not extracted because no multimodal capability is configured; indexed with text-only coverage",
    documentId,
    "warning",
  );
}

function capabilityDiagnostics(
  context: ProgressiveExtractContext,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  summary: ProgressiveExtractionSummary,
): readonly ParserDiagnostic[] {
  if (summary.pageCount === 0) return [];
  if (mediaTypeFor(extensionOf(params.file.relativePath)) !== "application/pdf") return [];
  if (context.capabilities.multimodal === "available") return [];
  return [multimodalCapabilityDiagnostic(documentId)];
}

function coverageWithDiagnostics(
  base: CoverageQuality,
  diagnostics: readonly ParserDiagnostic[],
): CoverageQuality {
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === LARGE_DOCUMENT_DIAGNOSTIC_CODES.PARTIAL_COVERAGE ||
        diagnostic.code === LARGE_DOCUMENT_DIAGNOSTIC_CODES.OCR_CAPABILITY_UNAVAILABLE,
    )
  ) {
    return base === "none" ? "none" : "partial";
  }
  if (
    base === "complete" &&
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === LARGE_DOCUMENT_DIAGNOSTIC_CODES.MULTIMODAL_CAPABILITY_UNAVAILABLE,
    )
  ) {
    return "text-only";
  }
  return base;
}

function countRows(
  store: KnowledgeStore,
  table: "document_text_windows" | "parsed_units",
  capsuleId: ExtractDocumentParams["capsuleId"],
  documentId: DocumentId,
): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c AND document_id = :d`)
    .get({ c: String(capsuleId), d: String(documentId) }) as { readonly n: number };
  return row.n;
}

function maxWindowCharacterEnd(
  store: KnowledgeStore,
  capsuleId: ExtractDocumentParams["capsuleId"],
  documentId: DocumentId,
): number {
  const row = store._internal.db
    .prepare(
      "SELECT COALESCE(MAX(character_end), 0) AS n FROM document_text_windows WHERE capsule_id = :c AND document_id = :d",
    )
    .get({ c: String(capsuleId), d: String(documentId) }) as { readonly n: number };
  return row.n;
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

function persistStandaloneDiagnostic(
  deps: SinkDeps,
  diagnostic: ParserDiagnostic,
  suffix: string,
): void {
  insertDiagnosticRow(deps.store._internal.db, {
    id: `${String(deps.documentId)}#${suffix}`,
    capsuleId: deps.capsuleId,
    diagnostic,
    createdAt: deps.now(),
  });
}

function insertProgressiveFailureRows(
  deps: SinkDeps,
  params: ExtractDocumentParams,
  extractor: ProgressiveExtractor,
  contentHash: string,
  state: SinkState,
  diagnostic: ParserDiagnostic,
): ParserDiagnostic {
  const db = deps.store._internal.db;
  const now = deps.now();
  const redactedDiagnostic = redactDiagnostic(diagnostic, params);
  db.exec("BEGIN");
  try {
    insertDocumentRow(db, {
      id: deps.documentId,
      capsuleId: params.capsuleId,
      sourceId: deps.sourceId,
      documentPath: params.file.relativePath,
      sizeBytes: params.file.sizeBytes,
      mediaType: mediaTypeFor(extensionOf(params.file.relativePath)),
      contentHash,
      parserId: extractor.strategyId,
      parserVersion: extractor.parserVersion,
      lastExtractedAt: now,
      status: "failed",
      safeDisplayName: basenameOf(params.file.relativePath),
    });
    insertDiagnosticRow(db, {
      id: `${String(deps.documentId)}#progressive-failure`,
      capsuleId: params.capsuleId,
      diagnostic: redactedDiagnostic,
      createdAt: now,
    });
    checkpointFor(deps, state, "failed", state.pageCursor > 0 ? "partial" : "none", [
      redactedDiagnostic,
    ]);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
  return redactedDiagnostic;
}

function progressiveFailureResult(
  deps: SinkDeps,
  params: ExtractDocumentParams,
  extractor: ProgressiveExtractor,
  contentHash: string,
  diagnostic: ParserDiagnostic,
): ExtractionResult {
  const document = progressiveDocumentRecord(
    params,
    deps.documentId,
    extractor,
    contentHash,
    "failed",
    deps.now(),
  );
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome: {
      kind: "failed",
      document,
      error: {
        code: "PARSER_FAILED",
        message: diagnostic.message,
        relativePath: params.file.relativePath,
      },
    },
    diagnostics: [diagnostic],
  };
}

function persistProgressiveFailure(
  deps: SinkDeps,
  params: ExtractDocumentParams,
  extractor: ProgressiveExtractor,
  contentHash: string,
  state: SinkState,
  diagnostic: ParserDiagnostic,
): ExtractionResult {
  const redactedDiagnostic = insertProgressiveFailureRows(
    deps,
    params,
    extractor,
    contentHash,
    state,
    diagnostic,
  );
  return progressiveFailureResult(deps, params, extractor, contentHash, redactedDiagnostic);
}

function extractionOptionsFor(
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  documentId: DocumentId,
  now: () => number,
  state: SinkState,
  resume: boolean,
): ProgressiveExtractionOptions {
  const extension = extensionOf(params.file.relativePath);
  return {
    documentId,
    extension,
    mediaType: mediaTypeFor(extension),
    policy: context.policy,
    now,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(resume
      ? {
          resumeFromPage: state.pageCursor,
          resumeCharacterStart: state.characterCursor,
          resumeWindowIndex: state.windowIndex,
          resumeObjectCursor: state.objectCursor,
          resumeExtractedTextBytes: state.extractedTextBytes,
        }
      : {}),
  };
}

function buildSinkDeps(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  documentId: DocumentId,
  contentHash: string,
  retryCount: number,
  createdAt: number,
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
    retryCount,
    createdAt,
    now: deps.store._internal.now,
  };
}

interface ExistingCheckpointPlan {
  readonly state: SinkState;
  readonly retryCount: number;
  readonly createdAt: number;
  readonly resume: boolean;
  readonly startupDiagnostics: readonly ParserDiagnostic[];
  readonly failure?: ExtractionResult;
}

function emptySinkState(): SinkState {
  return {
    unitIndex: 0,
    windowIndex: 0,
    pageCursor: 0,
    objectCursor: 0,
    characterCursor: 0,
    extractedTextBytes: 0,
  };
}

function checkpointSinkState(
  store: KnowledgeStore,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  checkpoint: ReturnType<typeof selectExtractionCheckpoint>,
): SinkState {
  return {
    unitIndex: countRows(store, "parsed_units", params.capsuleId, documentId),
    windowIndex: countRows(store, "document_text_windows", params.capsuleId, documentId),
    pageCursor: checkpoint?.pageCursor ?? 0,
    objectCursor: checkpoint?.objectCursor ?? 0,
    characterCursor: maxWindowCharacterEnd(store, params.capsuleId, documentId),
    extractedTextBytes: checkpoint?.extractedTextBytes ?? 0,
  };
}

function planForMissingCheckpoint(createdAt: number): ExistingCheckpointPlan {
  return {
    state: emptySinkState(),
    retryCount: 0,
    createdAt,
    resume: false,
    startupDiagnostics: [],
  };
}

function retryExceededPlan(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  contentHash: string,
  provisional: SinkDeps,
  existing: NonNullable<ReturnType<typeof selectExtractionCheckpoint>>,
  state: SinkState,
  retryCount: number,
): ExistingCheckpointPlan {
  const sinkDeps = buildSinkDeps(
    deps,
    params,
    context,
    extractor,
    provisional.documentId,
    contentHash,
    retryCount,
    existing.createdAt,
  );
  return {
    state,
    retryCount,
    createdAt: existing.createdAt,
    resume: false,
    startupDiagnostics: [],
    failure: persistProgressiveFailure(
      sinkDeps,
      params,
      extractor,
      contentHash,
      state,
      retryLimitDiagnostic(provisional.documentId),
    ),
  };
}

function planForExistingCheckpoint(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  contentHash: string,
  provisional: SinkDeps,
  existing: NonNullable<ReturnType<typeof selectExtractionCheckpoint>>,
): ExistingCheckpointPlan {
  const compat = checkpointCompatibility(existing.fingerprint, provisional.fingerprint);
  if (!compat.compatible) {
    return {
      ...planForMissingCheckpoint(provisional.createdAt),
      startupDiagnostics: [
        checkpointIncompatibleDiagnostic(provisional.documentId, compat.reasons),
      ],
    };
  }
  if (
    (existing.phase !== "extracting" && existing.phase !== "cancelled") ||
    existing.pageCursor <= 0
  ) {
    return planForMissingCheckpoint(provisional.createdAt);
  }
  const retryCount = existing.retryCount + 1;
  const state = checkpointSinkState(deps.store, params, provisional.documentId, existing);
  if (retryCount > context.policy.maxRetryCount) {
    return retryExceededPlan(
      deps,
      params,
      context,
      extractor,
      contentHash,
      provisional,
      existing,
      state,
      retryCount,
    );
  }
  return { state, retryCount, createdAt: existing.createdAt, resume: true, startupDiagnostics: [] };
}

function persistProgressiveStartup(
  sinkDeps: SinkDeps,
  params: ExtractDocumentParams,
  extractor: ProgressiveExtractor,
  contentHash: string,
  plan: ExistingCheckpointPlan,
): void {
  if (plan.resume) {
    checkpointFor(sinkDeps, plan.state, "extracting", "partial", plan.startupDiagnostics);
    return;
  }
  insertPendingDocument(sinkDeps, params, extractor, contentHash, plan.state);
  plan.startupDiagnostics.forEach((diagnostic, index) => {
    persistStandaloneDiagnostic(
      sinkDeps,
      redactDiagnostic(diagnostic, params),
      `startup-d${String(index)}`,
    );
  });
  if (plan.startupDiagnostics.length > 0) {
    checkpointFor(
      sinkDeps,
      plan.state,
      "extracting",
      "none",
      redactDiagnostics(plan.startupDiagnostics, params),
    );
  }
}

async function tryRunProgressiveExtraction(
  extractor: ProgressiveExtractor,
  source: ProgressiveExtractionSource,
  options: ProgressiveExtractionOptions,
  sinkDeps: SinkDeps,
  state: SinkState,
): Promise<ProgressiveExtractionSummary | undefined> {
  try {
    return await runProgressiveExtraction(extractor, source, options, {
      onWindow: (window): void => {
        persistWindow(sinkDeps, state, window);
      },
    });
  } catch {
    return undefined;
  }
}

function summaryWithDiagnostics(
  context: ProgressiveExtractContext,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  summary: ProgressiveExtractionSummary,
  startupDiagnostics: readonly ParserDiagnostic[],
): ProgressiveExtractionSummary {
  const diagnostics = redactDiagnostics(
    [
      ...startupDiagnostics,
      ...summary.diagnostics,
      ...capabilityDiagnostics(context, params, documentId, summary),
    ],
    params,
  );
  return {
    ...summary,
    diagnostics,
    coverage: coverageWithDiagnostics(summary.coverage, diagnostics),
  };
}

interface ProgressiveStart {
  readonly documentId: DocumentId;
  readonly provisionalSinkDeps: SinkDeps;
  readonly plan: ExistingCheckpointPlan;
}

function progressiveDocumentId(
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
): DocumentId {
  return documentIdFor({
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: context.relativePath,
  });
}

function planForCheckpoint(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  contentHash: string,
  provisional: SinkDeps,
): ExistingCheckpointPlan {
  const existing = selectExtractionCheckpoint(
    deps.store._internal.db,
    params.capsuleId,
    provisional.documentId,
  );
  if (existing === undefined) return planForMissingCheckpoint(provisional.createdAt);
  return planForExistingCheckpoint(
    deps,
    params,
    context,
    extractor,
    contentHash,
    provisional,
    existing,
  );
}

function buildProgressiveStart(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  contentHash: string,
  extractor: ProgressiveExtractor,
): ProgressiveStart {
  const documentId = progressiveDocumentId(params, context);
  const provisionalSinkDeps = buildSinkDeps(
    deps,
    params,
    context,
    extractor,
    documentId,
    contentHash,
    0,
    deps.store._internal.now(),
  );
  return {
    documentId,
    provisionalSinkDeps,
    plan: planForCheckpoint(deps, params, context, extractor, contentHash, provisionalSinkDeps),
  };
}

function sinkDepsForPlan(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  extractor: ProgressiveExtractor,
  contentHash: string,
  start: ProgressiveStart,
): SinkDeps {
  const { plan, provisionalSinkDeps } = start;
  if (
    plan.retryCount === provisionalSinkDeps.retryCount &&
    plan.createdAt === provisionalSinkDeps.createdAt
  ) {
    return provisionalSinkDeps;
  }
  return buildSinkDeps(
    deps,
    params,
    context,
    extractor,
    start.documentId,
    contentHash,
    plan.retryCount,
    plan.createdAt,
  );
}

function finalizeProgressiveSuccess(
  sinkDeps: SinkDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  contentHash: string,
  extractor: ProgressiveExtractor,
  plan: ExistingCheckpointPlan,
  summary: ProgressiveExtractionSummary,
): ExtractionResult {
  const finalSummary = summaryWithDiagnostics(
    context,
    params,
    sinkDeps.documentId,
    summary,
    plan.startupDiagnostics,
  );
  const status = finalize(sinkDeps, plan.state, finalSummary, finalSummary.diagnostics);
  const document = progressiveDocumentRecord(
    params,
    sinkDeps.documentId,
    extractor,
    contentHash,
    status,
    sinkDeps.now(),
  );
  return progressiveResult(params, document, finalSummary);
}

async function runPlannedProgressiveExtraction(
  sinkDeps: SinkDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  source: ProgressiveExtractionSource,
  contentHash: string,
  extractor: ProgressiveExtractor,
  plan: ExistingCheckpointPlan,
): Promise<ExtractionResult> {
  persistProgressiveStartup(sinkDeps, params, extractor, contentHash, plan);
  const summary = await tryRunProgressiveExtraction(
    extractor,
    source,
    extractionOptionsFor(
      params,
      context,
      sinkDeps.documentId,
      sinkDeps.now,
      plan.state,
      plan.resume,
    ),
    sinkDeps,
    plan.state,
  );
  if (summary === undefined) {
    return persistProgressiveFailure(
      sinkDeps,
      params,
      extractor,
      contentHash,
      plan.state,
      parserFailureDiagnostic(sinkDeps.documentId),
    );
  }
  return finalizeProgressiveSuccess(
    sinkDeps,
    params,
    context,
    contentHash,
    extractor,
    plan,
    summary,
  );
}

// Runs the page-windowed progressive extraction for one large document and persists it bounded.
// The caller supplies a bounded byte source and a hash computed through bounded reads; extracted
// text, pages, and checkpoints are flushed per window so peak memory does not scale with the raw
// document size.
export async function extractDocumentProgressive(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  context: ProgressiveExtractContext,
  source: ProgressiveExtractionSource,
  contentHash: string,
  extractor: ProgressiveExtractor,
): Promise<ExtractionResult> {
  const start = buildProgressiveStart(deps, params, context, contentHash, extractor);
  if (start.plan.failure !== undefined) return start.plan.failure;
  return await runPlannedProgressiveExtraction(
    sinkDepsForPlan(deps, params, context, extractor, contentHash, start),
    params,
    context,
    source,
    contentHash,
    extractor,
    start.plan,
  );
}
