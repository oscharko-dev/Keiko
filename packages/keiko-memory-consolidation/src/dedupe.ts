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
import { jaccardSimilarity, normalizeBody } from "./similarity.js";

export interface DuplicateCluster {
  // Oldest member of the cluster. The "canonical" representative used by the orchestrator to
  // decide which record absorbs (or, in v1, supersedes) the others.
  readonly canonicalId: string;
  readonly members: readonly MemoryRecord[];
}

interface MutableCluster {
  readonly canonical: MemoryRecord;
  readonly canonicalNormalized: string;
  readonly members: MemoryRecord[];
}

function partitionKey(record: MemoryRecord): string {
  return `${scopeCoordinateKey(record.scope)}|type:${record.type}`;
}

// Returns true when `candidate` should join the existing `cluster`. Compared only to the
// canonical (oldest) member to keep cluster-add at O(1) per candidate per cluster.
function clusterAccepts(
  cluster: MutableCluster,
  candidate: MemoryRecord,
  candidateNormalized: string,
  jaccardThreshold: number,
): boolean {
  if (candidate.body === cluster.canonical.body) return true;
  if (candidateNormalized === cluster.canonicalNormalized) return true;
  const score = jaccardSimilarity(candidate.body, cluster.canonical.body);
  return score >= jaccardThreshold;
}

function tryJoinExistingCluster(
  partition: MutableCluster[],
  candidate: MemoryRecord,
  candidateNormalized: string,
  jaccardThreshold: number,
): boolean {
  for (const cluster of partition) {
    if (clusterAccepts(cluster, candidate, candidateNormalized, jaccardThreshold)) {
      cluster.members.push(candidate);
      return true;
    }
  }
  return false;
}

function clusterPartition(
  records: readonly MemoryRecord[],
  jaccardThreshold: number,
): MutableCluster[] {
  // Order inputs so the OLDEST record in any group of similar records becomes the canonical
  // member (cluster.canonical). Without this, the canonical would depend on input order — a
  // determinism break.
  const ordered = [...records].sort(compareRecordsByAge);
  const partition: MutableCluster[] = [];
  for (const record of ordered) {
    const normalized = normalizeBody(record.body);
    if (tryJoinExistingCluster(partition, record, normalized, jaccardThreshold)) continue;
    partition.push({
      canonical: record,
      canonicalNormalized: normalized,
      members: [record],
    });
  }
  return partition;
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
export function findDuplicateClusters(
  records: readonly MemoryRecord[],
  jaccardThreshold: number,
): readonly DuplicateCluster[] {
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
  for (const bucket of partitions.values()) {
    const built = clusterPartition(bucket, jaccardThreshold);
    for (const cluster of built) {
      if (cluster.members.length >= 2) {
        clusters.push(finalizeCluster(cluster));
      }
    }
  }
  // Stable cluster ordering: by canonical id (the oldest member's id is unique per cluster).
  return clusters.sort((a, b) =>
    a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0,
  );
}
