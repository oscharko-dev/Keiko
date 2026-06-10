// Near-duplicate clustering. Pure function; deterministic; never mutates input.
//
// Algorithm:
//   1. Partition input by (scopeCoordinateKey, type). Cross-scope and cross-type records
//      are never merged — this is the load-bearing visibility invariant from #205.
//   2. Within each partition, build clusters using a union-find-by-iteration sweep:
//      for each record, find the first existing cluster whose CANONICAL member matches by
//      one of (exact body, normalized body, bigram-Jaccard at-or-above threshold). If found,
//      add to that cluster; otherwise open a new singleton cluster. Comparing to the canonical
//      (oldest) member only — not pairwise to every member — is a cost compromise that holds
//      because clusters are small in practice and the canonical member is the representative
//      most likely to share the dominant body shape.
//   3. Drop singleton clusters (consolidation needs ≥ 2 members to act).
//   4. Sort members oldest-first (createdAt ASC, id ASC). Sort clusters by canonical (oldest)
//      member id so the output is byte-stable across input shuffles.

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { compareRecordsByAge, scopeCoordinateKey } from "./_ordering.js";
import { jaccardSimilarityPrepared, prepareBody, type PreparedBody } from "./similarity.js";

export interface DuplicateCluster {
  // Oldest member of the cluster. The "canonical" representative used by the orchestrator to
  // decide which record absorbs (or, in v1, supersedes) the others.
  readonly canonicalId: string;
  readonly members: readonly MemoryRecord[];
}

interface MutableCluster {
  readonly canonical: MemoryRecord;
  readonly canonicalBody: PreparedBody;
  readonly members: MemoryRecord[];
}

export interface DuplicateClusterScanOptions {
  readonly cancellationSignal?: () => boolean;
}

export interface DuplicateClusterScanResult {
  readonly clusters: readonly DuplicateCluster[];
  readonly canceled: boolean;
}

function partitionKey(record: MemoryRecord): string {
  return `${scopeCoordinateKey(record.scope)}|type:${record.type}`;
}

// Returns true when `candidate` should join the existing `cluster`. Compared only to the
// canonical (oldest) member to keep cluster-add at O(1) per candidate per cluster.
function clusterAccepts(
  cluster: MutableCluster,
  candidateBody: PreparedBody,
  jaccardThreshold: number,
): boolean {
  if (candidateBody.normalized === cluster.canonicalBody.normalized) return true;
  const score = jaccardSimilarityPrepared(candidateBody, cluster.canonicalBody);
  return score >= jaccardThreshold;
}

function tryJoinExistingCluster(
  partition: MutableCluster[],
  candidate: MemoryRecord,
  candidateBody: PreparedBody,
  jaccardThreshold: number,
): boolean {
  for (const cluster of partition) {
    if (clusterAccepts(cluster, candidateBody, jaccardThreshold)) {
      cluster.members.push(candidate);
      return true;
    }
  }
  return false;
}

function clusterPartition(
  records: readonly MemoryRecord[],
  jaccardThreshold: number,
  cancellationSignal?: () => boolean,
): { readonly clusters: readonly MutableCluster[]; readonly canceled: boolean } {
  // Order inputs so the OLDEST record in any group of similar records becomes the canonical
  // member (cluster.canonical). Without this, the canonical would depend on input order — a
  // determinism break.
  const ordered = [...records].sort(compareRecordsByAge);
  const partition: MutableCluster[] = [];
  for (const record of ordered) {
    if (cancellationSignal?.() === true) {
      return { clusters: partition, canceled: true };
    }
    const prepared = prepareBody(record.body);
    if (tryJoinExistingCluster(partition, record, prepared, jaccardThreshold)) continue;
    partition.push({
      canonical: record,
      canonicalBody: prepared,
      members: [record],
    });
  }
  return { clusters: partition, canceled: false };
}

function finalizeCluster(cluster: MutableCluster): DuplicateCluster {
  const sortedMembers = [...cluster.members].sort(compareRecordsByAge);
  return {
    canonicalId: cluster.canonical.id,
    members: sortedMembers,
  };
}

// Public entry point. Returns clusters of size >= 2 only; singletons are filtered out.
// Output is deterministic for any permutation of `records`.
export function scanDuplicateClusters(
  records: readonly MemoryRecord[],
  jaccardThreshold: number,
  options: DuplicateClusterScanOptions = {},
): DuplicateClusterScanResult {
  const partitions = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = partitionKey(record);
    const bucket = partitions.get(key);
    if (bucket === undefined) {
      partitions.set(key, [record]);
    } else {
      bucket.push(record);
    }
  }
  const clusters: DuplicateCluster[] = [];
  let canceled = false;
  for (const bucket of partitions.values()) {
    const built = clusterPartition(bucket, jaccardThreshold, options.cancellationSignal);
    canceled ||= built.canceled;
    for (const cluster of built.clusters) {
      if (cluster.members.length >= 2) {
        clusters.push(finalizeCluster(cluster));
      }
    }
    if (canceled) break;
  }
  // Stable cluster ordering: by canonical id (the oldest member's id is unique per cluster).
  return {
    clusters: clusters.sort((a, b) =>
      a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0,
    ),
    canceled,
  };
}

export function findDuplicateClusters(
  records: readonly MemoryRecord[],
  jaccardThreshold: number,
): readonly DuplicateCluster[] {
  return scanDuplicateClusters(records, jaccardThreshold).clusters;
}
