// runConsolidation: the engine entry point. Pure function; no IO; no clock reads; no
// randomness. Every impurity is injected via ConsolidationOptions.
//
// Design choice pinned here so future contributors do not "fix" it:
//   updatesProposed is ALWAYS the empty array in v1. Every merge / supersession is routed
//   through a ReviewItem carrying a ProposedAction; the caller (#211 MemoriaViva UI or a
//   workflow) materializes the actual MemorySupersession envelope after explicit review. The
//   updatesProposed slot is reserved for a future model-assisted body-summarisation pass
//   (issue #212 or follow-up). This preserves the Epic #204 invariant: "consolidation never
//   mutates accepted memories without preserving provenance and audit history".
//
// Cancellation: cancellationSignal is polled BEFORE each cluster is inspected (once per
// cluster), so the cost is bounded by the cluster count and partial results survive the
// cancel. The signal is polled once at the very start as well, so a caller that already knows
// it wants to abort can short-circuit without inspecting any cluster.

import {
  type MemoryEdge,
  type MemoryEdgeKind,
  type MemoryId,
  type MemoryRecord,
  validateMemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  JACCARD_DEFAULT,
  MAX_AGE_MS_DEFAULT,
  MAX_CLUSTERS_PER_RUN_DEFAULT,
  MAX_CLUSTERS_PER_RUN_HARD_LIMIT,
  MAX_RECORDS_PER_RUN_DEFAULT,
  MAX_RECORDS_PER_RUN_HARD_LIMIT,
  STALE_CONFIDENCE_DEFAULT,
} from "./_constants.js";
import { compareEdges, compareRecordsByAge, compareReviewItems } from "./_ordering.js";
import { CONFLICT_OVERLAP_THRESHOLD, detectConflicts, findConflictPairs } from "./conflicts.js";
import { scanDuplicateClusters, type DuplicateCluster } from "./dedupe.js";
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
  readonly maxRecordsPerRun: number;
  readonly cancellationSignal: () => boolean;
}

const ELIGIBLE_STATUS = "accepted";

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
  readonly maxRecordsPerRun: number;
}

function validateNumericKnobs(knobs: NumericKnobs): boolean {
  if (!isFiniteInRange(knobs.jaccardThreshold, 0, 1)) return false;
  if (!isFiniteInRange(knobs.staleConfidenceThreshold, 0, 1)) return false;
  if (!isFiniteNonNegative(knobs.maxAgeMs)) return false;
  if (!isFiniteInRange(knobs.maxClustersPerRun, 0, MAX_CLUSTERS_PER_RUN_HARD_LIMIT)) {
    return false;
  }
  if (!isFiniteInRange(knobs.maxRecordsPerRun, 0, MAX_RECORDS_PER_RUN_HARD_LIMIT)) {
    return false;
  }
  return Number.isInteger(knobs.maxClustersPerRun) && Number.isInteger(knobs.maxRecordsPerRun);
}

function resolveOptions(options: ConsolidationOptions): ResolvedOptions | null {
  const knobs: NumericKnobs = {
    jaccardThreshold: options.jaccardThreshold ?? JACCARD_DEFAULT,
    staleConfidenceThreshold: options.staleConfidenceThreshold ?? STALE_CONFIDENCE_DEFAULT,
    maxAgeMs: options.maxAgeMs ?? MAX_AGE_MS_DEFAULT,
    maxClustersPerRun: options.maxClustersPerRun ?? MAX_CLUSTERS_PER_RUN_DEFAULT,
    maxRecordsPerRun: options.maxRecordsPerRun ?? MAX_RECORDS_PER_RUN_DEFAULT,
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

function emptyResult(
  state: ConsolidationResult["state"],
  recordsInspected = 0,
  truncated = false,
): ConsolidationResult {
  return {
    state,
    edgesProposed: [],
    updatesProposed: [],
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    recordsInspected,
    truncated,
    elapsedMs: 0,
  };
}

function eligibleMemories(memories: readonly MemoryRecord[]): readonly MemoryRecord[] | null {
  const accepted: MemoryRecord[] = [];
  for (const memory of memories) {
    const validated = validateMemoryRecord(memory);
    if (!validated.ok) return null;
    if (validated.value.status === ELIGIBLE_STATUS) {
      accepted.push(validated.value);
    }
  }
  return accepted;
}

function boundedEligibleMemories(
  memories: readonly MemoryRecord[],
  resolved: ResolvedOptions,
): { readonly records: readonly MemoryRecord[]; readonly truncated: boolean } {
  const sorted = [...memories].sort(compareRecordsByAge);
  return {
    records: sorted.slice(0, resolved.maxRecordsPerRun),
    truncated: sorted.length > resolved.maxRecordsPerRun,
  };
}

interface ClusterEffects {
  readonly edges: readonly MemoryEdge[];
  readonly reviewItem: ReviewItem | null;
}

function buildEdge(
  fromMemoryId: MemoryId,
  toMemoryId: MemoryId,
  kind: MemoryEdgeKind,
  resolved: ResolvedOptions,
  provenanceSummary: string,
): MemoryEdge {
  return {
    id: resolved.newEdgeId(),
    schemaVersion: "1",
    fromMemoryId,
    toMemoryId,
    kind,
    createdAt: resolved.nowMs,
    provenanceSummary,
  };
}

function buildDuplicateEdges(
  older: MemoryRecord,
  newer: MemoryRecord,
  resolved: ResolvedOptions,
): readonly MemoryEdge[] {
  return [
    buildEdge(older.id, newer.id, "derived-from", resolved, "consolidation: near-duplicate"),
    buildEdge(older.id, newer.id, "related", resolved, "consolidation: related duplicate"),
    buildEdge(older.id, newer.id, "temporal-precedes", resolved, "consolidation: temporal link"),
  ];
}

function buildSupersedeReviewEdges(
  older: MemoryId,
  newer: MemoryId,
  resolved: ResolvedOptions,
): readonly MemoryEdge[] {
  return [
    buildEdge(older, newer, "conflicts-with", resolved, "consolidation: proposed conflict"),
    buildEdge(newer, older, "corrects", resolved, "consolidation: proposed correction"),
    buildEdge(older, newer, "supersedes", resolved, "consolidation: proposed supersession"),
  ];
}

function buildMergeReviewEdges(
  winner: MemoryId,
  losers: readonly MemoryId[],
  resolved: ResolvedOptions,
): readonly MemoryEdge[] {
  const edges: MemoryEdge[] = [];
  for (const loser of losers) {
    edges.push(
      buildEdge(loser, winner, "derived-from", resolved, "consolidation: proposed merge lineage"),
      buildEdge(loser, winner, "related", resolved, "consolidation: proposed merge relationship"),
      buildEdge(
        loser,
        winner,
        "supersedes",
        resolved,
        "consolidation: proposed merge supersession",
      ),
    );
  }
  return edges;
}

function withProposedReviewEdges(item: ReviewItem, resolved: ResolvedOptions): ReviewItem {
  const action = item.proposedAction;
  if (action === undefined) return item;
  const proposedEdges =
    action.kind === "supersede"
      ? buildSupersedeReviewEdges(action.older, action.newer, resolved)
      : buildMergeReviewEdges(action.winner, action.losers, resolved);
  return proposedEdges.length === 0 ? item : { ...item, proposedEdges };
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
    const item = conflictItems[0];
    return {
      edges: [],
      reviewItem: item === undefined ? null : withProposedReviewEdges(item, resolved),
    };
  }
  const older = cluster.members[0];
  const newer = cluster.members[1];
  if (older === undefined || newer === undefined) {
    return { edges: [], reviewItem: null };
  }
  return { edges: buildDuplicateEdges(older, newer, resolved), reviewItem: null };
}

function processMultiWayCluster(
  cluster: DuplicateCluster,
  resolved: ResolvedOptions,
): ClusterEffects {
  const items = detectConflicts([cluster], {
    nowMs: resolved.nowMs,
    newReviewItemId: resolved.newReviewItemId,
  });
  const item = items[0];
  return {
    edges: [],
    reviewItem: item === undefined ? null : withProposedReviewEdges(item, resolved),
  };
}

function processCluster(cluster: DuplicateCluster, resolved: ResolvedOptions): ClusterEffects {
  if (cluster.members.length > 2) return processMultiWayCluster(cluster, resolved);
  if (cluster.members.length === 2) return processTwoMemberCluster(cluster, resolved);
  return { edges: [], reviewItem: null };
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
    for (const edge of effects.edges) edges.push(edge);
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
  clusterScanCanceled: boolean,
): readonly ReviewItem[] {
  // If the cluster sweep was canceled, do NOT extend work into the conflict-pair sweep —
  // honour the cancellation boundary so partial results stay partial.
  if (consumedState === "canceled" || clusterScanCanceled) return [];
  return findConflictPairs(records, clusters, CONFLICT_OVERLAP_THRESHOLD, {
    nowMs: resolved.nowMs,
    newReviewItemId: resolved.newReviewItemId,
    cancellationSignal: resolved.cancellationSignal,
  }).map((item) => withProposedReviewEdges(item, resolved));
}

// Public entry. Same input + same options => byte-identical result.
export function runConsolidation(
  memories: readonly MemoryRecord[],
  options: ConsolidationOptions,
): ConsolidationResult {
  const resolved = resolveOptions(options);
  if (resolved === null) return emptyResult("failed");
  if (resolved.cancellationSignal()) return emptyResult("canceled");
  const eligible = eligibleMemories(memories);
  if (eligible === null) return emptyResult("failed");
  if (eligible.length === 0) return emptyResult("skipped");
  const bounded = boundedEligibleMemories(eligible, resolved);
  if (bounded.records.length === 0 || resolved.maxClustersPerRun === 0) {
    return emptyResult("skipped", bounded.records.length, bounded.truncated);
  }
  const scanned = scanDuplicateClusters(bounded.records, resolved.jaccardThreshold, {
    cancellationSignal: resolved.cancellationSignal,
  });
  if (scanned.canceled && scanned.clusters.length === 0) {
    return emptyResult("canceled", bounded.records.length, bounded.truncated);
  }
  const clusters = scanned.clusters;
  const consumed = consumeClusters(clusters, resolved);
  const conflictPairs = collectConflictPairs(
    bounded.records,
    clusters,
    resolved,
    consumed.state,
    scanned.canceled,
  );
  const staleFlags = collectStaleFlags(bounded.records, resolved);
  const mergedReviewItems = [...consumed.reviewItems, ...conflictPairs].sort(compareReviewItems);
  return {
    state: scanned.canceled ? "canceled" : consumed.state,
    edgesProposed: [...consumed.edges].sort(compareEdges),
    updatesProposed: [],
    staleFlags,
    reviewItems: mergedReviewItems,
    clustersInspected: consumed.clustersInspected + conflictPairs.length,
    recordsInspected: bounded.records.length,
    truncated: bounded.truncated,
    elapsedMs: 0,
  };
}
