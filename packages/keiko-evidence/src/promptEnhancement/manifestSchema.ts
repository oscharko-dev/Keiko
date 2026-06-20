// Prompt Enhancement evidence manifest shape (Epic #1307, Issue #1313; ADR-0044 §1/§5).
//
// Versioned, persistable record the Prompt Enhancer writes through `keiko-evidence` after a run.
// Mirrors the Quality Intelligence evidence template (record → redact → hash → validate → write) but
// for the enhancer domain. It captures exactly what AC4 requires — the original input, the enhanced
// output, the applied rules, the assumptions, the candidate scores, the model metadata when
// applicable, and the verification status — and NOTHING that could leak a secret: the original input is
// a SHA-256 fingerprint plus a redacted, truncated excerpt; every other free-text field is passed
// through the security redactor before it reaches this shape.
//
// Schema evolution follows the EVIDENCE_SCHEMA_VERSION rule: a breaking structural change introduces a
// NEW `peEvidenceSchemaVersion` literal member rather than mutating the current literal, so persisted artefacts stay
// discriminable across versions.

import type {
  GroundingDirective,
  LeastPrivilegeConstraint,
  PromptSafetyDecision,
  PromptSafetyVerificationStatus,
  PromptSafetyViolationCode,
} from "@oscharko-dev/keiko-contracts";
import {
  GROUNDING_DIRECTIVES,
  LEAST_PRIVILEGE_CONSTRAINTS,
  PROMPT_SAFETY_DECISIONS,
  PROMPT_SAFETY_VERIFICATION_STATUSES,
  isPromptSafetyViolationCode,
} from "@oscharko-dev/keiko-contracts";

export const PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION = 2 as const;

// The overall lifecycle outcome of an enhancement run, aligned with the validate-stage decision.
export type PromptEnhancementEvidenceStatus = "validated" | "requires-human-review" | "rejected";

const ALLOWED_STATUSES: ReadonlySet<string> = new Set<string>([
  "validated",
  "requires-human-review",
  "rejected",
]);

// Counts-only redaction summary — the matched text is never preserved (lossy by design), only the
// per-pattern hit counts so an audit can detect drift without leaking the matched secret.
export interface PromptEnhancementRedactionSummary {
  readonly totalStringsScanned: number;
  readonly stringsRedacted: number;
  readonly patternsMatched: Readonly<Record<string, number>>;
}

// One candidate's transparent score (AC4 — candidate scores). Content-light: ids, profile, and the
// numeric scores only; the critic rationales are reproducible from the deterministic critic and are
// not persisted here.
export interface PromptEnhancementCandidateScoreRow {
  readonly candidateId: string;
  readonly profile: string;
  readonly aggregateScore: number;
  readonly estimatedTokens: number;
  readonly selected: boolean;
}

// The verification record (AC4 — verification status). Closed-vocabulary codes only; no free text.
export interface PromptEnhancementSafetyRecord {
  readonly decision: PromptSafetyDecision;
  readonly verificationStatus: PromptSafetyVerificationStatus;
  readonly requiresHumanReview: boolean;
  readonly findingCodes: readonly PromptSafetyViolationCode[];
  readonly leastPrivilege: readonly LeastPrivilegeConstraint[];
}

// Model metadata when applicable (AC4). The #1312 MVP is fully deterministic (`deterministic: true`,
// no `modelId`); a future model-assisted stage records a content-free `modelId` and the profile used.
export interface PromptEnhancementModelMetadata {
  readonly deterministic: boolean;
  readonly modelId?: string;
  readonly profile?: string;
}

// Per-group SHA-256 integrity hashes (hex, lowercase) so each logical group can be verified on read.
export interface PromptEnhancementIntegrityHashes {
  readonly enhancedOutput: string;
  readonly appliedRules: string;
  readonly candidateScores: string;
  readonly record: string;
}

export interface PromptEnhancementManifestTotals {
  readonly candidateScores: number;
  readonly appliedSafetyRules: number;
  readonly assumptions: number;
  readonly safetyFindings: number;
}

// Versioned, persistable Prompt Enhancement evidence record.
//
// Invariants the builder enforces:
// - `peEvidenceSchemaVersion` is the current schema literal.
// - Every free-text leaf has already been passed through the security redactor.
// - No raw secret reaches this shape: the original input is a SHA-256 fingerprint + a redacted excerpt;
//   the enhanced output and applied rules are redacted strings; everything else is ids / enums /
//   numbers.
// - `totals` MUST match the lengths of the corresponding collections (asserted on read).
// - `integrityHashes` MUST match the SHA-256 of the redacted groups (asserted on read).
export interface PromptEnhancementEvidenceManifest {
  readonly peEvidenceSchemaVersion: typeof PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly recordedAt: string;
  readonly requestId: string;
  readonly status: PromptEnhancementEvidenceStatus;
  // Original input (AC4): a stable fingerprint plus a redacted, truncated excerpt — never raw text.
  readonly inputRedactedFingerprintSha256: string;
  readonly inputExcerptRedacted: string;
  // Enhanced output (AC4): the selected prompt id + a redacted rendered view.
  readonly enhancedPromptId: string;
  readonly enhancedPromptTextRedacted: string;
  // Applied rules (AC4): the safety rules and grounding directives the prompt carries.
  readonly appliedSafetyRules: readonly string[];
  readonly appliedGroundingDirectives: readonly GroundingDirective[];
  // Assumptions (AC4): the explicit assumptions surfaced to the user.
  readonly assumptions: readonly string[];
  // Candidate scores (AC4).
  readonly candidateScores: readonly PromptEnhancementCandidateScoreRow[];
  // Verification status (AC4).
  readonly safety: PromptEnhancementSafetyRecord;
  // Model metadata when applicable (AC4).
  readonly modelMetadata: PromptEnhancementModelMetadata;
  readonly redactionSummary: PromptEnhancementRedactionSummary;
  readonly integrityHashes: PromptEnhancementIntegrityHashes;
  readonly totals: PromptEnhancementManifestTotals;
}

// ─── Strict-schema gate ──────────────────────────────────────────────────────────────
// The closed set of allowed top-level keys. A persisted record carrying any extra key fails the gate
// on read, matching the EvidenceManifest discipline. Update in lock-step with the interface above.
const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  "peEvidenceSchemaVersion",
  "runId",
  "recordedAt",
  "requestId",
  "status",
  "inputRedactedFingerprintSha256",
  "inputExcerptRedacted",
  "enhancedPromptId",
  "enhancedPromptTextRedacted",
  "appliedSafetyRules",
  "appliedGroundingDirectives",
  "assumptions",
  "candidateScores",
  "safety",
  "modelMetadata",
  "redactionSummary",
  "integrityHashes",
  "totals",
]);

export interface PromptEnhancementSchemaValidationResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isUnitInterval = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isUniqueStringArray = (
  value: unknown,
  allowed: readonly string[],
): value is readonly string[] =>
  isStringArray(value) &&
  value.every((entry) => allowed.includes(entry)) &&
  new Set(value).size === value.length;

const isGroundingDirectiveArray = (value: unknown): value is readonly GroundingDirective[] =>
  isUniqueStringArray(value, GROUNDING_DIRECTIVES);

const isLeastPrivilegeArray = (value: unknown): value is readonly LeastPrivilegeConstraint[] =>
  isUniqueStringArray(value, LEAST_PRIVILEGE_CONSTRAINTS);

function validateRedactionSummary(value: unknown): string | undefined {
  if (!isRecord(value)) return "redactionSummary must be an object";
  if (!isNonNegativeInteger(value.totalStringsScanned)) {
    return "redactionSummary.totalStringsScanned must be a non-negative integer";
  }
  if (!isNonNegativeInteger(value.stringsRedacted)) {
    return "redactionSummary.stringsRedacted must be a non-negative integer";
  }
  if (!isRecord(value.patternsMatched)) {
    return "redactionSummary.patternsMatched must be an object";
  }
  if (Object.values(value.patternsMatched).some((count) => !isNonNegativeInteger(count))) {
    return "redactionSummary.patternsMatched values must be non-negative integers";
  }
  return undefined;
}

function validateIntegrityHashes(value: unknown): string | undefined {
  if (!isRecord(value)) return "integrityHashes must be an object";
  for (const key of ["enhancedOutput", "appliedRules", "candidateScores", "record"] as const) {
    if (typeof value[key] !== "string" || !HEX_SHA256.test(value[key])) {
      return `integrityHashes.${key} must be a SHA-256 hex digest`;
    }
  }
  return undefined;
}

function validateCandidateScoreRow(row: unknown, index: number): string | undefined {
  const label = `candidateScores[${String(index)}]`;
  if (!isRecord(row)) return `${label} must be an object`;
  if (typeof row.candidateId !== "string" || row.candidateId.length === 0) {
    return `${label}.candidateId must be a non-empty string`;
  }
  if (typeof row.profile !== "string" || row.profile.length === 0) {
    return `${label}.profile must be a non-empty string`;
  }
  if (!isUnitInterval(row.aggregateScore)) {
    return `${label}.aggregateScore must be a number in [0, 1]`;
  }
  if (!isNonNegativeInteger(row.estimatedTokens)) {
    return `${label}.estimatedTokens must be a non-negative integer`;
  }
  if (typeof row.selected !== "boolean") {
    return `${label}.selected must be a boolean`;
  }
  return undefined;
}

function validateCandidateScoreRows(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "candidateScores must be an array";
  for (const [index, row] of value.entries()) {
    const error = validateCandidateScoreRow(row, index);
    if (error !== undefined) return error;
  }
  return undefined;
}

function validateSafetyRecordScalars(value: Record<string, unknown>): string | undefined {
  if (
    typeof value.decision !== "string" ||
    !PROMPT_SAFETY_DECISIONS.includes(value.decision as PromptSafetyDecision)
  ) {
    return "safety.decision must be a known safety decision";
  }
  if (
    typeof value.verificationStatus !== "string" ||
    !PROMPT_SAFETY_VERIFICATION_STATUSES.includes(
      value.verificationStatus as PromptSafetyVerificationStatus,
    )
  ) {
    return "safety.verificationStatus must be a known verification status";
  }
  if (typeof value.requiresHumanReview !== "boolean") {
    return "safety.requiresHumanReview must be a boolean";
  }
  return undefined;
}

function validateSafetyRecordLists(value: Record<string, unknown>): string | undefined {
  if (
    !Array.isArray(value.findingCodes) ||
    value.findingCodes.some((code) => !isPromptSafetyViolationCode(code))
  ) {
    return "safety.findingCodes must be an array of known violation codes";
  }
  if (!isLeastPrivilegeArray(value.leastPrivilege)) {
    return "safety.leastPrivilege must be an array of unique least-privilege constraints";
  }
  return undefined;
}

function validateAcceptedSafetyStatus(value: Record<string, unknown>): string | undefined {
  if (
    value.decision !== "accepted" ||
    value.verificationStatus !== "passed" ||
    value.requiresHumanReview
  ) {
    return "status validated must match an accepted safety record";
  }
  return undefined;
}

function validateReviewSafetyStatus(value: Record<string, unknown>): string | undefined {
  const leastPrivilege = value.leastPrivilege as readonly LeastPrivilegeConstraint[];
  if (
    value.decision !== "requires-human-review" ||
    value.verificationStatus !== "passed-with-review" ||
    !value.requiresHumanReview ||
    !leastPrivilege.includes("require-human-approval")
  ) {
    return "status requires-human-review must match a review-gated safety record";
  }
  return undefined;
}

function validateRejectedSafetyStatus(value: Record<string, unknown>): string | undefined {
  const findingCodes = value.findingCodes as readonly PromptSafetyViolationCode[];
  if (
    value.decision !== "rejected" ||
    value.verificationStatus !== "failed" ||
    findingCodes.length === 0
  ) {
    return "status rejected must match a failed safety record with findings";
  }
  return undefined;
}

function validateSafetyStatusConsistency(
  value: Record<string, unknown>,
  status: PromptEnhancementEvidenceStatus,
): string | undefined {
  if (status === "validated") return validateAcceptedSafetyStatus(value);
  if (status === "requires-human-review") return validateReviewSafetyStatus(value);
  return validateRejectedSafetyStatus(value);
}

function validateSafetyRecord(
  value: unknown,
  status: PromptEnhancementEvidenceStatus,
): string | undefined {
  if (!isRecord(value)) return "safety must be an object";
  return (
    validateSafetyRecordScalars(value) ??
    validateSafetyRecordLists(value) ??
    validateSafetyStatusConsistency(value, status)
  );
}

function validateModelMetadata(value: unknown): string | undefined {
  if (!isRecord(value)) return "modelMetadata must be an object";
  if (typeof value.deterministic !== "boolean") {
    return "modelMetadata.deterministic must be a boolean";
  }
  if (value.modelId !== undefined && typeof value.modelId !== "string") {
    return "modelMetadata.modelId must be a string when present";
  }
  if (value.profile !== undefined && typeof value.profile !== "string") {
    return "modelMetadata.profile must be a string when present";
  }
  return undefined;
}

function validateTotals(value: unknown): string | undefined {
  if (!isRecord(value)) return "totals must be an object";
  for (const key of [
    "candidateScores",
    "appliedSafetyRules",
    "assumptions",
    "safetyFindings",
  ] as const) {
    if (!isNonNegativeInteger(value[key])) {
      return `totals.${key} must be a non-negative integer`;
    }
  }
  return undefined;
}

const schemaError = (reason: string): PromptEnhancementSchemaValidationResult => ({
  ok: false,
  reason,
});

function validateManifestIdentityFields(record: Record<string, unknown>): string | undefined {
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    return "runId must be a non-empty string";
  }
  if (typeof record.recordedAt !== "string" || Number.isNaN(Date.parse(record.recordedAt))) {
    return "recordedAt must be an ISO timestamp string";
  }
  if (typeof record.requestId !== "string" || record.requestId.length === 0) {
    return "requestId must be a non-empty string";
  }
  return undefined;
}

function validateManifestTextFields(record: Record<string, unknown>): string | undefined {
  if (
    typeof record.inputRedactedFingerprintSha256 !== "string" ||
    !HEX_SHA256.test(record.inputRedactedFingerprintSha256)
  ) {
    return "inputRedactedFingerprintSha256 must be a SHA-256 hex digest";
  }
  for (const key of [
    "inputExcerptRedacted",
    "enhancedPromptId",
    "enhancedPromptTextRedacted",
  ] as const) {
    if (typeof record[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  return undefined;
}

function validateManifestCollectionFields(record: Record<string, unknown>): string | undefined {
  if (!isStringArray(record.appliedSafetyRules)) {
    return "appliedSafetyRules must be an array of strings";
  }
  if (!isGroundingDirectiveArray(record.appliedGroundingDirectives)) {
    return "appliedGroundingDirectives must be an array of unique grounding directives";
  }
  if (!isStringArray(record.assumptions)) {
    return "assumptions must be an array of strings";
  }
  return undefined;
}

function validateManifestNestedFields(
  record: Record<string, unknown>,
  status: PromptEnhancementEvidenceStatus,
): string | undefined {
  const candidateError = validateCandidateScoreRows(record.candidateScores);
  if (candidateError !== undefined) return candidateError;
  const safetyError = validateSafetyRecord(record.safety, status);
  if (safetyError !== undefined) return safetyError;
  const modelMetadataError = validateModelMetadata(record.modelMetadata);
  if (modelMetadataError !== undefined) return modelMetadataError;
  const redactionError = validateRedactionSummary(record.redactionSummary);
  if (redactionError !== undefined) return redactionError;
  const integrityError = validateIntegrityHashes(record.integrityHashes);
  if (integrityError !== undefined) return integrityError;
  const totalsError = validateTotals(record.totals);
  if (totalsError !== undefined) return totalsError;
  return undefined;
}

function validateManifestFields(
  record: Record<string, unknown>,
): PromptEnhancementSchemaValidationResult {
  const status = record.status as PromptEnhancementEvidenceStatus;
  const error =
    validateManifestIdentityFields(record) ??
    validateManifestTextFields(record) ??
    validateManifestCollectionFields(record) ??
    validateManifestNestedFields(record, status);
  if (error !== undefined) return schemaError(error);
  return { ok: true, reason: undefined };
}

/**
 * Strict-schema gate for a deserialised Prompt Enhancement evidence record. Validates the
 * schema-version literal, the closed set of top-level keys, and the status enum. Counts/integrity
 * correctness is orthogonally enforced by the builder before persist and re-checked on read by the
 * store.
 */
export function validatePromptEnhancementEvidenceManifest(
  value: unknown,
): PromptEnhancementSchemaValidationResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "manifest is not an object" };
  }
  const record = value as Record<string, unknown>;
  if (record.peEvidenceSchemaVersion !== PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unexpected peEvidenceSchemaVersion (expected ${String(PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION)})`,
    };
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, reason: `unknown manifest key: ${key}` };
    }
  }
  if (typeof record.status !== "string" || !ALLOWED_STATUSES.has(record.status)) {
    return { ok: false, reason: "invalid status" };
  }
  return validateManifestFields(record);
}
