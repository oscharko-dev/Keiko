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
//   * no bidi-override / zero-width code point (these ids are rendered in the browser)
//
// These rules deliberately match the audit-ledger `assertValidRunId` shape (ADR-0010,
// memory: keiko-issue10-audit-ledger) so an ID minted in QI can be safely composed
// with that surface in #274 without re-validation.

import { containsBidiOrZeroWidth } from "../text-safety.js";

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
declare const QualityIntelligenceHandoffIdBrand: unique symbol;

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
// KEIKO-0593: identifies a Conversation Center handoff envelope (handoffEnvelope.ts). A distinct
// brand, not a reuse of QualityIntelligenceRunId or another existing brand -- it identifies a
// different entity (the handoff request, minted by the Conversation Center before any run may
// exist) per this file's own documented rule that each entity gets its own brand.
export type QualityIntelligenceHandoffId = string & {
  readonly [QualityIntelligenceHandoffIdBrand]: true;
};

// ─── Validation primitive ──────────────────────────────────────────────────────
const QI_ID_MAX_LENGTH = 256;

// Path-traversal segments and structural separators. NUL plus C0/C1 control ranges
// are caught by the control-character check below.
const QI_ID_FORBIDDEN_FRAGMENTS: readonly string[] = ["..", "/", "\\"];

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
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
  if (value !== value.trim()) {
    return { ok: false, reason: `${kind} must not have leading or trailing whitespace` };
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
  // Branded ids are rendered in the browser (run summaries, evidence refs, candidate lists), so an
  // id carrying U+202E renders as a different id than the one stored, and a zero-width character
  // makes two visually identical ids distinct — defeating the visual comparison a reviewer uses to
  // correlate a run with its evidence. The sibling display-surface guard already rejects exactly
  // these code points; this uses the same canonical predicate rather than a third copy.
  if (containsBidiOrZeroWidth(value)) {
    return { ok: false, reason: `${kind} contains invisible or reordering characters` };
  }
  if (hasForbiddenFragment(value)) {
    return { ok: false, reason: `${kind} contains forbidden path fragment` };
  }
  return { ok: true };
};

// Each specific constructor admits the existing lexical ID shape and preserves the original
// string. The phantom brand distinguishes entities; it does not attest historical issuance.

function assertQualityIntelligenceRunId(value: string): asserts value is QualityIntelligenceRunId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceRunId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceRunId: ${result.reason}`);
  }
}

export const asQualityIntelligenceRunId = (value: string): QualityIntelligenceRunId => {
  assertQualityIntelligenceRunId(value);
  return value;
};

function assertQualityIntelligenceTestCaseId(
  value: string,
): asserts value is QualityIntelligenceTestCaseId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceTestCaseId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceTestCaseId: ${result.reason}`);
  }
}

export const asQualityIntelligenceTestCaseId = (value: string): QualityIntelligenceTestCaseId => {
  assertQualityIntelligenceTestCaseId(value);
  return value;
};

function assertQualityIntelligenceCoverageMapId(
  value: string,
): asserts value is QualityIntelligenceCoverageMapId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceCoverageMapId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceCoverageMapId: ${result.reason}`);
  }
}

export const asQualityIntelligenceCoverageMapId = (
  value: string,
): QualityIntelligenceCoverageMapId => {
  assertQualityIntelligenceCoverageMapId(value);
  return value;
};

function assertQualityIntelligenceValidationFindingId(
  value: string,
): asserts value is QualityIntelligenceValidationFindingId {
  const result = validateQualityIntelligenceIdString(
    value,
    "QualityIntelligenceValidationFindingId",
  );
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceValidationFindingId: ${result.reason}`);
  }
}

export const asQualityIntelligenceValidationFindingId = (
  value: string,
): QualityIntelligenceValidationFindingId => {
  assertQualityIntelligenceValidationFindingId(value);
  return value;
};

function assertQualityIntelligenceReviewRecordId(
  value: string,
): asserts value is QualityIntelligenceReviewRecordId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceReviewRecordId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceReviewRecordId: ${result.reason}`);
  }
}

export const asQualityIntelligenceReviewRecordId = (
  value: string,
): QualityIntelligenceReviewRecordId => {
  assertQualityIntelligenceReviewRecordId(value);
  return value;
};

function assertQualityIntelligenceExportBundleId(
  value: string,
): asserts value is QualityIntelligenceExportBundleId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceExportBundleId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceExportBundleId: ${result.reason}`);
  }
}

export const asQualityIntelligenceExportBundleId = (
  value: string,
): QualityIntelligenceExportBundleId => {
  assertQualityIntelligenceExportBundleId(value);
  return value;
};

function assertQualityIntelligenceSourceEnvelopeId(
  value: string,
): asserts value is QualityIntelligenceSourceEnvelopeId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceSourceEnvelopeId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceSourceEnvelopeId: ${result.reason}`);
  }
}

export const asQualityIntelligenceSourceEnvelopeId = (
  value: string,
): QualityIntelligenceSourceEnvelopeId => {
  assertQualityIntelligenceSourceEnvelopeId(value);
  return value;
};

function assertQualityIntelligenceEvidenceAtomId(
  value: string,
): asserts value is QualityIntelligenceEvidenceAtomId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceEvidenceAtomId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceEvidenceAtomId: ${result.reason}`);
  }
}

export const asQualityIntelligenceEvidenceAtomId = (
  value: string,
): QualityIntelligenceEvidenceAtomId => {
  assertQualityIntelligenceEvidenceAtomId(value);
  return value;
};

function assertQualityIntelligenceAuditSummaryId(
  value: string,
): asserts value is QualityIntelligenceAuditSummaryId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceAuditSummaryId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceAuditSummaryId: ${result.reason}`);
  }
}

export const asQualityIntelligenceAuditSummaryId = (
  value: string,
): QualityIntelligenceAuditSummaryId => {
  assertQualityIntelligenceAuditSummaryId(value);
  return value;
};

function assertQualityIntelligenceHandoffId(
  value: string,
): asserts value is QualityIntelligenceHandoffId {
  const result = validateQualityIntelligenceIdString(value, "QualityIntelligenceHandoffId");
  if (!result.ok) {
    throw new TypeError(`Invalid QualityIntelligenceHandoffId: ${result.reason}`);
  }
}

export const asQualityIntelligenceHandoffId = (value: string): QualityIntelligenceHandoffId => {
  assertQualityIntelligenceHandoffId(value);
  return value;
};
