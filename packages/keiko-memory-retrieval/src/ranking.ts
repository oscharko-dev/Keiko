// Ranking orchestration.
//
// Hybrid ranker over (relevance, recency, confidence, pinned, correction, graph). Two
// passes:
//   Pass 1 — baseline subscores per memory (graph contribution = 0). Sort. The top-N of
//            this pass become the "high-rank set" for the graph pass; the graph signal
//            cannot reference itself recursively because the high-rank set is fixed
//            BEFORE the graph contribution is computed.
//   Pass 2 — graph proximity is computed for each memory against the high-rank set, and
//            the entry is rebuilt with the layered subscore. Re-sort and return.
//
// Tiebreak order: score desc, updatedAt desc, id asc. Stable across equal-score sets so
// the same input always produces the same output (determinism is an explicit AC).
//
// Inclusion reason names the top contributing WEIGHTED subscore. The threshold for
// "primarily because of X" is "X contributes more than any other dimension" — no
// arbitrary cutoff — so the reason text always tracks the actual top contributor.

import type { MemoryEdge, MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { graphProximityScore } from "./graph.js";
import { recencyScore } from "./recency.js";
import { lexicalRelevance } from "./relevance.js";
import type { IncludedMemory, IncludedSubscores, RankingWeights } from "./types.js";

export interface RankMemoriesQuery {
  readonly queryText?: string;
  readonly nowMs: number;
  readonly weights: RankingWeights;
  // Per-memory cosine similarity in [0,1] keyed by memory id (#204). When undefined, the ranker
  // zeroes the semantic weight so output is byte-identical to pre-semantic lexical behaviour.
  readonly semanticById?: ReadonlyMap<MemoryId, number> | undefined;
}

export interface RankMemoriesOptions {
  readonly edgesByMemory?: ReadonlyMap<MemoryId, readonly MemoryEdge[]>;
  /** How many top baseline entries become the high-rank set for graph proximity. */
  readonly graphHighRankCount?: number;
}

const DEFAULT_GRAPH_HIGH_RANK_COUNT = 8;

function baselineSubscores(record: MemoryRecord, query: RankMemoriesQuery): IncludedSubscores {
  return {
    relevance: lexicalRelevance(query.queryText, record),
    recency: recencyScore(record.updatedAt, query.nowMs),
    confidence: record.provenance.confidence,
    pinned: record.pinned ? 1 : 0,
    correction:
      record.type === "correction" || record.provenance.sourceKind === "accepted-correction"
        ? 1
        : 0,
    graph: 0,
    semantic: query.semanticById?.get(record.id) ?? 0,
  };
}

function weightedScore(s: IncludedSubscores, w: RankingWeights): number {
  const raw =
    s.relevance * w.relevance +
    s.recency * w.recency +
    s.confidence * w.confidence +
    s.pinned * w.pinned +
    s.correction * w.correction +
    s.graph * w.graph +
    s.semantic * w.semantic;
  const totalWeight =
    w.relevance + w.recency + w.confidence + w.pinned + w.correction + w.graph + w.semantic;
  if (totalWeight <= 0) return 0;
  return raw / totalWeight;
}

function topContributor(s: IncludedSubscores, w: RankingWeights): string {
  const parts: readonly { readonly key: keyof IncludedSubscores; readonly value: number }[] = [
    { key: "pinned", value: s.pinned * w.pinned },
    { key: "correction", value: s.correction * w.correction },
    // Semantic before relevance/recency/confidence so the stronger embedding signal wins a tie
    // against the lexical signals; pinned/correction stay above it as today.
    { key: "semantic", value: s.semantic * w.semantic },
    { key: "relevance", value: s.relevance * w.relevance },
    { key: "recency", value: s.recency * w.recency },
    { key: "confidence", value: s.confidence * w.confidence },
    { key: "graph", value: s.graph * w.graph },
  ];
  let bestKey: keyof IncludedSubscores = "recency";
  let bestValue = -1;
  for (const p of parts) {
    if (p.value > bestValue) {
      bestKey = p.key;
      bestValue = p.value;
    }
  }
  return inclusionReasonText(bestKey, bestValue);
}

function inclusionReasonText(key: keyof IncludedSubscores, value: number): string {
  if (value <= 0) return "included by default ranking";
  const label: Record<keyof IncludedSubscores, string> = {
    relevance: "lexical relevance to query",
    recency: "recent update",
    confidence: "high provenance confidence",
    pinned: "pinned memory",
    correction: "recent correction overrides older facts",
    graph: "graph proximity to other top memories",
    semantic: "semantic similarity to query",
  };
  return `top signal: ${label[key]}`;
}

function entryFor(
  record: MemoryRecord,
  subscores: IncludedSubscores,
  weights: RankingWeights,
): IncludedMemory {
  const score = weightedScore(subscores, weights);
  return {
    memoryId: record.id,
    score,
    subscores,
    inclusionReason: topContributor(subscores, weights),
  };
}

function compareEntries(
  aEntry: IncludedMemory,
  bEntry: IncludedMemory,
  aRecord: MemoryRecord,
  bRecord: MemoryRecord,
): number {
  if (aEntry.score !== bEntry.score) return bEntry.score - aEntry.score;
  if (aRecord.updatedAt !== bRecord.updatedAt) return bRecord.updatedAt - aRecord.updatedAt;
  if (aEntry.memoryId < bEntry.memoryId) return -1;
  if (aEntry.memoryId > bEntry.memoryId) return 1;
  return 0;
}

function sortByRank(
  entries: readonly IncludedMemory[],
  recordById: ReadonlyMap<MemoryId, MemoryRecord>,
): readonly IncludedMemory[] {
  return [...entries].sort((a, b) => {
    const aRecord = recordById.get(a.memoryId);
    const bRecord = recordById.get(b.memoryId);
    if (aRecord === undefined || bRecord === undefined) return 0;
    return compareEntries(a, b, aRecord, bRecord);
  });
}

// Byte-identity guarantee (#204): when the caller supplied NO per-memory semantic scores, the
// semantic weight is forced to 0 so it leaves the weighted sum AND its denominator untouched —
// every score, reason, and ordering is identical to the pre-semantic lexical ranker. Only when
// `semanticById` is present does the configured semantic weight participate.
function effectiveWeights(query: RankMemoriesQuery): RankingWeights {
  if (query.semanticById === undefined) {
    return { ...query.weights, semantic: 0 };
  }
  return query.weights;
}

export function rankMemories(
  memories: readonly MemoryRecord[],
  query: RankMemoriesQuery,
  options: RankMemoriesOptions = {},
): readonly IncludedMemory[] {
  if (memories.length === 0) return [];
  const recordById = new Map<MemoryId, MemoryRecord>();
  for (const m of memories) recordById.set(m.id, m);
  const weights = effectiveWeights(query);

  // Pass 1 — baseline.
  const baseline = memories.map((m) => entryFor(m, baselineSubscores(m, query), weights));
  const baselineSorted = sortByRank(baseline, recordById);

  // No edges supplied → skip pass 2 entirely (cost saving + identical result).
  if (options.edgesByMemory === undefined) return baselineSorted;

  // Pass 2 — graph layer.
  const highRankCount = options.graphHighRankCount ?? DEFAULT_GRAPH_HIGH_RANK_COUNT;
  const highRankIds = new Set<string>(
    baselineSorted.slice(0, highRankCount).map((e) => e.memoryId),
  );
  const edges = options.edgesByMemory;
  const layered = memories.map((m) => {
    const base = baselineSubscores(m, query);
    const graph = graphProximityScore(m.id, edges, highRankIds);
    const subscores: IncludedSubscores = { ...base, graph };
    return entryFor(m, subscores, weights);
  });
  return sortByRank(layered, recordById);
}
