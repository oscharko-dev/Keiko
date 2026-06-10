// Quality Intelligence audit summary (Epic #270, Issue #277).
//
// The audit summary is the persistable, versioned manifest the audit ledger (#274)
// records per QI run. The `manifestSchemaVersion` literal `1` follows the same
// evolution rule as EVIDENCE_SCHEMA_VERSION: a breaking change introduces a new
// literal member rather than mutating the existing one.

import type { QualityIntelligenceAuditSummaryId, QualityIntelligenceRunId } from "./ids.js";

export const QUALITY_INTELLIGENCE_AUDIT_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface QualityIntelligenceAuditTotals {
  readonly candidates: number;
  readonly findings: number;
  readonly exports: number;
  readonly reviews: number;
}

export interface QualityIntelligenceEvidenceRetentionSummary {
  readonly retainedDays: number;
  readonly totalAtoms: number;
}

export interface QualityIntelligenceAuditSummary {
  readonly id: QualityIntelligenceAuditSummaryId;
  readonly runId: QualityIntelligenceRunId;
  readonly manifestSchemaVersion: typeof QUALITY_INTELLIGENCE_AUDIT_MANIFEST_SCHEMA_VERSION;
  readonly totals: QualityIntelligenceAuditTotals;
  /** Display-only policy profile names applied to this run. */
  readonly policyProfiles: readonly string[];
  readonly modelGatewayCallCount: number;
  readonly evidenceRetentionSummary: QualityIntelligenceEvidenceRetentionSummary;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
}
