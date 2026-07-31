// CodSpeed benchmark suite — MemoriaViva retrieval (@oscharko-dev/keiko-memory-retrieval).
//
// Every memory-aware turn (desktop chat, voice, workflow agents) runs this pipeline before the
// prompt is built, over the whole scoped candidate set: lexical relevance + recency decay +
// provenance confidence + graph proximity are fused per candidate, the survivors are re-ordered
// for diversity, and the token budget is filled greedily. It is pure CPU work on the request
// critical path, which makes it the highest-value thing to keep under a regression gate.
//
// The suite is exercised through the package's public barrel only (ADR-0019 trust rule 7): no
// deep import into package-private modules.

import { bench, describe } from "vitest";

import type { MemoryEdge, MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import {
  assembleContextBlock,
  DEFAULT_RANKING_WEIGHTS,
  lexicalRelevance,
  rankMemories,
  reorderByMmr,
  retrieveMemoryContext,
  tokenize,
  type IncludedMemory,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
  type RankMemoriesQuery,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  buildEdgesByMemory,
  buildEmbeddingById,
  buildSemanticById,
  buildStrengthById,
  CORPUS,
  corpusForScope,
  NOW_MS,
  QUERY_TEXT,
  SCOPES,
} from "./fixtures/memory-corpus.js";

const EDGES_BY_MEMORY = buildEdgesByMemory();
const SEMANTIC_BY_ID = buildSemanticById();
const STRENGTH_BY_ID = buildStrengthById();
const EMBEDDING_BY_ID = buildEmbeddingById();

const LEXICAL_QUERY: RankMemoriesQuery = {
  queryText: QUERY_TEXT,
  nowMs: NOW_MS,
  weights: DEFAULT_RANKING_WEIGHTS,
};

const HYBRID_QUERY: RankMemoriesQuery = {
  ...LEXICAL_QUERY,
  semanticById: SEMANTIC_BY_ID,
  strengthById: STRENGTH_BY_ID,
};

const RANKED: readonly IncludedMemory[] = rankMemories(CORPUS, HYBRID_QUERY, {
  edgesByMemory: EDGES_BY_MEMORY,
});

// MMR is quadratic in the candidate count and linear in the embedding width, so it is measured on
// the head of the ranked list — the slice a token budget can realistically draw from.
const MMR_CANDIDATES: readonly IncludedMemory[] = RANKED.slice(0, 60);

// A port backed by the in-memory corpus: the benchmark measures the retrieval layer, not SQLite.
const PORT: MemoryQueryPort = {
  listByScope: (scope) => corpusForScope(scope),
  listEdgesForMemories: (memoryIds) => {
    const edges = new Map<MemoryId, readonly MemoryEdge[]>();
    for (const id of memoryIds) {
      const bucket = EDGES_BY_MEMORY.get(id);
      if (bucket !== undefined) edges.set(id, bucket);
    }
    return edges;
  },
};

const HYBRID_REQUEST: MemoryRetrievalRequest = {
  scopes: SCOPES,
  queryText: QUERY_TEXT,
  nowMs: NOW_MS,
  semanticById: SEMANTIC_BY_ID,
  strengthById: STRENGTH_BY_ID,
  embeddingById: EMBEDDING_BY_ID,
};

const LEXICAL_REQUEST: MemoryRetrievalRequest = {
  scopes: SCOPES,
  queryText: QUERY_TEXT,
  nowMs: NOW_MS,
};

describe("memory ranking", () => {
  bench("rankMemories — 120 candidates, lexical signals only", () => {
    rankMemories(CORPUS, LEXICAL_QUERY);
  });

  bench("rankMemories — 120 candidates, hybrid signals + graph proximity", () => {
    rankMemories(CORPUS, HYBRID_QUERY, { edgesByMemory: EDGES_BY_MEMORY });
  });

  bench("rankMemories — 120 candidates, reciprocal rank fusion", () => {
    rankMemories(CORPUS, { ...HYBRID_QUERY, fusion: "rrf" }, { edgesByMemory: EDGES_BY_MEMORY });
  });
});

describe("lexical relevance", () => {
  bench("tokenize — one long natural-language query", () => {
    tokenize(QUERY_TEXT.repeat(24));
  });

  bench("lexicalRelevance — one query against 120 memory bodies", () => {
    for (const record of CORPUS) {
      lexicalRelevance(QUERY_TEXT, record);
    }
  });
});

describe("selection and assembly", () => {
  bench("reorderByMmr — 60 ranked entries, 32-dimension embeddings", () => {
    reorderByMmr(MMR_CANDIDATES, EMBEDDING_BY_ID);
  });

  bench("assembleContextBlock — 1500-token budget over 120 ranked entries", () => {
    assembleContextBlock(RANKED, CORPUS, { budgetTokens: 1500, maxIncluded: 12 });
  });
});

describe("end-to-end retrieval", () => {
  bench("retrieveMemoryContext — three scopes, lexical only", () => {
    retrieveMemoryContext(LEXICAL_REQUEST, PORT);
  });

  bench("retrieveMemoryContext — three scopes, hybrid signals + MMR diversity", () => {
    retrieveMemoryContext(HYBRID_REQUEST, PORT);
  });
});
