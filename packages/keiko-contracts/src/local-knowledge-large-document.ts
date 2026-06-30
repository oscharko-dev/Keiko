// Bounded large-document ingestion contracts for the Local Knowledge Connector
// (Epic #1160, Issue #1286). This module is PURE — no node:sqlite, no fs, no clock, no
// randomness, no crypto — so it stays in the leaf `keiko-contracts` package.
//
// The large-document path coexists with the existing full-buffer parser path. Small files
// keep their current behavior; large supported files are preflight-classified, bounded by an
// explicit multi-dimensional resource policy, extracted progressively (page-windowed),
// checkpointed durably so they can resume, and degraded to partial coverage with quality
// warnings rather than failing the indexing pipeline when an optional capability is missing.
//
// Every record carries explicit capsuleId + documentId lineage so a single global pool is
// unrepresentable (Foundry IQ invariant). The wire surface stays content-free: checkpoints
// carry hashes, cursors, and counts — never raw extracted text.

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
} from "./local-knowledge.js";
import type { ParserDiagnostic } from "./local-knowledge-records.js";

// ─── Resource policy ──────────────────────────────────────────────────────────
// Separates every bounded dimension instead of collapsing them into a single parser
// `maxBytes` constant. Exposed through Local Knowledge configuration / BFF defaults so the
// limits are configurable and auditable rather than hidden inside parser code.
export interface LargeDocumentResourcePolicy {
  readonly maxRawFileBytes: number;
  readonly maxExtractedTextBytes: number;
  readonly maxParserUnits: number;
  readonly maxParserObjects: number;
  readonly maxChunkCount: number;
  readonly maxEmbeddingBatchCount: number;
  readonly maxWallClockMs: number;
  readonly cancellationDeadlineMs: number;
  readonly maxRetryCount: number;
  readonly maxPersistedStorageGrowthBytes: number;
  // Files at or above this raw size use the progressive path; smaller files keep the exact
  // existing full-buffer behavior (backward compatible).
  readonly largeFileThresholdBytes: number;
  // Pages per progressive extraction window. Bounds the extraction working set.
  readonly extractionWindowPages: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY: LargeDocumentResourcePolicy = Object.freeze({
  maxRawFileBytes: GIB,
  maxExtractedTextBytes: 256 * MIB,
  maxParserUnits: 200_000,
  maxParserObjects: 25_000_000,
  maxChunkCount: 2_000_000,
  maxEmbeddingBatchCount: 100_000,
  maxWallClockMs: 60 * 60 * 1000,
  cancellationDeadlineMs: 15_000,
  maxRetryCount: 3,
  maxPersistedStorageGrowthBytes: 512 * MIB,
  largeFileThresholdBytes: 64 * MIB,
  extractionWindowPages: 16,
});

// Stable, order-fixed fingerprint persisted with each checkpoint. Any policy change yields a
// different fingerprint, which makes a resumed job refuse a checkpoint produced under
// different limits.
export function largeDocumentPolicyFingerprint(policy: LargeDocumentResourcePolicy): string {
  return [
    "ldp1",
    policy.maxRawFileBytes,
    policy.maxExtractedTextBytes,
    policy.maxParserUnits,
    policy.maxParserObjects,
    policy.maxChunkCount,
    policy.maxEmbeddingBatchCount,
    policy.maxWallClockMs,
    policy.cancellationDeadlineMs,
    policy.maxRetryCount,
    policy.maxPersistedStorageGrowthBytes,
    policy.largeFileThresholdBytes,
    policy.extractionWindowPages,
  ].join(":");
}

// ─── Preflight classification ─────────────────────────────────────────────────
export type LargeDocumentExtractionStrategy =
  "standard-buffer" | "progressive-pdf" | "unsupported" | "oversized";

export const LARGE_DOCUMENT_EXTRACTION_STRATEGIES: readonly LargeDocumentExtractionStrategy[] = [
  "standard-buffer",
  "progressive-pdf",
  "unsupported",
  "oversized",
] as const;

export type LargeDocumentPreflightDecision =
  "accept-standard" | "accept-progressive" | "reject-oversized";

export interface LargeDocumentPreflight {
  readonly strategy: LargeDocumentExtractionStrategy;
  readonly decision: LargeDocumentPreflightDecision;
  readonly sizeBytes: number;
  readonly estimatedWindows?: number;
  // User-safe, content-free reason string (e.g. an OVERSIZED_FILE explanation). Never carries
  // absolute paths, stack traces, or extracted content.
  readonly reason?: string;
}

// ─── Extraction phase + coverage ──────────────────────────────────────────────
export type ExtractionPhase =
  | "preflight"
  | "extracting"
  | "extracted"
  | "chunking"
  | "chunked"
  | "embedding"
  | "embedded"
  | "complete"
  | "cancelled"
  | "failed";

export const EXTRACTION_PHASES: readonly ExtractionPhase[] = [
  "preflight",
  "extracting",
  "extracted",
  "chunking",
  "chunked",
  "embedding",
  "embedded",
  "complete",
  "cancelled",
  "failed",
] as const;

// A phase is terminal when no further work will run for the document under the current job.
export const TERMINAL_EXTRACTION_PHASES: readonly ExtractionPhase[] = [
  "complete",
  "cancelled",
  "failed",
] as const;

export function isTerminalExtractionPhase(phase: ExtractionPhase): boolean {
  return TERMINAL_EXTRACTION_PHASES.includes(phase);
}

// Distinguishes pipeline stability (the job completed) from retrieval quality (how much of
// the document is actually searchable).
export type CoverageQuality = "complete" | "text-only" | "partial" | "none";

export const COVERAGE_QUALITIES: readonly CoverageQuality[] = [
  "complete",
  "text-only",
  "partial",
  "none",
] as const;

// ─── Capability discovery ─────────────────────────────────────────────────────
export type ExtractionCapabilityStatus = "available" | "unavailable" | "degraded" | "failing";

export const EXTRACTION_CAPABILITY_STATUSES: readonly ExtractionCapabilityStatus[] = [
  "available",
  "unavailable",
  "degraded",
  "failing",
] as const;

export interface ExtractionCapabilityAvailability {
  readonly ocr: ExtractionCapabilityStatus;
  readonly multimodal: ExtractionCapabilityStatus;
}

export const DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY: ExtractionCapabilityAvailability =
  Object.freeze({ ocr: "unavailable", multimodal: "unavailable" });

// A capability contributes useful coverage only when it is fully available. Degraded/failing
// capabilities are isolated as quality warnings.
export function capabilityContributesCoverage(status: ExtractionCapabilityStatus): boolean {
  return status === "available";
}

// ─── Content-free diagnostic codes for the large-document path ─────────────────
export const LARGE_DOCUMENT_DIAGNOSTIC_CODES = Object.freeze({
  PARTIAL_COVERAGE: "PARTIAL_COVERAGE",
  OCR_CAPABILITY_UNAVAILABLE: "OCR_CAPABILITY_UNAVAILABLE",
  MULTIMODAL_CAPABILITY_UNAVAILABLE: "MULTIMODAL_CAPABILITY_UNAVAILABLE",
  CONVERTER_UNAVAILABLE: "CONVERTER_UNAVAILABLE",
  RESOURCE_POLICY_EXCEEDED: "RESOURCE_POLICY_EXCEEDED",
  CHECKPOINT_INCOMPATIBLE: "CHECKPOINT_INCOMPATIBLE",
  EXTRACTION_RESUMED: "EXTRACTION_RESUMED",
  EXTRACTION_PROGRESS: "EXTRACTION_PROGRESS",
} as const);

export type LargeDocumentDiagnosticCode =
  (typeof LARGE_DOCUMENT_DIAGNOSTIC_CODES)[keyof typeof LARGE_DOCUMENT_DIAGNOSTIC_CODES];

// ─── Checkpoint record ────────────────────────────────────────────────────────
// The compatibility fingerprint is the closed set of inputs that, if changed, invalidate a
// resumed job's prior progress.
export interface CheckpointFingerprint {
  readonly sourceContentHash: string;
  readonly parserVersion: string;
  readonly policyFingerprint: string;
  readonly chunkingStrategyVersion: string;
  readonly embeddingIdentity: EmbeddingModelIdentity;
}

export interface ExtractionCheckpointRecord {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: DocumentId;
  readonly jobId: string;
  readonly strategy: LargeDocumentExtractionStrategy;
  readonly phase: ExtractionPhase;
  readonly pageCursor: number;
  readonly sectionCursor: number;
  readonly objectCursor: number;
  readonly extractedTextBytes: number;
  readonly chunkCursor: number;
  readonly embeddedChunkCursor: number;
  readonly lastEmbeddedChunkId?: ChunkId;
  readonly retryCount: number;
  readonly coverage: CoverageQuality;
  readonly fingerprint: CheckpointFingerprint;
  readonly terminalDiagnostics: readonly ParserDiagnostic[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── Checkpoint compatibility ─────────────────────────────────────────────────
export type CheckpointIncompatibilityReason =
  "source-hash" | "parser-version" | "resource-policy" | "chunking-strategy" | "embedding-identity";

export const CHECKPOINT_INCOMPATIBILITY_REASONS: readonly CheckpointIncompatibilityReason[] = [
  "source-hash",
  "parser-version",
  "resource-policy",
  "chunking-strategy",
  "embedding-identity",
] as const;

export type CheckpointCompatibility =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reasons: readonly CheckpointIncompatibilityReason[] };

function sameEmbeddingIdentity(a: EmbeddingModelIdentity, b: EmbeddingModelIdentity): boolean {
  return (
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.vectorDimensions === b.vectorDimensions &&
    a.vectorMetric === b.vectorMetric &&
    (a.modelRevision ?? "") === (b.modelRevision ?? "")
  );
}

// Pure comparison. A resumed job continues only when this returns `{ compatible: true }`;
// otherwise the job restarts from scratch and emits a CHECKPOINT_INCOMPATIBLE diagnostic.
export function checkpointCompatibility(
  stored: CheckpointFingerprint,
  current: CheckpointFingerprint,
): CheckpointCompatibility {
  const reasons: CheckpointIncompatibilityReason[] = [];
  if (stored.sourceContentHash !== current.sourceContentHash) reasons.push("source-hash");
  if (stored.parserVersion !== current.parserVersion) reasons.push("parser-version");
  if (stored.policyFingerprint !== current.policyFingerprint) reasons.push("resource-policy");
  if (stored.chunkingStrategyVersion !== current.chunkingStrategyVersion) {
    reasons.push("chunking-strategy");
  }
  if (!sameEmbeddingIdentity(stored.embeddingIdentity, current.embeddingIdentity)) {
    reasons.push("embedding-identity");
  }
  return reasons.length === 0 ? { compatible: true } : { compatible: false, reasons };
}

// ─── BFF progress / health projection ─────────────────────────────────────────
// Content-free projection surfaced to UI so users see granular phases and quality limits.
export interface LargeDocumentJobProgress {
  readonly documentId: DocumentId;
  readonly safeDisplayName: string;
  readonly strategy: LargeDocumentExtractionStrategy;
  readonly phase: ExtractionPhase;
  readonly processedPages: number;
  readonly extractedTextBytes: number;
  readonly chunkCount: number;
  readonly embeddedChunkCount: number;
  readonly retryCount: number;
  readonly coverage: CoverageQuality;
  readonly resumable: boolean;
}

export type LargeDocumentResumeChoice = "resume" | "restart" | "abandon";

export const LARGE_DOCUMENT_RESUME_CHOICES: readonly LargeDocumentResumeChoice[] = [
  "resume",
  "restart",
  "abandon",
] as const;

export interface CapsuleLargeDocumentHealth {
  readonly resourcePolicy: LargeDocumentResourcePolicy;
  readonly capabilities: ExtractionCapabilityAvailability;
  readonly progress: readonly LargeDocumentJobProgress[];
  readonly resumableDocuments: readonly DocumentId[];
  readonly partialCoverageDocuments: number;
  readonly qualityWarnings: readonly string[];
}
