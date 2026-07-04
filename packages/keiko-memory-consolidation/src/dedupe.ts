// Near-duplicate clustering. Pure function; deterministic; never mutates input.
//
// Algorithm:
//   1. Partition input by (scopeCoordinateKey, type). Cross-scope and cross-type records
//      are never merged — this is the load-bearing visibility invariant from #205.
//   2. Within each partition, compare every bounded pair. A pair can connect by exact normalized
//      body, lexical Jaccard, or caller-supplied embedding cosine similarity. Connected pairs are
//      unioned, so A~B and B~C yields one transitive cluster even if A~C is below threshold.
//   3. Drop singleton clusters (consolidation needs ≥ 2 members to act).
//   4. Sort members oldest-first (createdAt ASC, id ASC). Sort clusters by canonical (oldest)
//      member id so the output is byte-stable across input shuffles.

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { compareRecordsByAge, scopeCoordinateKey } from "./_ordering.js";
import {
  cosineSimilarity,
  jaccardSimilarityPrepared,
  prepareBody,
  type PreparedBody,
} from "./similarity.js";
import type { ConsolidationEmbedding, ConsolidationEvidence } from "./types.js";

export interface DuplicateCluster {
  // Oldest member of the cluster. The "canonical" representative used by the orchestrator to
  // decide which record absorbs (or, in v1, supersedes) the others.
  readonly canonicalId: string;
  readonly members: readonly MemoryRecord[];
  readonly evidence?: readonly ConsolidationEvidence[];
}

export interface DuplicateClusterScanOptions {
  readonly cancellationSignal?: () => boolean;
  readonly embeddingFor?: (id: MemoryRecord["id"]) => ConsolidationEmbedding | undefined;
  readonly semanticSimilarityThreshold?: number;
}

export interface DuplicateClusterScanResult {
  readonly clusters: readonly DuplicateCluster[];
  readonly canceled: boolean;
}

function partitionKey(record: MemoryRecord): string {
  return `${scopeCoordinateKey(record.scope)}|type:${record.type}`;
}

interface UnionFind {
  readonly parent: number[];
}

function createUnionFind(size: number): UnionFind {
  return { parent: Array.from({ length: size }, (_, index) => index) };
}

function findRoot(uf: UnionFind, index: number): number {
  let root = index;
  while (uf.parent[root] !== root) {
    root = uf.parent[root] ?? root;
  }
  let cursor = index;
  while (uf.parent[cursor] !== cursor) {
    const parent = uf.parent[cursor];
    if (parent === undefined) break;
    uf.parent[cursor] = root;
    cursor = parent;
  }
  return root;
}

function union(uf: UnionFind, a: number, b: number): void {
  const rootA = findRoot(uf, a);
  const rootB = findRoot(uf, b);
  if (rootA === rootB) return;
  if (rootA < rootB) {
    uf.parent[rootB] = rootA;
  } else {
    uf.parent[rootA] = rootB;
  }
}

function compatibleOptionalField<T>(left: T | undefined, right: T | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function compatibleEmbedding(
  a: ConsolidationEmbedding | undefined,
  b: ConsolidationEmbedding | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    a.vector.length > 0 &&
    a.vector.length === b.vector.length &&
    compatibleOptionalField(a.metric, b.metric) &&
    compatibleOptionalField(a.provider, b.provider) &&
    compatibleOptionalField(a.modelId, b.modelId) &&
    compatibleOptionalField(a.modelRevision, b.modelRevision)
  );
}

function lexicalEvidence(
  a: MemoryRecord,
  b: MemoryRecord,
  score: number,
  threshold: number,
  detail: string,
): ConsolidationEvidence {
  return {
    kind: "lexical-similarity",
    memoryIds: [a.id, b.id],
    score,
    threshold,
    detail,
  };
}

function semanticEvidence(
  a: MemoryRecord,
  b: MemoryRecord,
  score: number,
  threshold: number,
): ConsolidationEvidence {
  return {
    kind: "semantic-similarity",
    memoryIds: [a.id, b.id],
    score,
    threshold,
  };
}

function matchPair(
  a: MemoryRecord,
  b: MemoryRecord,
  aBody: PreparedBody,
  bBody: PreparedBody,
  jaccardThreshold: number,
  embeddingA: ConsolidationEmbedding | undefined,
  embeddingB: ConsolidationEmbedding | undefined,
  semanticSimilarityThreshold: number | undefined,
): ConsolidationEvidence | null {
  if (aBody.normalized === bBody.normalized) {
    return lexicalEvidence(a, b, 1, jaccardThreshold, "normalized-body");
  }
  const lexicalScore = jaccardSimilarityPrepared(aBody, bBody);
  if (lexicalScore >= jaccardThreshold) {
    return lexicalEvidence(a, b, lexicalScore, jaccardThreshold, "bigram-jaccard");
  }
  if (
    semanticSimilarityThreshold !== undefined &&
    embeddingA !== undefined &&
    embeddingB !== undefined &&
    compatibleEmbedding(embeddingA, embeddingB)
  ) {
    const semanticScore = cosineSimilarity(embeddingA.vector, embeddingB.vector);
    if (semanticScore !== null && semanticScore >= semanticSimilarityThreshold) {
      return semanticEvidence(a, b, semanticScore, semanticSimilarityThreshold);
    }
  }
  return null;
}

function collectEmbeddings(
  records: readonly MemoryRecord[],
  embeddingFor: DuplicateClusterScanOptions["embeddingFor"],
): readonly (ConsolidationEmbedding | undefined)[] {
  if (embeddingFor === undefined) return records.map(() => undefined);
  return records.map((record) => embeddingFor(record.id));
}

interface PartitionBuildResult {
  readonly clusters: readonly DuplicateCluster[];
  readonly canceled: boolean;
}

function finalizeClusters(
  ordered: readonly MemoryRecord[],
  uf: UnionFind,
  evidenceByRoot: ReadonlyMap<number, readonly ConsolidationEvidence[]>,
): readonly DuplicateCluster[] {
  const grouped = new Map<number, MemoryRecord[]>();
  for (let i = 0; i < ordered.length; i += 1) {
    const record = ordered[i];
    if (record === undefined) continue;
    const root = findRoot(uf, i);
    const bucket = grouped.get(root);
    if (bucket === undefined) grouped.set(root, [record]);
    else bucket.push(record);
  }
  const clusters: DuplicateCluster[] = [];
  for (const [root, members] of grouped.entries()) {
    if (members.length < 2) continue;
    const sortedMembers = [...members].sort(compareRecordsByAge);
    const canonical = sortedMembers[0];
    if (canonical === undefined) continue;
    clusters.push({
      canonicalId: canonical.id,
      members: sortedMembers,
      evidence: evidenceByRoot.get(root) ?? [],
    });
  }
  return clusters;
}

function normalizeEvidenceRoots(
  uf: UnionFind,
  pairEvidence: readonly { readonly left: number; readonly evidence: ConsolidationEvidence }[],
): ReadonlyMap<number, readonly ConsolidationEvidence[]> {
  const byRoot = new Map<number, ConsolidationEvidence[]>();
  for (const item of pairEvidence) {
    const root = findRoot(uf, item.left);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [item.evidence]);
    else bucket.push(item.evidence);
  }
  return byRoot;
}

function cancellationRequested(options: DuplicateClusterScanOptions): boolean {
  return options.cancellationSignal?.() === true;
}

function matchIndexedPair(
  ordered: readonly MemoryRecord[],
  prepared: readonly PreparedBody[],
  embeddings: readonly (ConsolidationEmbedding | undefined)[],
  jaccardThreshold: number,
  options: DuplicateClusterScanOptions,
  i: number,
  j: number,
): ConsolidationEvidence | null {
  const a = ordered[i];
  const b = ordered[j];
  const aBody = prepared[i];
  const bBody = prepared[j];
  if (a === undefined || b === undefined || aBody === undefined || bBody === undefined) return null;
  return matchPair(
    a,
    b,
    aBody,
    bBody,
    jaccardThreshold,
    embeddings[i],
    embeddings[j],
    options.semanticSimilarityThreshold,
  );
}

function scanPartitionPairs(
  ordered: readonly MemoryRecord[],
  prepared: readonly PreparedBody[],
  embeddings: readonly (ConsolidationEmbedding | undefined)[],
  jaccardThreshold: number,
  options: DuplicateClusterScanOptions,
  uf: UnionFind,
): {
  readonly canceled: boolean;
  readonly pairEvidence: readonly {
    readonly left: number;
    readonly evidence: ConsolidationEvidence;
  }[];
} {
  const pairEvidence: { left: number; evidence: ConsolidationEvidence }[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (cancellationRequested(options)) return { canceled: true, pairEvidence };
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (cancellationRequested(options)) return { canceled: true, pairEvidence };
      const evidence = matchIndexedPair(
        ordered,
        prepared,
        embeddings,
        jaccardThreshold,
        options,
        i,
        j,
      );
      if (evidence === null) continue;
      union(uf, i, j);
      pairEvidence.push({ left: i, evidence });
    }
  }
  return { canceled: false, pairEvidence };
}

function clusterPartition(
  records: readonly MemoryRecord[],
  jaccardThreshold: number,
  options: DuplicateClusterScanOptions,
): PartitionBuildResult {
  const ordered = [...records].sort(compareRecordsByAge);
  const prepared = ordered.map((record) => prepareBody(record.body));
  const embeddings = collectEmbeddings(ordered, options.embeddingFor);
  const uf = createUnionFind(ordered.length);
  const { canceled, pairEvidence } = scanPartitionPairs(
    ordered,
    prepared,
    embeddings,
    jaccardThreshold,
    options,
    uf,
  );
  const evidenceByRoot = normalizeEvidenceRoots(uf, pairEvidence);
  return { clusters: finalizeClusters(ordered, uf, evidenceByRoot), canceled };
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
    const built = clusterPartition(bucket, jaccardThreshold, options);
    canceled ||= built.canceled;
    for (const cluster of built.clusters) {
      clusters.push(cluster);
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
  options: DuplicateClusterScanOptions = {},
): readonly DuplicateCluster[] {
  return scanDuplicateClusters(records, jaccardThreshold, options).clusters;
}
