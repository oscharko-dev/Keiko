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
//                                      candidate ids, evidence refs, schema version, drift metadata)
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
  /** Overall human-review state for the run (Issue #282); "open" until a reviewer acts. */
  readonly reviewState: QualityIntelligenceReviewState;
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
 * Per-atom coverage row for the UI. Refs plus an optional short REDACTED requirement excerpt
 * (#790) so the Gap Radar can name the requirement, not just its opaque atom id. Never raw atom
 * text — the excerpt is redacted+truncated at build time and redacted again at persist time.
 * Absent on runs recorded before #790.
 */
export interface QualityIntelligenceUiAtomCoverage {
  readonly atomId: string;
  readonly status: "covered" | "weakly-covered" | "uncovered";
  readonly confidence: number;
  readonly requirementExcerptRedacted?: string;
}

/**
 * Weak-test flag surfaced when the adversarial test-quality judge (Epic #736) classified a
 * candidate as weak. Carries only the redacted judge rationale and the finding severity — never
 * raw model output. Absent on a candidate that the judge rated strong or that was never judged.
 */
export interface QualityIntelligenceUiWeakTestFlag {
  readonly severity: QualityIntelligenceSeverity;
  /** Single-sentence reason, already passed through the QI redaction pipeline. */
  readonly rationale: string;
}

export interface QualityIntelligenceUiDriftMetadata {
  /**
   * GET run detail is read-only: it reports whether drift tracking metadata exists, but never
   * re-reads local sources. Clients call re-check with current source handles to compute staleness.
   */
  readonly status: "not-checked" | "unavailable";
  /** Count only; raw fingerprint hashes stay in evidence and are never sent to the browser. */
  readonly sourceFingerprintCount: number;
  /** Count only; raw atom hashes stay in evidence and are never sent to the browser. */
  readonly atomFingerprintCount: number;
  readonly reCheckSupported: boolean;
  readonly regenerateStaleSupported: boolean;
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
  /** Coverage percentage: (covered atoms / total atoms) × 100. 0 when no matrix is available. */
  readonly coveragePercentage: number;
  /** Per-atom coverage classification (refs + status; empty when no matrix is available). */
  readonly coverageByAtom: readonly QualityIntelligenceUiAtomCoverage[];
  /**
   * Run quality score: the percentage of judged candidates the adversarial judge rated "strong"
   * [0-100] (Epic #736) — 100 = every judged test is strong, 0 = every judged test is weak. Null
   * when the judge stage was skipped, unavailable, or no candidate was judged.
   */
  readonly qualityScore: number | null;
  /** Browser-safe Living Tests drift metadata; never contains raw source text, paths, or hashes. */
  readonly drift: QualityIntelligenceUiDriftMetadata;
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
  /**
   * Present only when the adversarial test-quality judge (Epic #736) flagged this candidate as
   * weak. Omitted entirely when the candidate was rated strong or was never judged.
   */
  readonly weakTestFlag?: QualityIntelligenceUiWeakTestFlag;
}

// ─── Living Tests drift report (Epic #735, Issue #743/#744) ──────────────────────

/** Why a single candidate is stale: its source changed, or its source is gone. */
export interface QualityIntelligenceUiStalenessEntry {
  readonly candidateId: string;
  readonly reason: "source-changed" | "source-removed";
  readonly envelopeId: string;
}

/**
 * Response of `POST /api/quality-intelligence/runs/:id/re-check`. Reports which generated tests
 * are still fresh and which drifted because their source fingerprint changed (or vanished) since
 * the run was recorded. Refs only — no raw source text.
 */
export interface QualityIntelligenceUiStalenessReport {
  readonly runId: string;
  /** changedStale.length + orphanedStale.length. */
  readonly staleCount: number;
  readonly fresh: readonly string[];
  readonly changedStale: readonly QualityIntelligenceUiStalenessEntry[];
  readonly orphanedStale: readonly QualityIntelligenceUiStalenessEntry[];
}

/**
 * Response of `POST /api/quality-intelligence/runs/:id/regenerate-stale`. Targeted regeneration
 * writes a NEW immutable run; `runId` is that new run's id. Fresh candidates + human edits are
 * preserved (`preservedCount`); only the stale subset is regenerated (`regeneratedCount`).
 */
export interface QualityIntelligenceUiRegenerateResult {
  readonly runId: string;
  readonly regeneratedCount: number;
  readonly preservedCount: number;
}

// ─── Run start request (Issue #280/#281) ────────────────────────────────────────

export type QualityIntelligenceInlineSourceKind =
  | "requirements"
  | "workspace"
  | "file"
  | "capsule"
  | "capsule-set"
  | "figma-snapshot";

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

/**
 * A single local file — one Fachkonzept document (Markdown / plain text / source file) the server
 * ingests through keiko-workspace as exactly one source atom. The same path containment, deny
 * rules, size cap, and redaction that protect the folder path apply identically here; binary or
 * unsupported files are rejected with a coded, user-actionable error rather than partially
 * ingested. `path` is an absolute local path resolved server-side (Epic #709, Issue #713).
 */
export interface QualityIntelligenceFileSource {
  readonly kind: "file";
  readonly label: string;
  readonly path: string;
}

/**
 * A Local Knowledge capsule — an indexed knowledge capsule the server ingests by reading its full
 * document corpus through keiko-local-knowledge. The capsuleId must match an existing indexed
 * capsule; if the capsule is unavailable the server responds with QI_CAPSULE_UNAVAILABLE (Epic
 * #710, Issue #717).
 */
export interface QualityIntelligenceCapsuleSource {
  readonly kind: "capsule";
  readonly label: string;
  readonly capsuleId: string;
}

/**
 * A Local Knowledge capsule-SET — a named composition of capsules the server expands into its
 * member capsules and ingests as one combined corpus. The capsuleSetId must match an existing
 * capsule-set; an unknown or empty set is rejected with QI_CAPSULE_UNAVAILABLE (Epic #710,
 * Issue #716/#717). The contract mirrors the single-capsule source so the connector picker can bind
 * either a capsule or a capsule-set to the QI hub (Issue #718).
 */
export interface QualityIntelligenceCapsuleSetSource {
  readonly kind: "capsule-set";
  readonly label: string;
  readonly capsuleSetId: string;
}

/**
 * A stored Figma Snapshot (Epic #750, Issue #753/#754) the server ingests by loading the immutable
 * snapshot evidence record for `snapshotRunId` and deriving a deterministic, citation-ready
 * structural test baseline per screen from its Screen-IR (fields/controls/screens/states), enriched
 * by capability-routed vision only when a multimodal model is available. This source never contacts
 * Figma — it reads ONLY the previously built snapshot. An unknown / unreadable snapshot is rejected
 * with QI_FIGMA_SNAPSHOT_UNAVAILABLE. The contract mirrors the capsule source so the connector
 * picker can bind a snapshot to the QI hub.
 */
export interface QualityIntelligenceFigmaSnapshotSource {
  readonly kind: "figma-snapshot";
  readonly label: string;
  readonly snapshotRunId: string;
}

export type QualityIntelligenceInlineSource =
  | QualityIntelligenceRequirementsSource
  | QualityIntelligenceWorkspaceSource
  | QualityIntelligenceFileSource
  | QualityIntelligenceCapsuleSource
  | QualityIntelligenceCapsuleSetSource
  | QualityIntelligenceFigmaSnapshotSource;

/** Body of `POST /api/quality-intelligence/runs`. */
export interface QualityIntelligenceStartRunRequest {
  readonly sources: readonly QualityIntelligenceInlineSource[];
  /** Policy profile id; defaults to the regression profile when omitted. */
  readonly profileId?: string;
  /** Preferred chat model id; the server may degrade to another compatible chat model or baseline. */
  readonly modelId?: string;
  /** Optional non-negative deterministic sampling seed for models that advertise seed support. */
  readonly seed?: number;
}

// ─── Run progress stream (Issue #280) ────────────────────────────────────────────
//
// `POST /api/quality-intelligence/runs` responds with an SSE stream of these messages. Each carries
// only ids / counts / safe enums — never raw prompts, model output, credentials, or source content.

/**
 * A connected source that ingested to nothing usable (empty / denied / binary / unavailable capsule)
 * and was skipped so the remaining sources still produced the run (Epic #729 N+1 resilience). Carries
 * only a sanitised label, the source kind, and a safe coded reason — never source content.
 */
export interface QualityIntelligenceSkippedSource {
  readonly label: string;
  readonly kind: string;
  readonly code: string;
}

export interface QualityIntelligenceRunStreamAccepted {
  readonly type: "accepted";
  readonly runId: string;
  readonly requestedAt: string;
  readonly sourceCount: number;
  readonly atomCount: number;
  /**
   * Sources dropped because the request exceeded the 16-source cap (Epic #729). Present and > 0 only
   * when sources were dropped; the UI surfaces a coverage notice. Additive on the wire.
   */
  readonly droppedSourceCount?: number;
  /**
   * Connected sources skipped because they ingested to nothing usable, while the healthy sources
   * still produced the run (Epic #729 N+1 resilience). Present and non-empty only when a source was
   * skipped; the UI surfaces a per-source coverage notice. Additive on the wire.
   */
  readonly skippedSources?: readonly QualityIntelligenceSkippedSource[];
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
