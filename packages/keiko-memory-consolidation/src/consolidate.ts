// runConsolidation: the engine entry point. Pure function; no IO; no clock reads; no
// randomness. Every impurity is injected via ConsolidationOptions.
//
// Design choice pinned here so future contributors do not "fix" it:
//   updatesProposed is ALWAYS the empty array in v1. Every merge / supersession is routed
//   through a ReviewItem carrying a ProposedAction; the caller (#211 Memory Center UI or a
//   workflow) materializes the actual MemorySupersession envelope after explicit review. The
//   updatesProposed slot is reserved for a future model-assisted body-summarisation pass
//   (issue #212 or follow-up). This preserves the Epic #204 invariant: "consolidation never
//   mutates accepted memories without preserving provenance and audit history".
//
// Cancellation: cancellationSignal is polled BEFORE each cluster is inspected (once per
// cluster), so the cost is bounded by the cluster count and partial results survive the
// cancel. The signal is polled once at the very start as well, so a caller that already knows
// it wants to abort can short-circuit without inspecting any cluster.

import type { MemoryEdge, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import {
  JACCARD_DEFAULT,
  MAX_AGE_MS_DEFAULT,
  MAX_CLUSTERS_PER_RUN_DEFAULT,
  STALE_CONFIDENCE_DEFAULT,
} from "./_constants.js";
import { compareEdges, compareReviewItems } from "./_ordering.js";
import { CONFLICT_OVERLAP_THRESHOLD, detectConflicts, findConflictPairs } from "./conflicts.js";
import { findDuplicateClusters, type DuplicateCluster } from "./dedupe.js";
import { findStaleMemories } from "./stale.js";
import type { ConsolidationOptions, ConsolidationResult, ReviewItem, StaleFlag } from "./types.js";

interface ResolvedOptions {
  readonly nowMs: number;
  readonly newEdgeId: () => MemoryEdge["id"];
  readonly newReviewItemId: () => string;
  readonly jaccardThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
  readonly cancellationSignal: () => boolean;
}

function isFiniteInRange(n: number, lo: number, hi: number): boolean {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

function isFiniteNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

function neverCancel(): boolean {
  return false;
}

interface NumericKnobs {
  readonly jaccardThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
}

function validateNumericKnobs(knobs: NumericKnobs): boolean {
  if (!isFiniteInRange(knobs.jaccardThreshold, 0, 1)) return false;
  if (!isFiniteInRange(knobs.staleConfidenceThreshold, 0, 1)) return false;
  if (!isFiniteNonNegative(knobs.maxAgeMs)) return false;
  if (!isFiniteNonNegative(knobs.maxClustersPerRun)) return false;
  return Number.isInteger(knobs.maxClustersPerRun);
}

function resolveOptions(options: ConsolidationOptions): ResolvedOptions | null {
  const knobs: NumericKnobs = {
    jaccardThreshold: options.jaccardThreshold ?? JACCARD_DEFAULT,
    staleConfidenceThreshold: options.staleConfidenceThreshold ?? STALE_CONFIDENCE_DEFAULT,
    maxAgeMs: options.maxAgeMs ?? MAX_AGE_MS_DEFAULT,
    maxClustersPerRun: options.maxClustersPerRun ?? MAX_CLUSTERS_PER_RUN_DEFAULT,
  };
  if (!validateNumericKnobs(knobs)) return null;
  return {
    nowMs: options.nowMs,
    newEdgeId: options.newEdgeId,
    newReviewItemId: options.newReviewItemId,
    ...knobs,
    cancellationSignal: options.cancellationSignal ?? neverCancel,
  };
}

function emptyResult(state: ConsolidationResult["state"]): ConsolidationResult {
  return {
    state,
    edgesProposed: [],
    updatesProposed: [],
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    elapsedMs: 0,
  };
}

interface ClusterEffects {
  readonly edge: MemoryEdge | null;
  readonly reviewItem: ReviewItem | null;
}

function processTwoMemberCluster(
  cluster: DuplicateCluster,
  resolved: ResolvedOptions,
): ClusterEffects {
  const conflictItems = detectConflicts([cluster], {
    nowMs: resolved.nowMs,
    newReviewItemId: resolved.newReviewItemId,
  });
  if (conflictItems.length > 0) {
    return { edge: null, reviewItem: conflictItems[0] ?? null };
  }
  const older = cluster.members[0];
  const newer = cluster.members[1];
  if (older === undefined || newer === undefined) {
    return { edge: null, reviewItem: null };
  }
  const edge: MemoryEdge = {
    id: resolved.newEdgeId(),
    schemaVersion: "1",
    fromMemoryId: older.id,
    toMemoryId: newer.id,
    kind: "derived-from",
    createdAt: resolved.nowMs,
    provenanceSummary: "consolidation: near-duplicate",
  };
  return { edge, reviewItem: null };
}

function processMultiWayCluster(
  cluster: DuplicateCluster,
  resolved: ResolvedOptions,
): ClusterEffects {
  const items = detectConflicts([cluster], {
    nowMs: resolved.nowMs,
    newReviewItemId: resolved.newReviewItemId,
  });
  return { edge: null, reviewItem: items[0] ?? null };
}

function processCluster(cluster: DuplicateCluster, resolved: ResolvedOptions): ClusterEffects {
  if (cluster.members.length > 2) return processMultiWayCluster(cluster, resolved);
  if (cluster.members.length === 2) return processTwoMemberCluster(cluster, resolved);
  return { edge: null, reviewItem: null };
}

interface ConsumeResult {
  readonly state: "completed" | "canceled";
  readonly edges: MemoryEdge[];
  readonly reviewItems: ReviewItem[];
  readonly clustersInspected: number;
}

function consumeClusters(
  clusters: readonly DuplicateCluster[],
  resolved: ResolvedOptions,
): ConsumeResult {
  const edges: MemoryEdge[] = [];
  const reviewItems: ReviewItem[] = [];
  let clustersInspected = 0;
  const limit = Math.min(clusters.length, resolved.maxClustersPerRun);
  for (let i = 0; i < limit; i += 1) {
    if (resolved.cancellationSignal()) {
      return { state: "canceled", edges, reviewItems, clustersInspected };
    }
    const cluster = clusters[i];
    if (cluster === undefined) continue;
    const effects = processCluster(cluster, resolved);
    if (effects.edge !== null) edges.push(effects.edge);
    if (effects.reviewItem !== null) reviewItems.push(effects.reviewItem);
    clustersInspected += 1;
  }
  return { state: "completed", edges, reviewItems, clustersInspected };
}

function collectStaleFlags(
  records: readonly MemoryRecord[],
  resolved: ResolvedOptions,
): readonly StaleFlag[] {
  return findStaleMemories(records, {
    nowMs: resolved.nowMs,
    staleConfidenceThreshold: resolved.staleConfidenceThreshold,
    maxAgeMs: resolved.maxAgeMs,
  });
}

function collectConflictPairs(
  records: readonly MemoryRecord[],
  clusters: readonly DuplicateCluster[],
  resolved: ResolvedOptions,
  consumedState: "completed" | "canceled",
): readonly ReviewItem[] {
  // If the cluster sweep was canceled, do NOT extend work into the conflict-pair sweep —
  // honour the cancellation boundary so partial results stay partial.
  if (consumedState === "canceled") return [];
  return findConflictPairs(records, clusters, CONFLICT_OVERLAP_THRESHOLD, {
    nowMs: resolved.nowMs,
    newReviewItemId: resolved.newReviewItemId,
  });
}

// Public entry. Same input + same options => byte-identical result.
export function runConsolidation(
  memories: readonly MemoryRecord[],
  options: ConsolidationOptions,
): ConsolidationResult {
  const resolved = resolveOptions(options);
  if (resolved === null) return emptyResult("failed");
  if (memories.length === 0 || resolved.maxClustersPerRun === 0) return emptyResult("skipped");
  const clusters = findDuplicateClusters(memories, resolved.jaccardThreshold);
  const consumed = consumeClusters(clusters, resolved);
  const conflictPairs = collectConflictPairs(memories, clusters, resolved, consumed.state);
  const staleFlags = collectStaleFlags(memories, resolved);
  const mergedReviewItems = [...consumed.reviewItems, ...conflictPairs].sort(compareReviewItems);
  return {
    state: consumed.state,
    edgesProposed: [...consumed.edges].sort(compareEdges),
    updatesProposed: [],
    staleFlags,
    reviewItems: mergedReviewItems,
    clustersInspected: consumed.clustersInspected + conflictPairs.length,
    elapsedMs: 0,
  };
}
