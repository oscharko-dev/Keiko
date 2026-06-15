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

import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemorySourceKind,
} from "@oscharko-dev/keiko-contracts/memory";

import { graphProximityScore } from "./graph.js";
import { recencyScore } from "./recency.js";
import { lexicalRelevance } from "./relevance.js";
import type {
  IncludedMemory,
  IncludedSubscores,
  RankingFusionMode,
  RankingWeights,
} from "./types.js";

export interface RankMemoriesQuery {
  readonly queryText?: string;
  readonly nowMs: number;
  readonly weights: RankingWeights;
  // Per-memory cosine similarity in [0,1] keyed by memory id (#204). When undefined, the ranker
  // zeroes the semantic weight so output is byte-identical to pre-semantic lexical behaviour.
  readonly semanticById?: ReadonlyMap<MemoryId, number> | undefined;
  // Per-memory reinforcement strength in [0,1] keyed by memory id (#204 plasticity). When undefined,
  // the ranker zeroes the strength weight so output is byte-identical to pre-strength behaviour.
  readonly strengthById?: ReadonlyMap<MemoryId, number> | undefined;
  // Signal-fusion strategy (#204, O-F2). Defaults to weighted-sum (byte-identical); "rrf" fuses ranks.
  readonly fusion?: RankingFusionMode | undefined;
}

export interface RankMemoriesOptions {
  readonly edgesByMemory?: ReadonlyMap<MemoryId, readonly MemoryEdge[]>;
  /** How many top baseline entries become the high-rank set for graph proximity. */
  readonly graphHighRankCount?: number;
}

const DEFAULT_GRAPH_HIGH_RANK_COUNT = 8;

// Frozen source-authority importance (#204, O-F5). A deterministic function of the immutable capture
// provenance: a fact the user stated outright outranks one passively inferred by the system, at equal
// relevance. Reproducible and caller-input-free.
const SOURCE_IMPORTANCE: Readonly<Record<MemorySourceKind, number>> = {
  "explicit-user-instruction": 1,
  "accepted-correction": 0.85,
  "workflow-outcome": 0.6,
  consolidation: 0.5,
  "system-default": 0.4,
};

export function sourceImportance(record: MemoryRecord): number {
  // SOURCE_IMPORTANCE is total over MemorySourceKind, so a new source kind in contracts surfaces here
  // as a compile error rather than silently defaulting.
  return SOURCE_IMPORTANCE[record.provenance.sourceKind];
}

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
    strength: query.strengthById?.get(record.id) ?? 0,
    importance: sourceImportance(record),
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
    s.semantic * w.semantic +
    s.strength * w.strength +
    s.importance * w.importance;
  const totalWeight =
    w.relevance +
    w.recency +
    w.confidence +
    w.pinned +
    w.correction +
    w.graph +
    w.semantic +
    w.strength +
    w.importance;
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
    // Reinforcement sits just below semantic: a heavily-reused memory wins a tie against the lexical
    // signals but not against an explicit pin, a fresh correction, or a strong embedding match.
    { key: "strength", value: s.strength * w.strength },
    { key: "relevance", value: s.relevance * w.relevance },
    { key: "recency", value: s.recency * w.recency },
    { key: "confidence", value: s.confidence * w.confidence },
    { key: "importance", value: s.importance * w.importance },
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
    strength: "frequently recalled (reinforced)",
    importance: "authoritative source",
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
  // Each optional signal zeroes its own weight when the caller supplied no scores for it, so the
  // weighted sum AND its denominator are untouched and the output is byte-identical to the behaviour
  // before that signal existed. The two conditions are independent.
  let weights = query.weights;
  if (query.semanticById === undefined) {
    weights = { ...weights, semantic: 0 };
  }
  if (query.strengthById === undefined) {
    weights = { ...weights, strength: 0 };
  }
  return weights;
}

// Reciprocal Rank Fusion constant (Cormack et al. 2009). 60 is the field-standard k; larger flattens
// the rank advantage, smaller sharpens it.
export const RRF_K = 60;

const SUBSCORE_KEYS: readonly (keyof IncludedSubscores)[] = [
  "relevance",
  "recency",
  "confidence",
  "pinned",
  "correction",
  "graph",
  "semantic",
  "strength",
  "importance",
];

// Final subscores per memory: baseline + (when edges are supplied) the graph layer. The graph
// high-rank set is the WEIGHTED-SUM baseline top-N, so graph proximity is computed identically
// regardless of the final fusion mode (and the weighted-sum path stays byte-identical to before).
function computeFinalSubscores(
  memories: readonly MemoryRecord[],
  query: RankMemoriesQuery,
  weights: RankingWeights,
  options: RankMemoriesOptions,
  recordById: ReadonlyMap<MemoryId, MemoryRecord>,
): Map<MemoryId, IncludedSubscores> {
  const map = new Map<MemoryId, IncludedSubscores>();
  for (const m of memories) map.set(m.id, baselineSubscores(m, query));
  if (options.edgesByMemory === undefined) return map;
  const baselineSorted = sortByRank(
    memories.map((m) => entryFor(m, map.get(m.id)!, weights)),
    recordById,
  );
  const highRankCount = options.graphHighRankCount ?? DEFAULT_GRAPH_HIGH_RANK_COUNT;
  const highRankIds = new Set<string>(
    baselineSorted.slice(0, highRankCount).map((e) => e.memoryId),
  );
  const edges = options.edgesByMemory;
  for (const m of memories) {
    const base = map.get(m.id)!;
    map.set(m.id, { ...base, graph: graphProximityScore(m.id, edges, highRankIds) });
  }
  return map;
}

// Reciprocal Rank Fusion (#204, O-F2): for each positive-weight signal, rank the memories by that
// subscore (desc, id tiebreak) and fuse score = Σ w/(RRF_K + rank). Rank-based, so heterogeneous
// score scales (Jaccard ~[0,0.3] vs cosine [0,1]) need no normalization, and agreement across signals
// compounds. The fused value is normalized to [0,1] (best possible = rank 1 in every signal) to
// honour the documented score range; ordering uses the shared (score desc, updatedAt desc, id asc) sort.
function rrfRank(
  memories: readonly MemoryRecord[],
  subscoresById: ReadonlyMap<MemoryId, IncludedSubscores>,
  weights: RankingWeights,
  recordById: ReadonlyMap<MemoryId, MemoryRecord>,
): readonly IncludedMemory[] {
  const signals = SUBSCORE_KEYS.filter((k) => weights[k] > 0);
  if (signals.length === 0) {
    return sortByRank(
      memories.map((m) => entryFor(m, subscoresById.get(m.id)!, weights)),
      recordById,
    );
  }
  const rankBySignal = new Map<keyof IncludedSubscores, ReadonlyMap<MemoryId, number>>();
  for (const sig of signals) {
    const ordered = [...memories].sort((a, b) => {
      const av = (subscoresById.get(a.id)!)[sig];
      const bv = (subscoresById.get(b.id)!)[sig];
      if (av !== bv) return bv - av;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const ranks = new Map<MemoryId, number>();
    ordered.forEach((m, i) => ranks.set(m.id, i + 1));
    rankBySignal.set(sig, ranks);
  }
  const maxFused = signals.reduce((sum, sig) => sum + weights[sig] / (RRF_K + 1), 0);
  const firstSignal = signals[0]!;
  const entries = memories.map((m): IncludedMemory => {
    let fused = 0;
    let bestSig = firstSignal;
    let bestContrib = -1;
    for (const sig of signals) {
      const rank = (rankBySignal.get(sig)!).get(m.id)!;
      const contrib = weights[sig] / (RRF_K + rank);
      fused += contrib;
      if (contrib > bestContrib) {
        bestContrib = contrib;
        bestSig = sig;
      }
    }
    return {
      memoryId: m.id,
      score: maxFused > 0 ? fused / maxFused : 0,
      subscores: subscoresById.get(m.id)!,
      inclusionReason: inclusionReasonText(bestSig, bestContrib),
    };
  });
  return sortByRank(entries, recordById);
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
  const subscoresById = computeFinalSubscores(memories, query, weights, options, recordById);
  if (query.fusion === "rrf") {
    return rrfRank(memories, subscoresById, weights, recordById);
  }
  return sortByRank(
    memories.map((m) => entryFor(m, subscoresById.get(m.id)!, weights)),
    recordById,
  );
}
