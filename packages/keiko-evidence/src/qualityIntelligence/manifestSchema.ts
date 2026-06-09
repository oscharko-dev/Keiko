// Quality Intelligence evidence manifest shape (Issue #274, Epic #270, ADR-0023 D8).
//
// Versioned, persistable record the QI workflow writes through `keiko-evidence` after each run.
// Carries ONLY references and counts — never raw prompts, never raw source content, never
// credentials. The shape mirrors the Keiko `EvidenceManifest` evolution rule: a breaking change
// introduces a new `qiEvidenceSchemaVersion` literal member rather than mutating the existing one.
//
// Schema-version `1`: aligned with `QUALITY_INTELLIGENCE_AUDIT_MANIFEST_SCHEMA_VERSION` in
// `@oscharko-dev/keiko-contracts`. The audit summary is the cross-referenced run aggregate;
// this manifest is the persistable evidence wrapper around it.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

type QualityIntelligenceExportAdapter = QualityIntelligence.QualityIntelligenceExportAdapter;
type QualityIntelligenceLifecycleStatus = QualityIntelligence.QualityIntelligenceLifecycleStatus;
type QualityIntelligenceRunId = QualityIntelligence.QualityIntelligenceRunId;
type QualityIntelligenceValidationFindingKind =
  QualityIntelligence.QualityIntelligenceValidationFindingKind;
type QualityIntelligenceSeverity = QualityIntelligence.QualityIntelligenceSeverity;
type QualityIntelligenceAuditSummaryId = QualityIntelligence.QualityIntelligenceAuditSummaryId;

export const QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION = 1 as const;

// Per-artifact-group SHA-256 integrity hashes (hex, lowercase). One hash per logical group so
// downstream consumers can verify each group independently. Group keys are the persisted
// collection names on the manifest itself.
export interface QualityIntelligenceIntegrityHashes {
  readonly findings: string;
  readonly exports: string;
  readonly evidenceRefs: string;
  readonly atomFingerprints?: string;
  /**
   * Hash of the persisted per-envelope source fingerprints (Epic #735). Drift detection falls back
   * to these when atom-level fingerprints are absent, so a tampered set could mis-report staleness;
   * hashing them makes that tampering detectable. Optional for backward-compat with manifests
   * written before it was hashed (enforced on read only when present).
   */
  readonly sourceFingerprints?: string;
  /** Hash of the persisted coverage matrix (Epic #734) so a tampered matrix is detectable. */
  readonly coverageMatrix?: string;
}

// Counts-only summary of what redaction did during build. We deliberately do NOT carry the
// matched text — only the per-pattern hit counts, so future audits can detect drift in noisy
// pipelines without leaking the matched secret.
export interface QualityIntelligenceRedactionSummary {
  readonly totalStringsScanned: number;
  readonly stringsRedacted: number;
  readonly patternsMatched: Readonly<Record<string, number>>;
}

export interface QualityIntelligenceManifestTotals {
  readonly candidates: number;
  readonly findings: number;
  readonly exports: number;
}

/** Per-atom coverage status row persisted in the run manifest (refs only, no raw text). */
export interface QualityIntelligenceCoverageMatrixRow {
  readonly atomId: string;
  readonly status: "covered" | "weakly-covered" | "uncovered";
  readonly confidence: number;
  readonly coveringCandidateIds: readonly string[];
}

export interface QualityIntelligenceFindingRow {
  readonly id: string;
  readonly kind: QualityIntelligenceValidationFindingKind;
  readonly severity: QualityIntelligenceSeverity;
  readonly summaryRedacted: string;
  /**
   * Optional candidate this finding is scoped to (Epic #736). Present on candidate-scoped findings
   * (e.g. test-quality, logic-defect) so the UI can associate a finding with a single test case;
   * absent on run-scoped findings (e.g. policy-violation).
   */
  readonly candidateId?: string;
}

export interface QualityIntelligenceExportRow {
  readonly id: string;
  readonly targetAdapter: QualityIntelligenceExportAdapter;
  readonly integrityHash: string;
  readonly redactionAttested: boolean;
}

export interface QualityIntelligenceEvidenceRefRow {
  readonly envelopeId: string;
  readonly atomId: string;
  readonly lifecycleStatus: QualityIntelligenceLifecycleStatus;
}

/** Per-envelope content fingerprint row persisted in the manifest (Epic #735, Issue #742). */
export interface QualityIntelligenceSourceFingerprintRow {
  readonly envelopeId: string;
  readonly integrityHashSha256Hex: string;
}

/** Per-atom content fingerprint row persisted in the manifest (Epic #735, Issues #798/#799). */
export interface QualityIntelligenceAtomFingerprintRow {
  readonly atomId: string;
  readonly envelopeId: string;
  readonly canonicalHashSha256Hex: string;
}

export interface QualityIntelligenceProvenanceRefs {
  readonly envelopeIds: readonly string[];
  readonly auditSummaryId: QualityIntelligenceAuditSummaryId;
}

// Versioned, persistable QI evidence record.
//
// Invariants the builder enforces:
// - `qiEvidenceSchemaVersion` is the literal `1` (per `QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION`).
// - Every string leaf has already been passed through `redactQualityIntelligenceEvidence`.
// - No raw prompt, no raw source content, no apiKey, no Bearer token reaches this shape — refs
//   (envelope ids, atom ids, sha-256 hashes) only.
// - `totals` MUST match the lengths of the corresponding collections (asserted on read).
export interface QualityIntelligenceEvidenceManifest {
  readonly qiEvidenceSchemaVersion: typeof QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION;
  readonly runId: QualityIntelligenceRunId;
  readonly planAt: string;
  readonly completedAt: string | undefined;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly policyProfileIds: readonly string[];
  readonly retentionPolicyId: string;
  readonly modelGatewayCallCount: number;
  readonly totals: QualityIntelligenceManifestTotals;
  readonly findings: readonly QualityIntelligenceFindingRow[];
  readonly exports: readonly QualityIntelligenceExportRow[];
  readonly evidenceRefs: readonly QualityIntelligenceEvidenceRefRow[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
  readonly redactionSummary: QualityIntelligenceRedactionSummary;
  readonly integrityHashes: QualityIntelligenceIntegrityHashes;
  /** Optional: per-atom coverage classification (refs + status, no raw text). Added in #738. */
  readonly coverageMatrix?: readonly QualityIntelligenceCoverageMatrixRow[];
  /** Optional: run quality score — percent of judged candidates rated "strong" [0-100]; null when the judge stage was skipped. Added in #736. */
  readonly qualityScore?: number | null;
  /** Optional: per-envelope content fingerprints for drift detection (Epic #735, Issue #742). */
  readonly sourceFingerprints?: readonly QualityIntelligenceSourceFingerprintRow[];
  /** Optional: per-atom content fingerprints for atom-aware drift detection (#798/#799). */
  readonly atomFingerprints?: readonly QualityIntelligenceAtomFingerprintRow[];
  /** Optional: model id that generated the candidates (Epic #761, Issue #763). */
  readonly modelId?: string;
  /** Optional: redaction-safe request parameter scalars (e.g. responseFormat, seed) (Epic #761). */
  readonly modelParameters?: Record<string, unknown>;
  /** Optional: seed used for deterministic sampling; null when model does not support seeding. */
  readonly seedUsed?: number | null;
}

// ─── Validation ────────────────────────────────────────────────────────────────────

// The set of allowed top-level keys. A persisted record carrying any extra key fails the
// strict-schema gate on read, matching the existing EvidenceManifest discipline. Update this set
// in lock-step with the interface above.
const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  "qiEvidenceSchemaVersion",
  "runId",
  "planAt",
  "completedAt",
  "status",
  "policyProfileIds",
  "retentionPolicyId",
  "modelGatewayCallCount",
  "totals",
  "findings",
  "exports",
  "evidenceRefs",
  "provenanceRefs",
  "redactionSummary",
  "integrityHashes",
  "coverageMatrix",
  "qualityScore",
  "sourceFingerprints",
  "atomFingerprints",
  "modelId",
  "modelParameters",
  "seedUsed",
]);

const ALLOWED_STATUSES: ReadonlySet<string> = new Set<string>([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export interface QualityIntelligenceSchemaValidationResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

// Strict-schema gate for a deserialised QI evidence record. Validates the schema-version literal,
// the closed set of top-level keys, and the status enum. Counts/integrity correctness is
// orthogonally enforced by the builder before persist.
export function validateQualityIntelligenceEvidenceManifest(
  value: unknown,
): QualityIntelligenceSchemaValidationResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "manifest is not an object" };
  }
  const record = value as Record<string, unknown>;
  if (record.qiEvidenceSchemaVersion !== QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unexpected qiEvidenceSchemaVersion (expected ${String(QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION)})`,
    };
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, reason: `unknown manifest key: ${key}` };
    }
  }
  const status = record.status;
  if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
    return { ok: false, reason: "invalid status" };
  }
  return { ok: true, reason: undefined };
}
