// runConsolidation: the engine entry point. Pure function; no IO; no clock reads; no
// randomness. Every impurity is injected via ConsolidationOptions.
//
// Merge / supersession relationships are routed through ReviewItems; optional body summaries are
// emitted as MemoryUpdate envelopes in updatesProposed only when the caller supplies the pure
// summary port. The engine never applies those updates itself.
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
  type MemoryReviewerId,
  type MemoryStatus,
  type MemoryUpdate,
  validateMemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  JACCARD_DEFAULT,
  MAX_AGE_MS_DEFAULT,
  MAX_CLUSTERS_PER_RUN_DEFAULT,
  MAX_CLUSTERS_PER_RUN_HARD_LIMIT,
  MAX_RECORDS_PER_RUN_DEFAULT,
  MAX_RECORDS_PER_RUN_HARD_LIMIT,
  SEMANTIC_SIMILARITY_DEFAULT,
  STALE_CONFIDENCE_DEFAULT,
} from "./_constants.js";
import { compareEdges, compareRecordsByAge, compareReviewItems } from "./_ordering.js";
import { CONFLICT_OVERLAP_THRESHOLD, detectConflicts, findConflictPairs } from "./conflicts.js";
import { scanDuplicateClusters, type DuplicateCluster } from "./dedupe.js";
import { normalizeBody } from "./similarity.js";
import { findStaleMemories } from "./stale.js";
import type {
  ConsolidationAccessStat,
  ConsolidationEmbedding,
  ConsolidationOptions,
  ConsolidationResult,
  ConsolidationSummaryGenerator,
  ConsolidationSummaryStatus,
  ReviewItem,
  StaleFlag,
} from "./types.js";

interface ResolvedOptions {
  readonly nowMs: number;
  readonly newEdgeId: () => MemoryEdge["id"];
  readonly newReviewItemId: () => string;
  readonly reviewerId: MemoryReviewerId;
  readonly jaccardThreshold: number;
  readonly semanticSimilarityThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
  readonly maxRecordsPerRun: number;
  readonly cancellationSignal: () => boolean;
  readonly includeStatuses: ReadonlySet<MemoryStatus>;
  readonly embeddingFor?: (memoryId: MemoryId) => ConsolidationEmbedding | undefined;
  readonly accessStatsFor?: (memoryId: MemoryId) => ConsolidationAccessStat | undefined;
  readonly summaryGenerator?: ConsolidationSummaryGenerator;
}

const DEFAULT_ELIGIBLE_STATUSES: readonly MemoryStatus[] = ["accepted", "proposed", "conflicted"];
const DEFAULT_REVIEWER_ID = "memory-consolidation" as MemoryReviewerId;

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
  readonly semanticSimilarityThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
  readonly maxRecordsPerRun: number;
}

function validateNumericKnobs(knobs: NumericKnobs): boolean {
  if (!isFiniteInRange(knobs.jaccardThreshold, 0, 1)) return false;
  if (!isFiniteInRange(knobs.semanticSimilarityThreshold, 0, 1)) return false;
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

function optionalResolvedPorts(options: ConsolidationOptions): Partial<ResolvedOptions> {
  return {
    ...(options.embeddingFor !== undefined ? { embeddingFor: options.embeddingFor } : {}),
    ...(options.accessStatsFor !== undefined ? { accessStatsFor: options.accessStatsFor } : {}),
    ...(options.summaryGenerator !== undefined
      ? { summaryGenerator: options.summaryGenerator }
      : {}),
  };
}

function resolveNumericKnobs(options: ConsolidationOptions): NumericKnobs {
  return {
    jaccardThreshold: options.jaccardThreshold ?? JACCARD_DEFAULT,
    semanticSimilarityThreshold: options.semanticSimilarityThreshold ?? SEMANTIC_SIMILARITY_DEFAULT,
    staleConfidenceThreshold: options.staleConfidenceThreshold ?? STALE_CONFIDENCE_DEFAULT,
    maxAgeMs: options.maxAgeMs ?? MAX_AGE_MS_DEFAULT,
    maxClustersPerRun: options.maxClustersPerRun ?? MAX_CLUSTERS_PER_RUN_DEFAULT,
    maxRecordsPerRun: options.maxRecordsPerRun ?? MAX_RECORDS_PER_RUN_DEFAULT,
  };
}

function resolveOptions(options: ConsolidationOptions): ResolvedOptions | null {
  const knobs = resolveNumericKnobs(options);
  if (!validateNumericKnobs(knobs)) return null;
  return {
    nowMs: options.nowMs,
    newEdgeId: options.newEdgeId,
    newReviewItemId: options.newReviewItemId,
    reviewerId: options.reviewerId ?? DEFAULT_REVIEWER_ID,
    ...knobs,
    cancellationSignal: options.cancellationSignal ?? neverCancel,
    includeStatuses: new Set(options.includeStatuses ?? DEFAULT_ELIGIBLE_STATUSES),
    ...optionalResolvedPorts(options),
  };
}

function emptySummaryStatus(resolved?: ResolvedOptions): ConsolidationSummaryStatus {
  return {
    kind: resolved?.summaryGenerator === undefined ? "not-configured" : "configured",
    updatesProposed: 0,
    skippedMergeClusters: 0,
    fallbacksUsed: 0,
  };
}

function summaryStatusFromConsume(
  resolved: ResolvedOptions,
  consumed: Pick<ConsumeResult, "updates" | "summaryFallbacks" | "summarySkipped">,
): ConsolidationSummaryStatus {
  return {
    kind: resolved.summaryGenerator === undefined ? "not-configured" : "configured",
    updatesProposed: consumed.updates.length,
    skippedMergeClusters: consumed.summarySkipped,
    fallbacksUsed: consumed.summaryFallbacks,
  };
}

function sortUpdates(updates: readonly MemoryUpdate[]): readonly MemoryUpdate[] {
  return [...updates].sort((a, b) => {
    if (a.memoryId < b.memoryId) return -1;
    if (a.memoryId > b.memoryId) return 1;
    if (a.updatedAt < b.updatedAt) return -1;
    if (a.updatedAt > b.updatedAt) return 1;
    return 0;
  });
}

function emptyResult(
  state: ConsolidationResult["state"],
  recordsInspected = 0,
  truncated = false,
  resolved?: ResolvedOptions,
): ConsolidationResult {
  return {
    state,
    edgesProposed: [],
    updatesProposed: [],
    summaryStatus: emptySummaryStatus(resolved),
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    conflictPairsDetected: 0,
    recordsInspected,
    truncated,
    elapsedMs: 0,
  };
}

function eligibleMemories(
  memories: readonly MemoryRecord[],
  resolved: ResolvedOptions,
): readonly MemoryRecord[] | null {
  const eligible: MemoryRecord[] = [];
  for (const memory of memories) {
    const validated = validateMemoryRecord(memory);
    if (!validated.ok) return null;
    if (resolved.includeStatuses.has(validated.value.status)) {
      eligible.push(validated.value);
    }
  }
  return eligible;
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
  readonly updates: readonly MemoryUpdate[];
  readonly summaryFallbacks: number;
  readonly summarySkipped: number;
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

function sourceIdsForCluster(cluster: DuplicateCluster): readonly MemoryId[] {
  return cluster.members.map((member) => member.id);
}

function mergeActionForCluster(
  cluster: DuplicateCluster,
): { readonly winner: MemoryRecord; readonly losers: readonly MemoryRecord[] } | null {
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  const winner = sorted[sorted.length - 1];
  if (winner === undefined || sorted.length < 2) return null;
  return { winner, losers: sorted.slice(0, -1) };
}

function buildDuplicateReviewItem(
  cluster: DuplicateCluster,
  resolved: ResolvedOptions,
  reason: ReviewItem["reason"],
): ReviewItem | null {
  const actionInput = mergeActionForCluster(cluster);
  if (actionInput === null) return null;
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  return {
    id: resolved.newReviewItemId(),
    reason,
    relatedMemoryIds: sorted.map((member) => member.id),
    sourceMemoryIds: sorted.map((member) => member.id),
    proposedAction: {
      kind: "merge",
      winner: actionInput.winner.id,
      losers: actionInput.losers.map((member) => member.id),
    },
    ...(cluster.evidence !== undefined && cluster.evidence.length > 0
      ? { evidence: cluster.evidence }
      : {}),
    detectedAt: resolved.nowMs,
  };
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

function hasNonAcceptedMember(cluster: DuplicateCluster): boolean {
  return cluster.members.some((member) => member.status !== "accepted");
}

function uniqueTrimmedBodies(records: readonly MemoryRecord[]): readonly string[] {
  const seen = new Set<string>();
  const bodies: string[] = [];
  for (const record of records) {
    const trimmed = record.body.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    bodies.push(trimmed);
  }
  return bodies;
}

function deterministicUnionBody(records: readonly MemoryRecord[]): string {
  const bodies = uniqueTrimmedBodies(records);
  if (bodies.length === 0) return "";
  if (bodies.length === 1) return bodies[0] ?? "";
  return bodies.map((body) => `- ${body}`).join("\n");
}

function summaryPreservesUnion(summary: string, sourceBodies: readonly string[]): boolean {
  const normalizedSummary = normalizeBody(summary);
  return sourceBodies.every((body) => {
    const normalizedBody = normalizeBody(body);
    return normalizedBody.length === 0 || normalizedSummary.includes(normalizedBody);
  });
}

function normalizeSummaryOutput(
  output: ReturnType<ConsolidationSummaryGenerator>,
): { readonly body: string; readonly reviewerNote?: string } | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return { body: output };
  return output;
}

interface GeneratedSummaryChoice {
  readonly body: string;
  readonly reviewerNote?: string;
  readonly fallbackUsed: boolean;
}

function chooseSummaryBody(
  generator: ConsolidationSummaryGenerator | undefined,
  input: Parameters<ConsolidationSummaryGenerator>[0],
  sourceBodies: readonly string[],
  unionBody: string,
): GeneratedSummaryChoice {
  if (generator === undefined) return { body: unionBody, fallbackUsed: true };
  try {
    const generated = normalizeSummaryOutput(generator(input));
    if (generated === null || generated.body.trim().length === 0) {
      return { body: unionBody, fallbackUsed: true };
    }
    if (!summaryPreservesUnion(generated.body, sourceBodies)) {
      return { body: unionBody, fallbackUsed: true };
    }
    return {
      body: generated.body.trim(),
      ...(generated.reviewerNote !== undefined ? { reviewerNote: generated.reviewerNote } : {}),
      fallbackUsed: false,
    };
  } catch {
    return { body: unionBody, fallbackUsed: true };
  }
}

function summaryReviewerNote(
  cluster: DuplicateCluster,
  fallbackUsed: boolean,
  reviewerNote: string | undefined,
): string {
  const ids = sourceIdsForCluster(cluster);
  const noteParts = [`Consolidation summary proposed from source memories: ${ids.join(", ")}.`];
  if (fallbackUsed) {
    noteParts.push("Deterministic union fallback used to preserve all source bodies.");
  }
  if (reviewerNote !== undefined && reviewerNote.length > 0) noteParts.push(reviewerNote);
  return noteParts.join(" ");
}

function buildSummaryUpdate(
  cluster: DuplicateCluster,
  resolved: ResolvedOptions,
): {
  readonly update: MemoryUpdate | null;
  readonly fallbackUsed: boolean;
  readonly skipped: boolean;
} {
  const actionInput = mergeActionForCluster(cluster);
  if (actionInput === null) return { update: null, fallbackUsed: false, skipped: true };
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  const sourceBodies = uniqueTrimmedBodies(sorted);
  if (sourceBodies.length === 0) return { update: null, fallbackUsed: false, skipped: true };
  const unionBody = deterministicUnionBody(sorted);
  const summary = chooseSummaryBody(
    resolved.summaryGenerator,
    {
      winner: actionInput.winner,
      records: sorted,
      sourceMemoryIds: sourceIdsForCluster(cluster),
      sourceBodies,
    },
    sourceBodies,
    unionBody,
  );
  return {
    update: {
      schemaVersion: "1",
      memoryId: actionInput.winner.id,
      reviewerId: resolved.reviewerId,
      updatedAt: resolved.nowMs,
      bodyPatch: summary.body,
      reviewerNote: summaryReviewerNote(cluster, summary.fallbackUsed, summary.reviewerNote),
    },
    fallbackUsed: summary.fallbackUsed,
    skipped: false,
  };
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
      updates: [],
      summaryFallbacks: 0,
      summarySkipped: 0,
    };
  }
  if (hasNonAcceptedMember(cluster)) {
    const item = buildDuplicateReviewItem(cluster, resolved, "duplicate-review");
    return {
      edges: [],
      reviewItem: item === null ? null : withProposedReviewEdges(item, resolved),
      updates: [],
      summaryFallbacks: 0,
      summarySkipped: 0,
    };
  }
  const older = cluster.members[0];
  const newer = cluster.members[1];
  if (older === undefined || newer === undefined) {
    return { edges: [], reviewItem: null, updates: [], summaryFallbacks: 0, summarySkipped: 0 };
  }
  return {
    edges: buildDuplicateEdges(older, newer, resolved),
    reviewItem: null,
    updates: [],
    summaryFallbacks: 0,
    summarySkipped: 0,
  };
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
  const summary = buildSummaryUpdate(cluster, resolved);
  return {
    edges: [],
    reviewItem: item === undefined ? null : withProposedReviewEdges(item, resolved),
    updates: summary.update === null ? [] : [summary.update],
    summaryFallbacks: summary.fallbackUsed ? 1 : 0,
    summarySkipped: summary.skipped ? 1 : 0,
  };
}

function processCluster(cluster: DuplicateCluster, resolved: ResolvedOptions): ClusterEffects {
  if (cluster.members.length > 2) return processMultiWayCluster(cluster, resolved);
  if (cluster.members.length === 2) return processTwoMemberCluster(cluster, resolved);
  return { edges: [], reviewItem: null, updates: [], summaryFallbacks: 0, summarySkipped: 0 };
}

interface ConsumeResult {
  readonly state: "completed" | "canceled";
  readonly edges: MemoryEdge[];
  readonly reviewItems: ReviewItem[];
  readonly updates: MemoryUpdate[];
  readonly summaryFallbacks: number;
  readonly summarySkipped: number;
  readonly clustersInspected: number;
}

function consumeClusters(
  clusters: readonly DuplicateCluster[],
  resolved: ResolvedOptions,
): ConsumeResult {
  const edges: MemoryEdge[] = [];
  const reviewItems: ReviewItem[] = [];
  const updates: MemoryUpdate[] = [];
  let summaryFallbacks = 0;
  let summarySkipped = 0;
  let clustersInspected = 0;
  const limit = Math.min(clusters.length, resolved.maxClustersPerRun);
  for (let i = 0; i < limit; i += 1) {
    if (resolved.cancellationSignal()) {
      return {
        state: "canceled",
        edges,
        reviewItems,
        updates,
        summaryFallbacks,
        summarySkipped,
        clustersInspected,
      };
    }
    const cluster = clusters[i];
    if (cluster === undefined) continue;
    const effects = processCluster(cluster, resolved);
    for (const edge of effects.edges) edges.push(edge);
    for (const update of effects.updates) updates.push(update);
    if (effects.reviewItem !== null) reviewItems.push(effects.reviewItem);
    summaryFallbacks += effects.summaryFallbacks;
    summarySkipped += effects.summarySkipped;
    clustersInspected += 1;
  }
  return {
    state: "completed",
    edges,
    reviewItems,
    updates,
    summaryFallbacks,
    summarySkipped,
    clustersInspected,
  };
}

function collectStaleFlags(
  records: readonly MemoryRecord[],
  resolved: ResolvedOptions,
): readonly StaleFlag[] {
  return findStaleMemories(records, {
    nowMs: resolved.nowMs,
    staleConfidenceThreshold: resolved.staleConfidenceThreshold,
    maxAgeMs: resolved.maxAgeMs,
    ...(resolved.accessStatsFor !== undefined ? { accessStatsFor: resolved.accessStatsFor } : {}),
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

type PreparedConsolidation =
  | { readonly kind: "result"; readonly result: ConsolidationResult }
  | {
      readonly kind: "ready";
      readonly resolved: ResolvedOptions;
      readonly bounded: { readonly records: readonly MemoryRecord[]; readonly truncated: boolean };
    };

function prepareConsolidationRun(
  memories: readonly MemoryRecord[],
  options: ConsolidationOptions,
): PreparedConsolidation {
  const resolved = resolveOptions(options);
  if (resolved === null) return { kind: "result", result: emptyResult("failed") };
  if (resolved.cancellationSignal()) {
    return { kind: "result", result: emptyResult("canceled", 0, false, resolved) };
  }
  const eligible = eligibleMemories(memories, resolved);
  if (eligible === null)
    return { kind: "result", result: emptyResult("failed", 0, false, resolved) };
  if (eligible.length === 0) {
    return { kind: "result", result: emptyResult("skipped", 0, false, resolved) };
  }
  const bounded = boundedEligibleMemories(eligible, resolved);
  if (bounded.records.length === 0 || resolved.maxClustersPerRun === 0) {
    return {
      kind: "result",
      result: emptyResult("skipped", bounded.records.length, bounded.truncated, resolved),
    };
  }
  return { kind: "ready", resolved, bounded };
}

// Public entry. Same input + same options => byte-identical result.
export function runConsolidation(
  memories: readonly MemoryRecord[],
  options: ConsolidationOptions,
): ConsolidationResult {
  const prepared = prepareConsolidationRun(memories, options);
  if (prepared.kind === "result") return prepared.result;
  const { resolved, bounded } = prepared;
  const scanned = scanDuplicateClusters(bounded.records, resolved.jaccardThreshold, {
    cancellationSignal: resolved.cancellationSignal,
    semanticSimilarityThreshold: resolved.semanticSimilarityThreshold,
    ...(resolved.embeddingFor !== undefined ? { embeddingFor: resolved.embeddingFor } : {}),
  });
  if (scanned.canceled && scanned.clusters.length === 0) {
    return emptyResult("canceled", bounded.records.length, bounded.truncated, resolved);
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
    updatesProposed: sortUpdates(consumed.updates),
    summaryStatus: summaryStatusFromConsume(resolved, consumed),
    staleFlags,
    reviewItems: mergedReviewItems,
    clustersInspected: consumed.clustersInspected,
    conflictPairsDetected: conflictPairs.length,
    recordsInspected: bounded.records.length,
    truncated: bounded.truncated,
    elapsedMs: 0,
  };
}
