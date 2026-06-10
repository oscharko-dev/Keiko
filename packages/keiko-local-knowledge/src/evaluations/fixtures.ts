// Hand-crafted synthetic fixtures for the retrieval evaluation harness
// (Epic #189, Issue #268). Each fixture is a `const` typed by `RetrievalEvalFixture` so a
// caller can iterate them or pick one by id.
//
// Design constraints:
//   - Topic salt: every chunk and matching query carry a topic marker. The scripted
//     embedding adapter routes vectors toward the marked topic so the ground-truth chunk
//     for a query becomes deterministically top-ranked.
//   - Fixture diversity: the set covers direct lookup, capsule-set retrieval, no-evidence,
//     wrong-scope, stale-index, context-budget pressure, structured citations, and
//     multi-page citations without requiring customer data or network access.

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import type { RetrievalEvalFixture } from "./types.js";

export const EVAL_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-eval",
  vectorDimensions: 16,
  vectorMetric: "cosine",
};

export const STALE_QUERY_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-eval-v2",
  vectorDimensions: 24,
  vectorMetric: "cosine",
};

export const EVAL_TOPIC_BOOST = 1.0;

function chunkId(value: string): ChunkId {
  return value as ChunkId;
}
function documentId(value: string): DocumentId {
  return value as DocumentId;
}
function sourceId(value: string): KnowledgeSourceId {
  return value as KnowledgeSourceId;
}
function capsuleId(value: string): KnowledgeCapsuleId {
  return value as KnowledgeCapsuleId;
}

export const singleTopicFixture: RetrievalEvalFixture = {
  id: "single-topic",
  description: "One capsule with three chunks; query targets the two alpha chunks.",
  capsules: [
    {
      id: capsuleId("cap-single"),
      displayName: "Single Topic",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-single"),
          documents: [
            {
              id: documentId("doc-single"),
              safeDisplayName: "single.txt",
              parsedUnits: [
                {
                  id: "page-1",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 200,
                  },
                },
              ],
              chunks: [
                { id: chunkId("c-alpha-1"), text: "alpha chunk one body", topic: "alpha" },
                { id: chunkId("c-alpha-2"), text: "alpha chunk two body", topic: "alpha" },
                { id: chunkId("c-noise"), text: "noise chunk body", topic: "noise" },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-alpha",
      text: "what does alpha say?",
      topic: "alpha",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-single") },
      expectedChunkIds: [chunkId("c-alpha-1"), chunkId("c-alpha-2")],
      topK: 2,
    },
  ],
};

export const multiCapsuleFixture: RetrievalEvalFixture = {
  id: "multi-capsule",
  description: "Two capsules in one set; query pulls one chunk from each.",
  capsules: [
    {
      id: capsuleId("cap-multi-a"),
      displayName: "Multi A",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-multi-a"),
          documents: [
            {
              id: documentId("doc-multi-a"),
              safeDisplayName: "a.txt",
              parsedUnits: [
                {
                  id: "page-a",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [
                { id: chunkId("c-multi-a-shared"), text: "shared body a", topic: "shared" },
                { id: chunkId("c-multi-a-private"), text: "private a", topic: "private-a" },
              ],
            },
          ],
        },
      ],
    },
    {
      id: capsuleId("cap-multi-b"),
      displayName: "Multi B",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-multi-b"),
          documents: [
            {
              id: documentId("doc-multi-b"),
              safeDisplayName: "b.txt",
              parsedUnits: [
                {
                  id: "page-b",
                  unit: {
                    kind: "page",
                    pageNumber: 2,
                    pageLabel: "2",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [
                { id: chunkId("c-multi-b-shared"), text: "shared body b", topic: "shared" },
                { id: chunkId("c-multi-b-private"), text: "private b", topic: "private-b" },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-shared",
      text: "explain the shared topic",
      topic: "shared",
      scope: {
        kind: "capsule-set",
        capsuleSetId: "set-multi",
        capsuleIds: [capsuleId("cap-multi-a"), capsuleId("cap-multi-b")],
      },
      expectedChunkIds: [chunkId("c-multi-a-shared"), chunkId("c-multi-b-shared")],
      topK: 2,
    },
  ],
};

export const noEvidenceFixture: RetrievalEvalFixture = {
  id: "no-evidence",
  description: "Capsule about alpha; query about beta returns no evidence.",
  capsules: [
    {
      id: capsuleId("cap-no-evidence"),
      displayName: "No Evidence",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-no-evidence"),
          documents: [
            {
              id: documentId("doc-no-evidence"),
              safeDisplayName: "alpha-only.txt",
              parsedUnits: [
                {
                  id: "page-1",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [
                { id: chunkId("c-alpha-only-1"), text: "alpha body", topic: "alpha" },
                { id: chunkId("c-alpha-only-2"), text: "alpha body two", topic: "alpha" },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-beta",
      text: "tell me about beta",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-no-evidence") },
      expectedNoEvidence: true,
      expectedNoEvidenceReason: "below-min-score",
    },
  ],
};

export const ambiguousQueryFixture: RetrievalEvalFixture = {
  id: "ambiguous-query",
  description: "Two chunks are equally acceptable; the query expects both in topK=2.",
  capsules: [
    {
      id: capsuleId("cap-ambiguous"),
      displayName: "Ambiguous",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-ambiguous"),
          documents: [
            {
              id: documentId("doc-ambiguous"),
              safeDisplayName: "ambiguous.txt",
              parsedUnits: [
                {
                  id: "page-1",
                  unit: {
                    kind: "page",
                    pageNumber: 3,
                    pageLabel: "3",
                    characterStart: 0,
                    characterEnd: 200,
                  },
                },
              ],
              chunks: [
                { id: chunkId("c-amb-1"), text: "answer one", topic: "delta" },
                { id: chunkId("c-amb-2"), text: "answer two", topic: "delta" },
                { id: chunkId("c-amb-noise"), text: "noise", topic: "noise" },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-ambiguous",
      text: "summarize delta",
      topic: "delta",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-ambiguous") },
      expectedChunkIds: [chunkId("c-amb-1"), chunkId("c-amb-2")],
      topK: 2,
    },
  ],
};

export const sourceIsolationFixture: RetrievalEvalFixture = {
  id: "source-isolation",
  description: "Two capsules share a topic; scope to one capsule must not leak the other.",
  capsules: [
    {
      id: capsuleId("cap-iso-a"),
      displayName: "Isolation A",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-iso-a"),
          documents: [
            {
              id: documentId("doc-iso-a"),
              safeDisplayName: "iso-a.txt",
              parsedUnits: [
                {
                  id: "page-a",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [{ id: chunkId("c-iso-a"), text: "scope body a", topic: "scope" }],
            },
          ],
        },
      ],
    },
    {
      id: capsuleId("cap-iso-b"),
      displayName: "Isolation B",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-iso-b"),
          documents: [
            {
              id: documentId("doc-iso-b"),
              safeDisplayName: "iso-b.txt",
              parsedUnits: [
                {
                  id: "page-b",
                  unit: {
                    kind: "page",
                    pageNumber: 2,
                    pageLabel: "2",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [{ id: chunkId("c-iso-b"), text: "scope body b", topic: "scope" }],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-isolation",
      text: "retrieve the scoped body",
      topic: "scope",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-iso-a") },
      expectedChunkIds: [chunkId("c-iso-a")],
      topK: 1,
    },
  ],
};

export const wrongScopeFixture: RetrievalEvalFixture = {
  id: "wrong-scope",
  description: "Query targets a topic that only exists in an unselected capsule.",
  capsules: [
    {
      id: capsuleId("cap-wrong-a"),
      displayName: "Wrong Scope A",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-wrong-a"),
          documents: [
            {
              id: documentId("doc-wrong-a"),
              safeDisplayName: "a.txt",
              parsedUnits: [
                {
                  id: "page-a",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [{ id: chunkId("c-wrong-a"), text: "alpha only", topic: "alpha" }],
            },
          ],
        },
      ],
    },
    {
      id: capsuleId("cap-wrong-b"),
      displayName: "Wrong Scope B",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-wrong-b"),
          documents: [
            {
              id: documentId("doc-wrong-b"),
              safeDisplayName: "b.txt",
              parsedUnits: [
                {
                  id: "page-b",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [{ id: chunkId("c-wrong-b"), text: "beta only", topic: "beta" }],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-wrong-scope",
      text: "retrieve beta",
      topic: "beta",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-wrong-a") },
      expectedNoEvidence: true,
      expectedNoEvidenceReason: "below-min-score",
    },
  ],
};

export const multiPageFixture: RetrievalEvalFixture = {
  id: "multi-page",
  description: "One document spans two page units; query must cite page two.",
  capsules: [
    {
      id: capsuleId("cap-multi-page"),
      displayName: "Multi Page",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-multi-page"),
          documents: [
            {
              id: documentId("doc-multi-page"),
              safeDisplayName: "manual.txt",
              parsedUnits: [
                {
                  id: "page-1",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
                {
                  id: "page-2",
                  unit: {
                    kind: "page",
                    pageNumber: 2,
                    pageLabel: "2",
                    characterStart: 121,
                    characterEnd: 240,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-page-1"),
                  text: "page one body",
                  topic: "intro",
                  parsedUnitId: "page-1",
                },
                {
                  id: chunkId("c-page-2"),
                  text: "page two body",
                  topic: "closing",
                  parsedUnitId: "page-2",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-page-two",
      text: "what is on the closing page?",
      topic: "closing",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-multi-page") },
      expectedChunkIds: [chunkId("c-page-2")],
      topK: 1,
    },
  ],
};

export const structuredFileFixture: RetrievalEvalFixture = {
  id: "structured-files",
  description: "Structured and semi-structured documents preserve unit-specific citations.",
  capsules: [
    {
      id: capsuleId("cap-structured"),
      displayName: "Structured",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-structured"),
          documents: [
            {
              id: documentId("doc-json"),
              safeDisplayName: "policy.json",
              mediaType: "application/json",
              parserId: "json",
              parsedUnits: [
                {
                  id: "json-root",
                  unit: {
                    kind: "json-path",
                    jsonPointer: "/policy/title",
                    characterStart: 0,
                    characterEnd: 40,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-json"),
                  text: "policy title block",
                  topic: "json-topic",
                  parsedUnitId: "json-root",
                },
              ],
            },
            {
              id: documentId("doc-csv"),
              safeDisplayName: "scores.csv",
              mediaType: "text/csv",
              parserId: "csv",
              parsedUnits: [
                {
                  id: "csv-row-2",
                  unit: {
                    kind: "csv-row",
                    tableName: "scores",
                    rowIndex: 2,
                    characterStart: 0,
                    characterEnd: 30,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-csv"),
                  text: "csv row body",
                  topic: "csv-topic",
                  parsedUnitId: "csv-row-2",
                },
              ],
            },
            {
              id: documentId("doc-html"),
              safeDisplayName: "guide.html",
              mediaType: "text/html",
              parserId: "html",
              parsedUnits: [
                {
                  id: "html-block-1",
                  unit: {
                    kind: "html-block",
                    headingPath: ["Guide", "Overview"],
                    characterStart: 0,
                    characterEnd: 50,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-html"),
                  text: "html body",
                  topic: "html-topic",
                  parsedUnitId: "html-block-1",
                },
              ],
            },
            {
              id: documentId("doc-section"),
              safeDisplayName: "chapter.md",
              parserId: "markdown",
              parsedUnits: [
                {
                  id: "section-1",
                  unit: {
                    kind: "section",
                    sectionPath: ["Chapter 1", "Controls"],
                    characterStart: 0,
                    characterEnd: 60,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-section"),
                  text: "section body",
                  topic: "section-topic",
                  parsedUnitId: "section-1",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-json",
      text: "find the json policy title",
      topic: "json-topic",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-structured") },
      expectedChunkIds: [chunkId("c-json")],
      topK: 1,
    },
    {
      id: "q-csv",
      text: "find the csv row",
      topic: "csv-topic",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-structured") },
      expectedChunkIds: [chunkId("c-csv")],
      topK: 1,
    },
    {
      id: "q-section",
      text: "find the markdown section",
      topic: "section-topic",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-structured") },
      expectedChunkIds: [chunkId("c-section")],
      topK: 1,
    },
  ],
};

export const contextBudgetFixture: RetrievalEvalFixture = {
  id: "context-budget",
  description: "Returned chunks land exactly on the configured context-token budget.",
  capsules: [
    {
      id: capsuleId("cap-budget"),
      displayName: "Context Budget",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-budget"),
          documents: [
            {
              id: documentId("doc-budget"),
              safeDisplayName: "budget.txt",
              parsedUnits: [
                {
                  id: "page-1",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                { id: chunkId("c-budget-1"), text: "budgetchunk1", topic: "budget" },
                { id: chunkId("c-budget-2"), text: "budgetchunk2", topic: "budget" },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-budget",
      text: "return both budget chunks",
      topic: "budget",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-budget") },
      expectedChunkIds: [chunkId("c-budget-1"), chunkId("c-budget-2")],
      topK: 2,
      contextBudgetTokens: "budgetchunk1".length + "budgetchunk2".length,
    },
  ],
};

export const staleIndexFixture: RetrievalEvalFixture = {
  id: "stale-index",
  description: "Vectors were seeded under the pinned identity but the query adapter moved.",
  capsules: [
    {
      id: capsuleId("cap-stale"),
      displayName: "Stale Index",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-stale"),
          documents: [
            {
              id: documentId("doc-stale"),
              safeDisplayName: "stale.txt",
              parsedUnits: [
                {
                  id: "page-1",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 100,
                  },
                },
              ],
              chunks: [{ id: chunkId("c-stale"), text: "stale body", topic: "stale" }],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-stale",
      text: "retrieve stale body",
      topic: "stale",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-stale") },
      expectedNoEvidence: true,
      expectedNoEvidenceReason: "incompatible-embedding-identity",
      queryEmbeddingIdentity: STALE_QUERY_EMBEDDING_IDENTITY,
    },
  ],
};

export const ALL_FIXTURES: readonly RetrievalEvalFixture[] = [
  singleTopicFixture,
  multiCapsuleFixture,
  noEvidenceFixture,
  ambiguousQueryFixture,
  sourceIsolationFixture,
  wrongScopeFixture,
  multiPageFixture,
  structuredFileFixture,
  contextBudgetFixture,
  staleIndexFixture,
] as const;
