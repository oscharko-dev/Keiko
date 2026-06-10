// Quality Intelligence export bundle (Epic #270, Issue #277).
//
// An export bundle is a refs-only manifest of which candidates / coverage maps /
// findings to send to a downstream Test-Management System (TMS) or spreadsheet
// target. RAW CONTENT IS NEVER EMBEDDED — the runtime (#283) resolves refs and
// composes the wire payload at export time, applying TMS-specific redaction.
//
// Invariant: any TMS-targeted bundle MUST carry `redactionAttested === true`. The
// helper `assertExportBundleInvariant` enforces this so #283 cannot ship a bundle
// to a TMS without an attestation. Pure CSV/JSON/spreadsheet targets do not require
// attestation (the user has explicitly chosen a portable format).

import type {
  QualityIntelligenceCoverageMapId,
  QualityIntelligenceExportBundleId,
  QualityIntelligenceRunId,
  QualityIntelligenceTestCaseId,
  QualityIntelligenceValidationFindingId,
} from "./ids.js";

export type QualityIntelligenceExportAdapter =
  | "jira-issues"
  | "qtest"
  | "xray"
  | "polarion"
  | "alm"
  | "csv"
  | "json"
  | "spreadsheet-safe-csv"
  | "markdown"
  | "plain-text"
  | "quality-center";

export const QUALITY_INTELLIGENCE_EXPORT_ADAPTERS: readonly QualityIntelligenceExportAdapter[] = [
  "jira-issues",
  "qtest",
  "xray",
  "polarion",
  "alm",
  "csv",
  "json",
  "spreadsheet-safe-csv",
  "markdown",
  "plain-text",
  "quality-center",
] as const;

/** Adapters whose target is an external TMS — they require a redaction attestation. */
export const QUALITY_INTELLIGENCE_TMS_ADAPTERS: ReadonlySet<QualityIntelligenceExportAdapter> =
  new Set<QualityIntelligenceExportAdapter>([
    "jira-issues",
    "qtest",
    "xray",
    "polarion",
    "alm",
    "quality-center",
  ]);

export interface QualityIntelligenceExportBundleEntry {
  readonly candidateId: QualityIntelligenceTestCaseId;
  readonly coverageMapRefs: readonly QualityIntelligenceCoverageMapId[];
  readonly findingRefs: readonly QualityIntelligenceValidationFindingId[];
}

export interface QualityIntelligenceExportBundle {
  readonly id: QualityIntelligenceExportBundleId;
  readonly runId: QualityIntelligenceRunId;
  readonly targetAdapter: QualityIntelligenceExportAdapter;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
  /** Lowercase hex sha256 over the canonical refs payload. */
  readonly integrityHashSha256Hex: string;
  readonly redactionAttested: boolean;
  readonly contents: readonly QualityIntelligenceExportBundleEntry[];
}

/**
 * Enforce that a TMS-targeted bundle attests redaction, and that the integrity hash
 * field is a well-formed sha256 hex string. Throws `Error` on violation; returns
 * `void` on success.
 */
export const assertExportBundleInvariant = (bundle: QualityIntelligenceExportBundle): void => {
  if (!/^[0-9a-f]{64}$/u.test(bundle.integrityHashSha256Hex)) {
    throw new Error(
      `Export bundle integrity hash must be a lowercase sha256 hex string (id=${bundle.id})`,
    );
  }
  if (QUALITY_INTELLIGENCE_TMS_ADAPTERS.has(bundle.targetAdapter) && !bundle.redactionAttested) {
    throw new Error(
      `Export bundle targeting TMS adapter "${bundle.targetAdapter}" requires redactionAttested === true (id=${bundle.id})`,
    );
  }
};
