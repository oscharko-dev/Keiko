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

/**
 * Every adapter classified by export target. This is a TOTAL Record, not a hand-listed Set: a Set
 * failed OPEN — a new adapter that nobody remembered to add was silently treated as "portable" and
 * escaped the redaction-attestation requirement, which is the one control standing between a
 * quality-intelligence export and an external tracker. A Record keyed by the union makes a new
 * adapter a COMPILE error until it is classified.
 */
export const QUALITY_INTELLIGENCE_EXPORT_ADAPTER_TARGETS: Readonly<
  Record<QualityIntelligenceExportAdapter, "tms" | "portable">
> = Object.freeze({
  "jira-issues": "tms",
  qtest: "tms",
  xray: "tms",
  polarion: "tms",
  alm: "tms",
  "quality-center": "tms",
  csv: "portable",
  json: "portable",
  "spreadsheet-safe-csv": "portable",
  markdown: "portable",
  "plain-text": "portable",
});

/** Adapters whose target is an external TMS — they require a redaction attestation. */
export const QUALITY_INTELLIGENCE_TMS_ADAPTERS: ReadonlySet<QualityIntelligenceExportAdapter> =
  new Set<QualityIntelligenceExportAdapter>(
    (
      Object.entries(QUALITY_INTELLIGENCE_EXPORT_ADAPTER_TARGETS) as readonly (readonly [
        QualityIntelligenceExportAdapter,
        "tms" | "portable",
      ])[]
    )
      .filter(([, target]) => target === "tms")
      .map(([adapter]) => adapter),
  );

export interface QualityIntelligenceExportBundleEntry {
  readonly candidateId: QualityIntelligenceTestCaseId;
  readonly coverageMapRefs: readonly QualityIntelligenceCoverageMapId[];
  readonly findingRefs: readonly QualityIntelligenceValidationFindingId[];
}

export interface QualityIntelligenceExportModelStageProvenance {
  readonly modelId: string;
  readonly provider: string;
  readonly revision: string;
}

export interface QualityIntelligenceExportModelProvenance {
  readonly generation: QualityIntelligenceExportModelStageProvenance;
  readonly judge: QualityIntelligenceExportModelStageProvenance;
  readonly seedUsed?: number | null;
  readonly modelParameters?: Readonly<Record<string, unknown>>;
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
  readonly diagnostics?: readonly string[];
  readonly modelProvenance?: QualityIntelligenceExportModelProvenance;
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
