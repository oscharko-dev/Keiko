// Pure validators for the bounded large-document ingestion contracts (Epic #1160,
// Issue #1286). No filesystem, clock, crypto, or randomness; these helpers only inspect the
// structure of an `unknown` payload and report which invariants failed.
//
// Each validator returns the same discriminated `{ ok: true; value } | { ok: false; errors }`
// shape as the other Local Knowledge validators so callers branch without throwing.

import type {
  CheckpointFingerprint,
  CoverageQuality,
  ExtractionCheckpointRecord,
  ExtractionPhase,
  LargeDocumentExtractionStrategy,
  LargeDocumentResourcePolicy,
} from "./local-knowledge-large-document.js";
import {
  COVERAGE_QUALITIES,
  EXTRACTION_PHASES,
  LARGE_DOCUMENT_EXTRACTION_STRATEGIES,
} from "./local-knowledge-large-document.js";
import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";
import { isSafeDisplaySummary } from "./local-knowledge-validation.js";

// ─── Local primitive guards ───────────────────────────────────────────────────
// Mirror the private guards in local-knowledge-validation.ts. Kept local rather than exported
// across the module boundary to avoid widening that file's public surface.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]+$/i.test(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ─── Resource policy ──────────────────────────────────────────────────────────
const POSITIVE_POLICY_FIELDS: readonly (keyof LargeDocumentResourcePolicy)[] = [
  "maxRawFileBytes",
  "maxExtractedTextBytes",
  "maxParserUnits",
  "maxParserObjects",
  "maxChunkCount",
  "maxEmbeddingBatchCount",
  "maxWallClockMs",
  "cancellationDeadlineMs",
  "maxRetryCount",
  "maxPersistedStorageGrowthBytes",
  "largeFileThresholdBytes",
  "extractionWindowPages",
];

export function validateLargeDocumentResourcePolicy(
  input: unknown,
): LocalKnowledgeValidation<LargeDocumentResourcePolicy> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["policy must be an object"] };
  }
  const errors: string[] = [];
  for (const field of POSITIVE_POLICY_FIELDS) {
    // maxRetryCount may be zero (retries disabled); everything else must be strictly positive.
    const value = input[field];
    const ok =
      field === "maxRetryCount"
        ? isFiniteNonNegativeInteger(value)
        : isFinitePositiveInteger(value);
    if (!ok) {
      errors.push(
        `policy.${field} must be a ${field === "maxRetryCount" ? "non-negative" : "positive"} integer`,
      );
    }
  }
  if (errors.length === 0) {
    const policy = input as unknown as LargeDocumentResourcePolicy;
    if (policy.largeFileThresholdBytes > policy.maxRawFileBytes) {
      errors.push("policy.largeFileThresholdBytes must not exceed policy.maxRawFileBytes");
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as LargeDocumentResourcePolicy };
}

// ─── Checkpoint fingerprint ───────────────────────────────────────────────────
function validateFingerprint(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("checkpoint.fingerprint must be an object");
    return;
  }
  if (!isNonEmptyHex(value.sourceContentHash)) {
    errors.push("checkpoint.fingerprint.sourceContentHash must be a hex string");
  }
  if (!isNonEmptyTrimmedString(value.parserVersion)) {
    errors.push("checkpoint.fingerprint.parserVersion must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(value.policyFingerprint)) {
    errors.push("checkpoint.fingerprint.policyFingerprint must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(value.chunkingStrategyVersion)) {
    errors.push("checkpoint.fingerprint.chunkingStrategyVersion must be a non-empty string");
  }
  if (!isRecord(value.embeddingIdentity)) {
    errors.push("checkpoint.fingerprint.embeddingIdentity must be an object");
  }
}

// ─── Checkpoint record ────────────────────────────────────────────────────────
const NON_NEGATIVE_CURSOR_FIELDS: readonly (keyof ExtractionCheckpointRecord)[] = [
  "pageCursor",
  "sectionCursor",
  "objectCursor",
  "extractedTextBytes",
  "chunkCursor",
  "embeddedChunkCursor",
  "retryCount",
  "createdAt",
  "updatedAt",
];

function isStrategy(value: unknown): value is LargeDocumentExtractionStrategy {
  return (
    typeof value === "string" &&
    (LARGE_DOCUMENT_EXTRACTION_STRATEGIES as readonly string[]).includes(value)
  );
}

function isPhase(value: unknown): value is ExtractionPhase {
  return typeof value === "string" && (EXTRACTION_PHASES as readonly string[]).includes(value);
}

function isCoverage(value: unknown): value is CoverageQuality {
  return typeof value === "string" && (COVERAGE_QUALITIES as readonly string[]).includes(value);
}

export function validateExtractionCheckpointRecord(
  input: unknown,
): LocalKnowledgeValidation<ExtractionCheckpointRecord> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["checkpoint must be an object"] };
  }
  const errors: string[] = [];
  if (!isNonEmptyTrimmedString(input.capsuleId)) {
    errors.push("checkpoint.capsuleId must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(input.documentId)) {
    errors.push("checkpoint.documentId must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(input.jobId)) {
    errors.push("checkpoint.jobId must be a non-empty string");
  }
  if (!isStrategy(input.strategy)) {
    errors.push("checkpoint.strategy must be a known extraction strategy");
  }
  if (!isPhase(input.phase)) {
    errors.push("checkpoint.phase must be a known extraction phase");
  }
  if (!isCoverage(input.coverage)) {
    errors.push("checkpoint.coverage must be a known coverage quality");
  }
  for (const field of NON_NEGATIVE_CURSOR_FIELDS) {
    if (!isFiniteNonNegativeInteger(input[field])) {
      errors.push(`checkpoint.${field} must be a non-negative integer`);
    }
  }
  if (
    input.lastEmbeddedChunkId !== undefined &&
    !isNonEmptyTrimmedString(input.lastEmbeddedChunkId)
  ) {
    errors.push("checkpoint.lastEmbeddedChunkId must be a non-empty string when present");
  }
  if (!Array.isArray(input.terminalDiagnostics)) {
    errors.push("checkpoint.terminalDiagnostics must be an array");
  }
  validateFingerprint(errors, input.fingerprint);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as ExtractionCheckpointRecord };
}

// Convenience guard for user-safe diagnostic/quality-warning strings reused by the BFF layer.
export function isSafeQualityWarning(value: unknown): value is string {
  return isSafeDisplaySummary(value);
}

export type { CheckpointFingerprint };
