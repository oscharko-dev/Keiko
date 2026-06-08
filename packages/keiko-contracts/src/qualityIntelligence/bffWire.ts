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
import type {
  QualityIntelligencePriority,
  QualityIntelligenceRiskClass,
  QualityIntelligenceTestCaseStatus,
} from "./testCaseCandidate.js";
import type { QualityIntelligenceReviewState } from "./reviewRecord.js";

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
  /**
   * Browser-safe projection of the generated test-case bodies (Issue #280). Empty when the run
   * produced no candidate artifact (e.g. a failed run or a legacy run recorded before candidate
   * persistence). Bodies are redacted by the producer before reaching this wire shape.
   */
  readonly candidates: readonly QualityIntelligenceUiCandidate[];
  readonly evidenceRefs: readonly QualityIntelligenceUiEvidenceRef[];
  /** Overall human-review state for the run (Issue #282); "open" until a reviewer acts. */
  readonly reviewState: QualityIntelligenceReviewState;
  /** The `qiEvidenceSchemaVersion` literal from the persisted manifest. */
  readonly manifestSchemaVersion: number;
}

/**
 * Browser-safe projection of a single generated test-case candidate (Issue #280/#282). Carries the
 * authored body for review + export. Never carries the raw model prompt or raw source content; the
 * producer redacts every string before constructing this shape.
 */
export interface QualityIntelligenceUiCandidate {
  readonly id: string;
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly expectedResults: readonly string[];
  readonly priority: QualityIntelligencePriority;
  readonly riskClass: QualityIntelligenceRiskClass;
  readonly tags: readonly string[];
  /** Generation status from the candidate body. */
  readonly status: QualityIntelligenceTestCaseStatus;
  /** Per-candidate review decision (Issue #282); "open" until a reviewer acts. */
  readonly reviewState: QualityIntelligenceReviewState;
  readonly derivedFromAtomIds: readonly string[];
}

// ─── Run start request (Issue #280/#281) ────────────────────────────────────────

export type QualityIntelligenceInlineSourceKind = "requirements" | "workspace";

/** A pasted free-text requirement blob the server splits into requirement atoms. */
export interface QualityIntelligenceRequirementsSource {
  readonly kind: "requirements";
  readonly label: string;
  readonly text: string;
}

/** A local workspace folder the server ingests through keiko-workspace (path containment applies). */
export interface QualityIntelligenceWorkspaceSource {
  readonly kind: "workspace";
  readonly label: string;
  readonly path: string;
}

export type QualityIntelligenceInlineSource =
  | QualityIntelligenceRequirementsSource
  | QualityIntelligenceWorkspaceSource;

/** Body of `POST /api/quality-intelligence/runs`. */
export interface QualityIntelligenceStartRunRequest {
  readonly sources: readonly QualityIntelligenceInlineSource[];
  /** Policy profile id; defaults to the regression profile when omitted. */
  readonly profileId?: string;
  /** Chat model id; defaults to the first configured chat model when omitted. */
  readonly modelId?: string;
}

// ─── Run progress stream (Issue #280) ────────────────────────────────────────────
//
// `POST /api/quality-intelligence/runs` responds with an SSE stream of these messages. Each carries
// only ids / counts / safe enums — never raw prompts, model output, credentials, or source content.

export interface QualityIntelligenceRunStreamAccepted {
  readonly type: "accepted";
  readonly runId: string;
  readonly requestedAt: string;
  readonly sourceCount: number;
  readonly atomCount: number;
}

export interface QualityIntelligenceRunStreamEvent {
  readonly type: "event";
  readonly kind: string;
  readonly sequence: number;
  readonly stageName?: string;
  readonly candidateId?: string;
  readonly findingId?: string;
  readonly reasonSummary?: string;
}

export interface QualityIntelligenceRunStreamDone {
  readonly type: "done";
  readonly runId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly totals: QualityIntelligenceUiRunTotals;
}

export interface QualityIntelligenceRunStreamError {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export type QualityIntelligenceRunStreamMessage =
  | QualityIntelligenceRunStreamAccepted
  | QualityIntelligenceRunStreamEvent
  | QualityIntelligenceRunStreamDone
  | QualityIntelligenceRunStreamError;
