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
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

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
): readonly MemoryId[] {
  const ids: MemoryId[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const record of vault.listMemoriesByScope(scope, {
      includeExpired: true,
      limit: DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
    })) {
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
async function buildSemanticScores(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  queryText: string,
  candidateIds: readonly MemoryId[],
): Promise<ReadonlyMap<MemoryId, number> | undefined> {
  if (candidateIds.length === 0) return undefined;
  const embeddings = vault.getEmbeddings(candidateIds);
  if (embeddings.size === 0) return undefined;
  const queryEmbedding = await embedMemoryText(deps, queryText);
  if (queryEmbedding === null) return undefined;
  const scores = new Map<MemoryId, number>();
  for (const id of candidateIds) {
    const stored = embeddings.get(id);
    if (stored === undefined) continue;
    scores.set(id, cosineSimilarity(queryEmbedding.vector, stored.vector));
  }
  return scores;
}

export interface ConversationRetrievalSignals {
  readonly semanticById?: ReadonlyMap<MemoryId, number> | undefined;
  readonly strengthById: ReadonlyMap<MemoryId, number>;
}

export async function buildConversationRetrievalSignals(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  queryText: string | undefined,
  scopes: readonly MemoryScope[],
  nowMs: number,
  safeForSecondaryModel: boolean,
): Promise<ConversationRetrievalSignals> {
  const strengthById = buildStrengthById(vault.getAccessStats(), nowMs);
  const semanticById =
    safeForSecondaryModel && queryText !== undefined && queryText.length > 0
      ? await buildSemanticScores(deps, vault, queryText, gatherCandidateIds(vault, scopes, nowMs))
      : undefined;
  return {
    strengthById,
    ...(semanticById !== undefined ? { semanticById } : {}),
  };
}
