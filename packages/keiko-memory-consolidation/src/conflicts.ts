// Conflict and multi-way-duplicate review-item emission. Pure function.
//
// Two emission cases, mutually exclusive per cluster:
//
//   1. multi-way-duplicate (cluster.members.length > 2): one ReviewItem proposing a `merge`
//      with the newest member as winner and all older members as losers. Multi-way
//      consolidation is always operator-reviewed; the engine never auto-merges three or more
//      records (loss of provenance lineage is too easy to do silently). Multi-way takes
//      PRECEDENCE over negation detection: a 3-member cluster with one negation is still
//      surfaced as multi-way, because the operator needs to disambiguate the polarity too.
//
//   2. potential-conflict (exactly 2 members AND opposite negation polarity): one ReviewItem
//      proposing a `supersede` with the newer record replacing the older one. v1 negation
//      detection is a substring check: a "negation marker" is " not " (with surrounding
//      spaces, so it does not match "another" or "annotation") or "n't " (English
//      contraction). The pair is in conflict when exactly ONE side carries a negation
//      marker — XOR. Same-polarity pairs (both negate or both affirm) are NOT conflicts.
//
// Two-member non-conflicting clusters produce NO review item from this layer — the
// orchestrator emits a `derived-from` edge instead.

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { compareRecordsByAge, compareReviewItems, scopeCoordinateKey } from "./_ordering.js";
import type { DuplicateCluster } from "./dedupe.js";
import { jaccardSimilarityPrepared, normalizeBody, prepareBody } from "./similarity.js";
import type { ProposedAction, ReviewItem } from "./types.js";

// Conflict-detection overlap threshold. Lower than the dedup Jaccard default (0.85) because a
// polarity-flip pair like "we use tabs" vs "we do not use tabs" shares fewer bigrams than two
// near-duplicate paraphrases: the negation token injects new bigrams without removing the
// affirming material. 0.4 is empirically a good floor — high enough that "x is true" vs "y is
// not false" does not fire, low enough that obvious polarity flips do.
export const CONFLICT_OVERLAP_THRESHOLD = 0.4;

export interface ConflictsOptions {
  readonly nowMs: number;
  readonly newReviewItemId: () => string;
  readonly cancellationSignal?: () => boolean;
}

// Negation markers checked AFTER normalizeBody (lowercased, punctuation removed). The
// surrounding spaces make the check whole-word: " not " inside the normalized body avoids
// "another"/"annotation"/"notation". "nt " (post-strip form of "n't") catches contractions
// like don't, won't, isn't, can't, didn't, etc.
const NEGATION_MARKERS: readonly string[] = [" not ", "nt "];

function hasNegation(body: string): boolean {
  // Pad both sides with a space so a marker that would normally be position-anchored (e.g.
  // body starts with "not ") is still detected by the same indexOf check.
  const padded = ` ${normalizeBody(body)} `;
  for (const marker of NEGATION_MARKERS) {
    if (padded.includes(marker)) return true;
  }
  return false;
}

function buildMultiWayItem(cluster: DuplicateCluster, options: ConflictsOptions): ReviewItem {
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  const winner = sorted[sorted.length - 1];
  const losers = sorted.slice(0, -1);
  if (winner === undefined) {
    // Caller guards on cluster.members.length > 2; this branch is unreachable structurally.
    throw new Error("buildMultiWayItem: empty cluster (unreachable)");
  }
  const action: ProposedAction = {
    kind: "merge",
    winner: winner.id,
    losers: losers.map((m) => m.id),
  };
  return {
    id: options.newReviewItemId(),
    reason: "multi-way-duplicate",
    relatedMemoryIds: sorted.map((m) => m.id),
    proposedAction: action,
    detectedAt: options.nowMs,
  };
}

function isPolarityConflict(older: { body: string }, newer: { body: string }): boolean {
  return hasNegation(older.body) !== hasNegation(newer.body);
}

function tryBuildPairConflict(
  cluster: DuplicateCluster,
  options: ConflictsOptions,
): ReviewItem | null {
  if (cluster.members.length !== 2) return null;
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  const older = sorted[0];
  const newer = sorted[1];
  if (older === undefined || newer === undefined) return null;
  if (!isPolarityConflict(older, newer)) return null;
  const action: ProposedAction = { kind: "supersede", newer: newer.id, older: older.id };
  return {
    id: options.newReviewItemId(),
    reason: "potential-conflict",
    relatedMemoryIds: [older.id, newer.id],
    proposedAction: action,
    detectedAt: options.nowMs,
  };
}

// Public entry. Returns review items sorted by (reason, related-ids, id) for byte-stable
// output. Multi-way takes precedence over per-cluster conflict detection (a 3-member cluster
// with mixed polarity surfaces as ONE multi-way item, not multi-way + conflict).
export function detectConflicts(
  clusters: readonly DuplicateCluster[],
  options: ConflictsOptions,
): readonly ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const cluster of clusters) {
    if (cluster.members.length > 2) {
      items.push(buildMultiWayItem(cluster, options));
      continue;
    }
    const pair = tryBuildPairConflict(cluster, options);
    if (pair !== null) items.push(pair);
  }
  return items.sort(compareReviewItems);
}

// Partition key used by both dedup and the conflict-pair sweep: scope + type. Cross-scope and
// cross-type pairs never produce a conflict for the same reason they never produce a duplicate
// cluster — the visibility invariant from #205 holds structurally.
function conflictPartitionKey(record: MemoryRecord): string {
  return `${scopeCoordinateKey(record.scope)}|type:${record.type}`;
}

function partitionForConflicts(
  records: readonly MemoryRecord[],
): readonly (readonly MemoryRecord[])[] {
  const partitions = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = conflictPartitionKey(record);
    const bucket = partitions.get(key);
    if (bucket === undefined) {
      partitions.set(key, [record]);
    } else {
      bucket.push(record);
    }
  }
  return [...partitions.values()];
}

function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

function buildExcludeSet(clusters: readonly DuplicateCluster[]): Set<string> {
  const excluded = new Set<string>();
  for (const cluster of clusters) {
    const ids = cluster.members.map((m) => m.id);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i];
        const b = ids[j];
        if (a === undefined || b === undefined) continue;
        excluded.add(pairKey(a, b));
      }
    }
  }
  return excluded;
}

function buildConflictPairItem(
  older: MemoryRecord,
  newer: MemoryRecord,
  options: ConflictsOptions,
): ReviewItem {
  const action: ProposedAction = { kind: "supersede", newer: newer.id, older: older.id };
  return {
    id: options.newReviewItemId(),
    reason: "potential-conflict",
    relatedMemoryIds: [older.id, newer.id],
    proposedAction: action,
    detectedAt: options.nowMs,
  };
}

function shouldSkipPair(
  older: MemoryRecord | undefined,
  newer: MemoryRecord | undefined,
  olderPrepared: ReturnType<typeof prepareBody> | undefined,
  newerPrepared: ReturnType<typeof prepareBody> | undefined,
  excluded: ReadonlySet<string>,
): boolean {
  if (older === undefined || newer === undefined) return true;
  if (olderPrepared === undefined || newerPrepared === undefined) return true;
  if (excluded.has(pairKey(older.id, newer.id))) return true;
  return !isPolarityConflict(older, newer);
}

function resolveComparablePair(
  older: MemoryRecord | undefined,
  newer: MemoryRecord | undefined,
  olderPrepared: ReturnType<typeof prepareBody> | undefined,
  newerPrepared: ReturnType<typeof prepareBody> | undefined,
): {
  readonly older: MemoryRecord;
  readonly newer: MemoryRecord;
  readonly olderPrepared: ReturnType<typeof prepareBody>;
  readonly newerPrepared: ReturnType<typeof prepareBody>;
} | null {
  if (older === undefined || newer === undefined) return null;
  if (olderPrepared === undefined || newerPrepared === undefined) return null;
  return { older, newer, olderPrepared, newerPrepared };
}

function scanPartitionPairs(
  partition: readonly MemoryRecord[],
  excluded: ReadonlySet<string>,
  overlapThreshold: number,
  options: ConflictsOptions,
): { readonly items: readonly ReviewItem[]; readonly canceled: boolean } {
  const items: ReviewItem[] = [];
  const sorted = [...partition].sort(compareRecordsByAge);
  const prepared = sorted.map((record) => prepareBody(record.body));
  for (let i = 0; i < sorted.length; i += 1) {
    if (options.cancellationSignal?.() === true) {
      return { items, canceled: true };
    }
    for (let j = i + 1; j < sorted.length; j += 1) {
      const older = sorted[i];
      const newer = sorted[j];
      const olderPrepared = prepared[i];
      const newerPrepared = prepared[j];
      if (shouldSkipPair(older, newer, olderPrepared, newerPrepared, excluded)) continue;
      const pair = resolveComparablePair(older, newer, olderPrepared, newerPrepared);
      if (pair === null) continue;
      if (jaccardSimilarityPrepared(pair.olderPrepared, pair.newerPrepared) < overlapThreshold) {
        continue;
      }
      items.push(buildConflictPairItem(pair.older, pair.newer, options));
    }
  }
  return { items, canceled: false };
}

// Conflict-pair sweep — finds polarity-flip pairs that did NOT surface as duplicate clusters
// because their bigram overlap is below the dedup Jaccard threshold but at or above the
// (looser) conflict overlap threshold. Pairs already represented in `excludeClusters` are
// skipped so the same (older, newer) does not produce both a cluster review item and a pair
// review item. Returns sorted output.
export function findConflictPairs(
  records: readonly MemoryRecord[],
  excludeClusters: readonly DuplicateCluster[],
  overlapThreshold: number,
  options: ConflictsOptions,
): readonly ReviewItem[] {
  const excluded = buildExcludeSet(excludeClusters);
  const partitions = partitionForConflicts(records);
  const items: ReviewItem[] = [];
  for (const partition of partitions) {
    const scanned = scanPartitionPairs(partition, excluded, overlapThreshold, options);
    for (const item of scanned.items) {
      items.push(item);
    }
    if (scanned.canceled) break;
  }
  return items.sort(compareReviewItems);
}
