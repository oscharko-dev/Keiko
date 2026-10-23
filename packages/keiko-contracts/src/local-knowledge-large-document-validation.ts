// Pure validators for the bounded large-document ingestion contracts (Epic #1160,
// Issue #1286). No filesystem, clock, crypto, or randomness; these helpers only inspect the
// structure of an `unknown` payload and report which invariants failed.
//
// Each validator returns the same discriminated `{ ok: true; value } | { ok: false; errors }`
// shape as the other Local Knowledge validators so callers branch without throwing.

import type {
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
import type { ParserDiagnostic } from "./local-knowledge-records.js";
import { PARSER_DIAGNOSTIC_SEVERITIES } from "./local-knowledge-records.js";
import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";
import {
  validateEmbeddingModelIdentity,
  isSafeDisplaySummary,
} from "./local-knowledge-validation.js";

// ─── Local primitive guards ───────────────────────────────────────────────────
// Mirror the private guards in local-knowledge-validation.ts. Kept local rather than exported
// across the module boundary to avoid widening that file's public surface.
type DiagnosticStructure = Omit<ParserDiagnostic, "documentId"> & { readonly documentId?: string };
type CheckpointStructure = Omit<
  ExtractionCheckpointRecord,
  "capsuleId" | "documentId" | "lastEmbeddedChunkId" | "terminalDiagnostics"
> & {
  readonly capsuleId: string;
  readonly documentId: string;
  readonly lastEmbeddedChunkId?: string;
  readonly terminalDiagnostics: readonly DiagnosticStructure[];
};

function isCapturedExtent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateStableExtent(
  members: readonly unknown[],
  extent: number,
  field: string,
  errors: string[],
): boolean {
  if (members.length !== extent)
    return reject(errors, `${field} must not change length during validation`);
  return true;
}

function combineAdmissions(previous: boolean, current: boolean): boolean {
  return previous && current;
}

// A refusal records the original diagnostic and actual failed field evidence.
function reject(errors: string[], ...reasons: string[]): false {
  errors.push(...reasons);
  return false;
}

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

function admitsPolicyFields(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & LargeDocumentResourcePolicy {
  let valid = true;
  for (const field of POSITIVE_POLICY_FIELDS) {
    const value = input[field];
    const ok =
      field === "maxRetryCount"
        ? isFiniteNonNegativeInteger(value)
        : isFinitePositiveInteger(value);
    if (!ok)
      valid = reject(
        errors,
        `policy.${field} must be a ${field === "maxRetryCount" ? "non-negative" : "positive"} integer`,
      );
  }
  return valid;
}

export function validateLargeDocumentResourcePolicy(
  input: unknown,
): LocalKnowledgeValidation<LargeDocumentResourcePolicy> {
  if (!isRecord(input)) return { ok: false, errors: ["policy must be an object"] };
  const errors: string[] = [];
  if (!admitsPolicyFields(input, errors)) return { ok: false, errors };
  if (input.largeFileThresholdBytes > input.maxRawFileBytes) {
    return {
      ok: false,
      errors: ["policy.largeFileThresholdBytes must not exceed policy.maxRawFileBytes"],
    };
  }
  return { ok: true, value: input };
}

// ─── Checkpoint fingerprint ───────────────────────────────────────────────────
function validateFingerprint(errors: string[], value: unknown): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "checkpoint.fingerprint must be an object");
    return valid;
  }
  if (!isNonEmptyHex(value.sourceContentHash)) {
    valid = reject(errors, "checkpoint.fingerprint.sourceContentHash must be a hex string");
  }
  if (!isNonEmptyTrimmedString(value.parserVersion)) {
    valid = reject(errors, "checkpoint.fingerprint.parserVersion must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(value.policyFingerprint)) {
    valid = reject(errors, "checkpoint.fingerprint.policyFingerprint must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(value.chunkingStrategyVersion)) {
    valid = reject(
      errors,
      "checkpoint.fingerprint.chunkingStrategyVersion must be a non-empty string",
    );
  }
  const identity = value.embeddingIdentity;
  if (!isRecord(identity)) {
    valid = reject(errors, "checkpoint.fingerprint.embeddingIdentity must be an object");
  } else {
    const result = validateEmbeddingModelIdentity(identity);
    if (!result.ok) {
      valid = reject(
        errors,
        ...result.errors.map(
          (reason) =>
            `checkpoint.fingerprint.embeddingIdentity.${reason.slice("embeddingModelIdentity.".length)}`,
        ),
      );
    }
  }
  return valid;
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
    typeof value === "string" && LARGE_DOCUMENT_EXTRACTION_STRATEGIES_ADMISSION.includes(value)
  );
}

function isPhase(value: unknown): value is ExtractionPhase {
  return typeof value === "string" && EXTRACTION_PHASES_ADMISSION.includes(value);
}

function isCoverage(value: unknown): value is CoverageQuality {
  return typeof value === "string" && COVERAGE_QUALITIES_ADMISSION.includes(value);
}

function validateCheckpointIdentity(errors: string[], input: Record<string, unknown>): boolean {
  let valid = true;
  for (const field of ["capsuleId", "documentId", "jobId"] as const) {
    if (!isNonEmptyTrimmedString(input[field])) {
      valid = reject(errors, `checkpoint.${field} must be a non-empty string`);
    }
  }
  return valid;
}

function validateCheckpointEnums(errors: string[], input: Record<string, unknown>): boolean {
  let valid = true;
  if (!isStrategy(input.strategy)) {
    valid = reject(errors, "checkpoint.strategy must be a known extraction strategy");
  }
  if (!isPhase(input.phase)) {
    valid = reject(errors, "checkpoint.phase must be a known extraction phase");
  }
  if (!isCoverage(input.coverage)) {
    valid = reject(errors, "checkpoint.coverage must be a known coverage quality");
  }
  return valid;
}

function validateDiagnostic(value: unknown, errors: string[]): boolean {
  if (!isRecord(value))
    return reject(errors, "checkpoint.terminalDiagnostics entry must be an object");
  let valid = true;
  if (!DIAGNOSTIC_SEVERITIES_ADMISSION.includes(value.severity))
    valid = reject(errors, "checkpoint.terminalDiagnostics severity is invalid");
  if (typeof value.code !== "string")
    valid = reject(errors, "checkpoint.terminalDiagnostics code must be a string");
  if (typeof value.message !== "string")
    valid = reject(errors, "checkpoint.terminalDiagnostics message must be a string");
  if (value.documentId !== undefined && !isNonEmptyTrimmedString(value.documentId))
    valid = reject(
      errors,
      "checkpoint.terminalDiagnostics documentId must be a non-empty string when set",
    );
  if (value.pageNumber !== undefined && typeof value.pageNumber !== "number")
    valid = reject(errors, "checkpoint.terminalDiagnostics pageNumber must be a number when set");
  return valid;
}

function validateDiagnostics(value: unknown, errors: string[]): boolean {
  if (!Array.isArray(value))
    return reject(errors, "checkpoint.terminalDiagnostics must be an array");
  let valid = true;
  const length = value.length;
  if (!isCapturedExtent(length)) {
    reject(errors, "checkpoint.terminalDiagnostics must have a valid array length");
    return false;
  }
  for (let index = 0; index < length; index += 1)
    valid = combineAdmissions(valid, validateDiagnostic(value[index], errors));
  valid = combineAdmissions(
    valid,
    validateStableExtent(value, length, "checkpoint.terminalDiagnostics", errors),
  );
  return valid;
}

const DIAGNOSTIC_SEVERITIES_ADMISSION: readonly unknown[] = PARSER_DIAGNOSTIC_SEVERITIES;

function validateCheckpointCursors(errors: string[], input: Record<string, unknown>): boolean {
  let valid = true;
  for (const field of NON_NEGATIVE_CURSOR_FIELDS) {
    if (!isFiniteNonNegativeInteger(input[field])) {
      valid = reject(errors, `checkpoint.${field} must be a non-negative integer`);
    }
  }
  if (
    input.lastEmbeddedChunkId !== undefined &&
    !isNonEmptyTrimmedString(input.lastEmbeddedChunkId)
  ) {
    valid = reject(
      errors,
      "checkpoint.lastEmbeddedChunkId must be a non-empty string when present",
    );
  }
  valid = combineAdmissions(valid, validateDiagnostics(input.terminalDiagnostics, errors));
  return valid;
}

function admitsExtractionCheckpointRecord(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & CheckpointStructure {
  let valid = true;
  valid = combineAdmissions(valid, validateCheckpointIdentity(errors, input));
  valid = combineAdmissions(valid, validateCheckpointEnums(errors, input));
  valid = combineAdmissions(valid, validateCheckpointCursors(errors, input));
  valid = combineAdmissions(valid, validateFingerprint(errors, input.fingerprint));

  return valid;
}

export function validateExtractionCheckpointRecord(
  input: unknown,
): LocalKnowledgeValidation<ExtractionCheckpointRecord> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["checkpoint must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsExtractionCheckpointRecord(input, errors) || errors.length > 0)
    return { ok: false, errors };
  // All non-brand fields are admitted above; this attaches only erased ID brands.
  const admitted: CheckpointStructure = input;
  // SAFETY: The checked structure retains every concrete field; only ID brands differ.
  return { ok: true, value: admitted as ExtractionCheckpointRecord };
}

// Convenience guard for user-safe diagnostic/quality-warning strings reused by the BFF layer.
export function isSafeQualityWarning(value: unknown): value is string {
  return isSafeDisplaySummary(value);
}

export type { CheckpointFingerprint } from "./local-knowledge-large-document.js";

const LARGE_DOCUMENT_EXTRACTION_STRATEGIES_ADMISSION: readonly unknown[] =
  LARGE_DOCUMENT_EXTRACTION_STRATEGIES;
const EXTRACTION_PHASES_ADMISSION: readonly unknown[] = EXTRACTION_PHASES;
const COVERAGE_QUALITIES_ADMISSION: readonly unknown[] = COVERAGE_QUALITIES;
