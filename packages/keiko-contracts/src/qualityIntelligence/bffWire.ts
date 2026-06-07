// Quality Intelligence BFF wire shapes (Issue #280, Epic #270).
//
// Browser-safe, redacted projections of QI evidence manifests for the Keiko UI.
// These types carry ONLY references and counts — never raw prompts, never raw source
// content, never credentials, endpoint URLs, or unsafe markdown. Producers must redact
// before constructing these shapes.
//
// Shape taxonomy:
//   QualityIntelligenceUiRunSummary  — list-view projection (id, status, dates, totals)
//   QualityIntelligenceUiFindingSummary — per-finding row for the detail panel
//   QualityIntelligenceUiEvidenceRef — evidence reference for the detail panel
//   QualityIntelligenceUiRunDetail   — single-run detail projection (adds finding refs,
//                                      candidate ids, evidence refs, schema version)
//
// Invariants enforced by BFF producers:
//   - No field that appears here derives from a raw prompt, API key, bearer token,
//     or secret value.
//   - `summaryRedacted` on finding rows has already been passed through the QI
//     redaction pipeline before reaching this wire type.
//   - completedAt is null (not undefined) when the run has not yet finished so JSON
//     serialisation is deterministic.

import type { QualityIntelligenceValidationFindingKind } from "./validationFinding.js";
import type { QualityIntelligenceSeverity } from "./validationFinding.js";

/** Counts-only totals carried on both the list-view and the detail view. */
export interface QualityIntelligenceUiRunTotals {
  readonly candidates: number;
  readonly findings: number;
  readonly exports: number;
}

/** List-view projection — only what the run list needs. */
export interface QualityIntelligenceUiRunSummary {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  /** ISO 8601 timestamp. */
  readonly requestedAt: string;
  /** ISO 8601 timestamp, or null when the run has not yet completed. */
  readonly completedAt: string | null;
  readonly totals: QualityIntelligenceUiRunTotals;
}

/**
 * Response envelope for `GET /api/quality-intelligence/runs` (issue #646).
 *
 * The list route bounds manifest loading by a default limit and reports how many run ids the
 * underlying store knows about so the UI can render a "more available" indicator without doing
 * a second pass. Producers MUST cap the `runs` array at `limit` and set `truncated = true` when
 * `totalRunIds > limit`. Additive on the wire: legacy clients reading `runs` continue to work.
 */
export interface QualityIntelligenceUiRunListResponse {
  readonly runs: readonly QualityIntelligenceUiRunSummary[];
  /** Effective limit applied for this response (default or explicit, capped at the route max). */
  readonly limit: number;
  /** Total run ids the store reported (may exceed runs.length when truncated). */
  readonly totalRunIds: number;
  /** True when totalRunIds > limit; the response omits the tail of the run list. */
  readonly truncated: boolean;
}

/**
 * Per-finding row for the findings panel.
 * `summaryRedacted` is a non-secret single-sentence description already passed through
 * the QI redaction pipeline. Producers MUST NOT send raw validator output here.
 */
export interface QualityIntelligenceUiFindingSummary {
  readonly id: string;
  readonly kind: QualityIntelligenceValidationFindingKind;
  readonly severity: QualityIntelligenceSeverity;
  /** Already redacted by the QI redaction pipeline before reaching the BFF. */
  readonly summaryRedacted: string;
}

/** Evidence reference row — envelope id and atom id only, no content. */
export interface QualityIntelligenceUiEvidenceRef {
  readonly envelopeId: string;
  readonly atomId: string;
}

/**
 * Single-run detail projection.
 * Adds full finding rows, candidate id refs, evidence refs, and the manifest schema
 * version. Never carries raw prompts, model output, credentials, or provider URLs.
 */
export interface QualityIntelligenceUiRunDetail {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  /** ISO 8601 timestamp. */
  readonly requestedAt: string;
  /** ISO 8601 timestamp, or null when the run has not yet completed. */
  readonly completedAt: string | null;
  readonly totals: QualityIntelligenceUiRunTotals;
  readonly findingRefs: readonly QualityIntelligenceUiFindingSummary[];
  readonly candidateIds: readonly string[];
  readonly evidenceRefs: readonly QualityIntelligenceUiEvidenceRef[];
  /** The `qiEvidenceSchemaVersion` literal from the persisted manifest. */
  readonly manifestSchemaVersion: number;
}
