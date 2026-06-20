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
// NEW `peEvidenceSchemaVersion` literal member rather than mutating `1`, so persisted artefacts stay
// discriminable across versions.

import type {
  GroundingDirective,
  LeastPrivilegeConstraint,
  PromptSafetyDecision,
  PromptSafetyVerificationStatus,
  PromptSafetyViolationCode,
} from "@oscharko-dev/keiko-contracts";

export const PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION = 1 as const;

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
// - `peEvidenceSchemaVersion` is the literal `1`.
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
  readonly inputFingerprintSha256: string;
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
  "inputFingerprintSha256",
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
  return { ok: true, reason: undefined };
}
