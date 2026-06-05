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

export interface QualityIntelligenceFindingRow {
  readonly id: string;
  readonly kind: QualityIntelligenceValidationFindingKind;
  readonly severity: QualityIntelligenceSeverity;
  readonly summaryRedacted: string;
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
