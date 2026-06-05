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
// Design choice (preserved across review and pinned here so future contributors do not "fix" it):
// `updatesProposed` is reserved for a future model-assisted body-summarisation pass. v1 NEVER
// emits `MemoryUpdate` envelopes: every merge / supersession is routed through a `ReviewItem`
// carrying a `ProposedAction`, so the caller (#211 Memory Center UI or a workflow) materialises
// the actual `MemorySupersession` envelope after explicit review. This preserves the Epic #204
// invariant: "consolidation never mutates accepted memories without preserving provenance and
// audit history" — the caller's supersession is the audited transition, not a silent in-place
// patch.

import type { MemoryEdge, MemoryEdgeId, MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryUpdate } from "@oscharko-dev/keiko-contracts/memory";

// ─── Job lifecycle ────────────────────────────────────────────────────────────
// `ConsolidationJob` is a VALUE OBJECT, not a process handle. The package does not spawn jobs,
// schedule them, or persist them. The caller (a scheduler / UI button / workflow orchestrator)
// owns the job's identity and lifecycle; the engine returns a `ConsolidationResult` that the
// caller pins onto the job via `transitionJob(job, "completed", { result })`.

export type ConsolidationJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "skipped";

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
// route into the Memory Center for explicit review and (optional) archival.

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

export type ReviewReason = "multi-way-duplicate" | "potential-conflict";

export type ProposedAction =
  | { readonly kind: "merge"; readonly winner: MemoryId; readonly losers: readonly MemoryId[] }
  | { readonly kind: "supersede"; readonly newer: MemoryId; readonly older: MemoryId };

export interface ReviewItem {
  readonly id: string;
  readonly reason: ReviewReason;
  readonly relatedMemoryIds: readonly MemoryId[];
  readonly proposedAction?: ProposedAction;
  readonly detectedAt: number;
}

// ─── Options ──────────────────────────────────────────────────────────────────
// Every numeric knob has a conservative default (see `_constants.ts`). The id factories are
// REQUIRED: the engine does not import `node:crypto` so reproducibility is the caller's
// contract. The `summaryGenerator` port is RESERVED — v1 never invokes it; the slot is here
// to keep the type stable when model-assisted summarisation lands (issue #212 or follow-up).

export interface ConsolidationOptions {
  readonly nowMs: number;
  readonly newEdgeId: () => MemoryEdgeId;
  readonly newReviewItemId: () => string;
  readonly jaccardThreshold?: number;
  readonly staleConfidenceThreshold?: number;
  readonly maxAgeMs?: number;
  readonly maxClustersPerRun?: number;
  // Polled BEFORE each cluster is inspected. Returning `true` exits the engine with
  // `state: "canceled"` and the partial results accumulated so far. Polled at most once per
  // cluster so the cancellation cost is bounded by the cluster count, not by cluster size.
  readonly cancellationSignal?: () => boolean;
  // Reserved for model-assisted body summarisation in a follow-up issue. v1 never calls this;
  // declaring it on the option type lets us land the seam without a contract bump later.
  readonly summaryGenerator?: (text: string) => Promise<string>;
}

// ─── Result ───────────────────────────────────────────────────────────────────
// All array fields are deterministically sorted (see `_ordering.ts`); the same input twice
// yields byte-identical JSON. `updatesProposed` is reserved (see file header design note);
// v1 always returns the empty array.

export interface ConsolidationResult {
  readonly state: "completed" | "canceled" | "skipped" | "failed";
  readonly edgesProposed: readonly MemoryEdge[];
  readonly updatesProposed: readonly MemoryUpdate[];
  readonly staleFlags: readonly StaleFlag[];
  readonly reviewItems: readonly ReviewItem[];
  readonly clustersInspected: number;
  // The engine is pure (no clock reads), so `elapsedMs` is always `0` from `runConsolidation`.
  // The caller computes real wall-clock elapsed at the job-transition site via
  // `completedAt - startedAt` and pins it on the `ConsolidationJob`.
  readonly elapsedMs: number;
}
