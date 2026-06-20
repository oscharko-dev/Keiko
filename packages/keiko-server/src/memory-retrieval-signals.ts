// Shared conversation-retrieval signal builder (#204, O-F4).
//
// Both conversation retrieval surfaces — the desktop chat path (chat-handlers) and the BFF
// /api/memory/context route (memory-conv-handlers) — need the same two model/usage-derived ranking
// signals on top of the pure lexical ranker:
//   - semanticById: per-memory cosine of the query embedding to each candidate's stored vector
//     (embedding-based recall), gated by the secondary-model egress check.
//   - strengthById: per-memory reinforcement strength from the vault's access counters (O-P1).
// Previously only the chat path built them; the BFF route silently ran lexical-only. Centralising
// them here keeps the two surfaces from drifting (the same class of duplication C3 guards for
// suppression) and gives any future consumer of the route the stronger embedding signal by default.
//
// Pure of policy: the caller decides whether the query is egress-safe and passes that in. Graceful:
// no embedding model => semanticById undefined (byte-identical lexical fallback); empty access
// history => strengthById empty (the ranker zeroes its weight).

import type { MemoryId, MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import {
  buildStrengthById,
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  isMemorySuppressed,
  type RankingFusionMode,
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryEmbeddingRow, MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import type { UiHandlerDeps } from "./deps.js";
import { cosineSimilarity, embedMemoryText } from "./memory-embedding.js";

// A candidate is worth scoring iff the ranker could surface it. A superset of the ranked set is
// harmless: ids the ranker filters out simply never read their semantic score.
function isSemanticRetrievalCandidate(record: MemoryRecord, nowMs: number): boolean {
  if (record.status === "superseded") return false;
  return !isMemorySuppressed(record, nowMs, DEFAULT_STALE_CONFIDENCE_THRESHOLD).suppressed;
}

function gatherCandidateIds(
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
  nowMs: number,
  signal?: AbortSignal,
): readonly MemoryId[] {
  const ids: MemoryId[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    throwIfAborted(signal);
    for (const record of vault.listMemoriesByScope(scope, {
      includeExpired: true,
      limit: DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
    })) {
      throwIfAborted(signal);
      if (!isSemanticRetrievalCandidate(record, nowMs)) continue;
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      ids.push(record.id);
    }
  }
  return ids;
}

// Per-memory semantic score map for the candidate set, or undefined when no embedding model is
// configured (query embedding null) — that undefined drives the byte-identical lexical fallback in
// the ranker. A candidate whose stored vector is missing is omitted (semantic subscore 0 for it).
// Query-cosine scores for the candidate set, computed from the already-fetched embeddings. Gated by
// the egress check (it embeds the query). Returns undefined when no model / no query embedding.
async function semanticScoresFrom(
  deps: UiHandlerDeps,
  queryText: string,
  candidateIds: readonly MemoryId[],
  embeddings: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<MemoryId, number> | undefined> {
  throwIfAborted(signal);
  const queryEmbedding = await embedMemoryText(deps, queryText);
  if (queryEmbedding === null) return undefined;
  throwIfAborted(signal);
  const scores = new Map<MemoryId, number>();
  for (const id of candidateIds) {
    throwIfAborted(signal);
    const stored = embeddings.get(id);
    if (stored === undefined) continue;
    scores.set(id, cosineSimilarity(queryEmbedding.vector, stored.vector));
  }
  return scores;
}

// Signal-fusion mode for the conversation retrieval surfaces (#204, O-F2). Opt-in via env to keep
// the release on the byte-identical weighted-sum default; set KEIKO_MEMORY_FUSION=rrf to enable
// rank-based Reciprocal Rank Fusion across both the chat and BFF paths.
export function conversationFusionMode(deps: UiHandlerDeps): RankingFusionMode {
  return deps.env.KEIKO_MEMORY_FUSION === "rrf" ? "rrf" : "weighted-sum";
}

export interface ConversationRetrievalSignals {
  readonly semanticById?: ReadonlyMap<MemoryId, number> | undefined;
  readonly strengthById: ReadonlyMap<MemoryId, number>;
  // Raw candidate vectors for MMR diversity (#204, O-F3). Built from the SAME getEmbeddings call as
  // semanticById (no extra IO, no egress — local vectors), so MMR works even when the query itself is
  // not egress-safe. Empty when the vault has no embeddings.
  readonly embeddingById: ReadonlyMap<MemoryId, Float32Array>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error("memory retrieval aborted");
  }
}

export async function buildConversationRetrievalSignals(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  queryText: string | undefined,
  scopes: readonly MemoryScope[],
  nowMs: number,
  safeForSecondaryModel: boolean,
  signal?: AbortSignal,
): Promise<ConversationRetrievalSignals> {
  throwIfAborted(signal);
  const strengthById = buildStrengthById(vault.getAccessStats(), nowMs);
  throwIfAborted(signal);
  const candidateIds = gatherCandidateIds(vault, scopes, nowMs, signal);
  throwIfAborted(signal);
  const embeddings =
    candidateIds.length > 0
      ? vault.getEmbeddings(candidateIds)
      : new Map<MemoryId, MemoryEmbeddingRow>();
  throwIfAborted(signal);
  const embeddingById = new Map<MemoryId, Float32Array>();
  for (const [id, row] of embeddings) {
    throwIfAborted(signal);
    embeddingById.set(id, row.vector);
  }
  const semanticById =
    safeForSecondaryModel && queryText !== undefined && queryText.length > 0 && embeddings.size > 0
      ? await semanticScoresFrom(deps, queryText, candidateIds, embeddings, signal)
      : undefined;
  return {
    strengthById,
    embeddingById,
    ...(semanticById !== undefined ? { semanticById } : {}),
  };
}
