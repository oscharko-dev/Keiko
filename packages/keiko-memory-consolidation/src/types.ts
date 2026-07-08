// Public surface for keiko-memory-consolidation (Epic #204 child #208).
//
// Consolidation is a PURE-FUNCTION engine. The caller pre-fetches MemoryRecords from the vault
// (#206), invokes `runConsolidation`, and applies the proposed edges, supersessions, and
// review-item resolutions back to the vault and audit ledger (#214). The engine itself never
// touches storage, never reads the clock, and never generates random ids — everything that would
// be impure is injected through `ConsolidationOptions` (`nowMs`, `newEdgeId`, `newReviewItemId`,
// `cancellationSignal`). This keeps the layer trivially reproducible: same input + same options
// => byte-identical result.
//
// Consolidation still never mutates records itself. When a caller supplies the summary port, the
// engine may emit `MemoryUpdate` envelopes in `updatesProposed`; those envelopes are review input,
// not storage effects. Merge / supersession relationships remain routed through `ReviewItem` so the
// caller materialises the actual audited transition after explicit review.

import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryStatus,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryUpdate } from "@oscharko-dev/keiko-contracts/memory";

// ─── Job lifecycle ────────────────────────────────────────────────────────────
// `ConsolidationJob` is a VALUE OBJECT, not a process handle. The package does not spawn jobs,
// schedule them, or persist them. The caller (a scheduler / UI button / workflow orchestrator)
// owns the job's identity and lifecycle; the engine returns a `ConsolidationResult` that the
// caller pins onto the job via `transitionJob(job, "completed", { result })`.

export type ConsolidationJobState =
  "queued" | "running" | "completed" | "failed" | "canceled" | "skipped";

export interface ConsolidationJob {
  readonly id: string;
  readonly state: ConsolidationJobState;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly result?: ConsolidationResult;
  readonly error?: string;
}

// ─── Stale flags ──────────────────────────────────────────────────────────────
// Stale memories are NEVER deleted by consolidation. They are surfaced as flags the caller can
// route into MemoriaViva for explicit review and (optional) archival.

export type StaleReason = "expired" | "low-confidence" | "aged-out";

export interface StaleFlag {
  readonly memoryId: MemoryId;
  readonly reason: StaleReason;
  // Epoch ms at which the engine observed the staleness. Set from `ConsolidationOptions.nowMs`
  // so the flag is reproducible from the same inputs.
  readonly detectedAt: number;
}

// ─── Review items ─────────────────────────────────────────────────────────────
// Emitted whenever consolidation refuses to silently auto-resolve: multi-way duplicate clusters
// (more than two members in one near-dup group) and potential conflicts (two memories with
// opposite polarity over the same subject). The caller MUST process review items before applying
// any consolidation effect; the engine never bypasses them.

export type ReviewReason = "duplicate-review" | "multi-way-duplicate" | "potential-conflict";

export type ProposedAction =
  | { readonly kind: "merge"; readonly winner: MemoryId; readonly losers: readonly MemoryId[] }
  | { readonly kind: "supersede"; readonly newer: MemoryId; readonly older: MemoryId };

export type ConsolidationEvidenceKind =
  | "lexical-similarity"
  | "semantic-similarity"
  | "negation-polarity"
  | "value-replacement"
  | "summary-union";

export interface ConsolidationEvidence {
  readonly kind: ConsolidationEvidenceKind;
  readonly memoryIds: readonly MemoryId[];
  readonly score?: number;
  readonly threshold?: number;
  readonly detail?: string;
}

// Optional, advisory-only annotation (Issue #2130 / ADR-0120). Populated exclusively by the
// keiko-server enrichment pass AFTER this pure engine returns — never by the engine itself, and
// never in a way that changes `proposedAction` or any reviewer-facing behavior. Absent by default.
export interface ReviewItemSuggestedResolution {
  readonly recommendedWinnerId: MemoryId;
  readonly rationale: string;
}

export interface ReviewItem {
  readonly id: string;
  readonly reason: ReviewReason;
  readonly relatedMemoryIds: readonly MemoryId[];
  // Complete source-memory lineage for the proposed review action. Kept separate from display
  // relation ids so callers can preserve provenance even if UI text is later summarised.
  readonly sourceMemoryIds?: readonly MemoryId[];
  readonly proposedAction?: ProposedAction;
  readonly evidence?: readonly ConsolidationEvidence[];
  // Relationship edges that MAY be materialised only after the review item is explicitly accepted.
  // They are intentionally kept off `ConsolidationResult.edgesProposed` so maintenance callers do
  // not silently apply conflict-resolution relationships before a reviewer settles the item.
  readonly proposedEdges?: readonly MemoryEdge[];
  readonly detectedAt: number;
  readonly suggestedResolution?: ReviewItemSuggestedResolution;
}

// ─── Options ──────────────────────────────────────────────────────────────────
// Every numeric knob has a conservative default (see `_constants.ts`). The id factories are
// REQUIRED: the engine does not import `node:crypto` so reproducibility is the caller's
// contract. Embeddings, access stats, and summary generation are caller-supplied pure ports; the
// consolidation package never imports vault or gateway code directly.

export interface ConsolidationEmbedding {
  readonly vector: ArrayLike<number>;
  readonly provider?: string;
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly metric?: "cosine" | "euclidean" | "dot";
}

export interface ConsolidationAccessStat {
  readonly lastAccessedAt?: number;
  readonly accessCount: number;
  readonly outcomeCount?: number;
  readonly utilitySum?: number;
}

export interface ConsolidationSummaryInput {
  readonly winner: MemoryRecord;
  readonly records: readonly MemoryRecord[];
  readonly sourceMemoryIds: readonly MemoryId[];
  readonly sourceBodies: readonly string[];
}

export type ConsolidationSummaryOutput =
  | string
  | {
      readonly body: string;
      readonly reviewerNote?: string;
    };

export type ConsolidationSummaryGenerator = (
  input: ConsolidationSummaryInput,
) => ConsolidationSummaryOutput | null | undefined;

export interface ConsolidationSummaryStatus {
  readonly kind: "not-configured" | "configured";
  readonly updatesProposed: number;
  readonly skippedMergeClusters: number;
  readonly fallbacksUsed: number;
}

export interface ConsolidationOptions {
  readonly nowMs: number;
  readonly newEdgeId: () => MemoryEdgeId;
  readonly newReviewItemId: () => string;
  readonly reviewerId?: MemoryReviewerId;
  readonly jaccardThreshold?: number;
  readonly semanticSimilarityThreshold?: number;
  readonly staleConfidenceThreshold?: number;
  readonly maxAgeMs?: number;
  readonly maxClustersPerRun?: number;
  // Hard CPU budget applied before duplicate/conflict scans. Keeps the O(n^2) passes bounded even
  // when a scope contains far more accepted memories than one user-visible job should inspect.
  readonly maxRecordsPerRun?: number;
  // Polled BEFORE each cluster is inspected. Returning `true` exits the engine with
  // `state: "canceled"` and the partial results accumulated so far. Polled at most once per
  // cluster so the cancellation cost is bounded by the cluster count, not by cluster size.
  readonly cancellationSignal?: () => boolean;
  readonly includeStatuses?: readonly MemoryStatus[];
  readonly embeddingFor?: (memoryId: MemoryId) => ConsolidationEmbedding | undefined;
  readonly accessStatsFor?: (memoryId: MemoryId) => ConsolidationAccessStat | undefined;
  readonly summaryGenerator?: ConsolidationSummaryGenerator;
}

// ─── Result ───────────────────────────────────────────────────────────────────
// All array fields are deterministically sorted (see `_ordering.ts`); the same input twice
// yields byte-identical JSON. `updatesProposed` contains reviewer-only body patches for multi-way
// merges, using a configured summary port when available and a deterministic union fallback otherwise.

export interface ConsolidationResult {
  readonly state: "completed" | "canceled" | "skipped" | "failed";
  readonly edgesProposed: readonly MemoryEdge[];
  readonly updatesProposed: readonly MemoryUpdate[];
  readonly summaryStatus: ConsolidationSummaryStatus;
  readonly staleFlags: readonly StaleFlag[];
  readonly reviewItems: readonly ReviewItem[];
  readonly clustersInspected: number;
  // Conflict pairs discovered by the cross-cluster pass (`findConflictPairs`). Kept separate from
  // `clustersInspected` because the two counters measure different things: clusters counted by the
  // duplicate-scan sweep vs. (older, newer) pairs found across non-overlapping clusters.
  readonly conflictPairsDetected: number;
  readonly recordsInspected: number;
  readonly truncated: boolean;
  // The engine is pure (no clock reads), so `elapsedMs` is always `0` from `runConsolidation`.
  // The caller computes real wall-clock elapsed at the job-transition site via
  // `completedAt - startedAt` and pins it on the `ConsolidationJob`.
  readonly elapsedMs: number;
}
