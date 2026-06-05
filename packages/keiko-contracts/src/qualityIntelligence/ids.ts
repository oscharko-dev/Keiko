// Branded ID types for the Quality Intelligence contract surface (Epic #270, Issue #277).
//
// Pure types and pure runtime validators only — no IO, no clock reads, no hashing, no
// randomness. Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports
// may appear in this module.
//
// Branding follows the same `unique symbol` phantom-property style as
// `local-knowledge.ts` (KnowledgeCapsuleId etc.): the brand carrier never lands at
// runtime, so values survive JSON round-trips intact, but a bare `string` is not
// assignable to a branded type without an explicit `asX(...)` construction step.
//
// Each constructor enforces:
//   * non-empty after trim
//   * NFKC normalisation (rejected if normalisation would change the input — callers
//     must normalise themselves, so a brand never silently rewrites a value)
//   * max length 256
//   * no path-traversal segment ("..", "/", "\")
//   * no NUL or other ASCII control characters
//
// These rules deliberately match the audit-ledger `assertValidRunId` shape (ADR-0010,
// memory: keiko-issue10-audit-ledger) so an ID minted in QI can be safely composed
// with that surface in #274 without re-validation.

// ─── Brand carriers ────────────────────────────────────────────────────────────
declare const QualityIntelligenceRunIdBrand: unique symbol;
declare const QualityIntelligenceTestCaseIdBrand: unique symbol;
declare const QualityIntelligenceCoverageMapIdBrand: unique symbol;
declare const QualityIntelligenceValidationFindingIdBrand: unique symbol;
declare const QualityIntelligenceReviewRecordIdBrand: unique symbol;
declare const QualityIntelligenceExportBundleIdBrand: unique symbol;
declare const QualityIntelligenceSourceEnvelopeIdBrand: unique symbol;
declare const QualityIntelligenceEvidenceAtomIdBrand: unique symbol;
declare const QualityIntelligenceAuditSummaryIdBrand: unique symbol;

// ─── Branded types ─────────────────────────────────────────────────────────────
export type QualityIntelligenceRunId = string & {
  readonly [QualityIntelligenceRunIdBrand]: true;
};
export type QualityIntelligenceTestCaseId = string & {
  readonly [QualityIntelligenceTestCaseIdBrand]: true;
};
export type QualityIntelligenceCoverageMapId = string & {
  readonly [QualityIntelligenceCoverageMapIdBrand]: true;
};
export type QualityIntelligenceValidationFindingId = string & {
  readonly [QualityIntelligenceValidationFindingIdBrand]: true;
};
export type QualityIntelligenceReviewRecordId = string & {
  readonly [QualityIntelligenceReviewRecordIdBrand]: true;
};
export type QualityIntelligenceExportBundleId = string & {
  readonly [QualityIntelligenceExportBundleIdBrand]: true;
};
export type QualityIntelligenceSourceEnvelopeId = string & {
  readonly [QualityIntelligenceSourceEnvelopeIdBrand]: true;
};
export type QualityIntelligenceEvidenceAtomId = string & {
  readonly [QualityIntelligenceEvidenceAtomIdBrand]: true;
};
export type QualityIntelligenceAuditSummaryId = string & {
  readonly [QualityIntelligenceAuditSummaryIdBrand]: true;
};

// ─── Validation primitive ──────────────────────────────────────────────────────
const QI_ID_MAX_LENGTH = 256;

// Path-traversal segments and structural separators. NUL plus C0/C1 control ranges
// are caught by the control-character check below.
const QI_ID_FORBIDDEN_FRAGMENTS: readonly string[] = ["..", "/", "\\"];

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // C0 controls 0x00–0x1F, DEL 0x7F, C1 controls 0x80–0x9F.
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
};

const hasForbiddenFragment = (value: string): boolean =>
  QI_ID_FORBIDDEN_FRAGMENTS.some((fragment) => value.includes(fragment));

/**
 * Validates a candidate string is acceptable as a QI branded id, returning a typed
 * error message on rejection. Pure — no IO. Exported only for tests; production
 * callers should use the `asX` constructors.
 */
export const validateQualityIntelligenceIdString = (
  value: unknown,
  kind: string,
): { ok: true } | { ok: false; reason: string } => {
  if (typeof value !== "string") {
    return { ok: false, reason: `${kind} must be a string` };
  }
  if (value.length === 0) {
    return { ok: false, reason: `${kind} must not be empty` };
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: `${kind} must not be whitespace-only` };
  }
  if (value.length > QI_ID_MAX_LENGTH) {
    return { ok: false, reason: `${kind} exceeds max length ${String(QI_ID_MAX_LENGTH)}` };
  }
  if (value.normalize("NFKC") !== value) {
    return { ok: false, reason: `${kind} must be NFKC-normalised` };
  }
  if (hasControlCharacter(value)) {
    return { ok: false, reason: `${kind} contains control characters` };
  }
  if (hasForbiddenFragment(value)) {
    return { ok: false, reason: `${kind} contains forbidden path fragment` };
  }
  return { ok: true };
};

/**
 * Validate `value` and return it unchanged. Throws `TypeError` on rejection. The
 * caller casts the returned string to the appropriate branded type — keeping the
 * cast at the constructor site rather than inside this helper avoids an
 * unnecessary type parameter (lint: no-unnecessary-type-parameters).
 */
const construct = (value: string, kind: string): string => {
  const result = validateQualityIntelligenceIdString(value, kind);
  if (!result.ok) {
    throw new TypeError(`Invalid ${kind}: ${result.reason}`);
  }
  return value;
};

// ─── Constructors ──────────────────────────────────────────────────────────────
export const asQualityIntelligenceRunId = (value: string): QualityIntelligenceRunId =>
  construct(value, "QualityIntelligenceRunId") as QualityIntelligenceRunId;

export const asQualityIntelligenceTestCaseId = (value: string): QualityIntelligenceTestCaseId =>
  construct(value, "QualityIntelligenceTestCaseId") as QualityIntelligenceTestCaseId;

export const asQualityIntelligenceCoverageMapId = (
  value: string,
): QualityIntelligenceCoverageMapId =>
  construct(value, "QualityIntelligenceCoverageMapId") as QualityIntelligenceCoverageMapId;

export const asQualityIntelligenceValidationFindingId = (
  value: string,
): QualityIntelligenceValidationFindingId =>
  construct(
    value,
    "QualityIntelligenceValidationFindingId",
  ) as QualityIntelligenceValidationFindingId;

export const asQualityIntelligenceReviewRecordId = (
  value: string,
): QualityIntelligenceReviewRecordId =>
  construct(value, "QualityIntelligenceReviewRecordId") as QualityIntelligenceReviewRecordId;

export const asQualityIntelligenceExportBundleId = (
  value: string,
): QualityIntelligenceExportBundleId =>
  construct(value, "QualityIntelligenceExportBundleId") as QualityIntelligenceExportBundleId;

export const asQualityIntelligenceSourceEnvelopeId = (
  value: string,
): QualityIntelligenceSourceEnvelopeId =>
  construct(value, "QualityIntelligenceSourceEnvelopeId") as QualityIntelligenceSourceEnvelopeId;

export const asQualityIntelligenceEvidenceAtomId = (
  value: string,
): QualityIntelligenceEvidenceAtomId =>
  construct(value, "QualityIntelligenceEvidenceAtomId") as QualityIntelligenceEvidenceAtomId;

export const asQualityIntelligenceAuditSummaryId = (
  value: string,
): QualityIntelligenceAuditSummaryId =>
  construct(value, "QualityIntelligenceAuditSummaryId") as QualityIntelligenceAuditSummaryId;
