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
import { sealedLocalPodModelUsePolicy } from "@oscharko-dev/keiko-contracts";

import type { RetrievalEvalFixture } from "./types.js";

export const EVAL_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-eval",
  vectorDimensions: 16,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:8d52f5d1eab88fa30d5ff958",
};

export const STALE_QUERY_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-eval-v2",
  vectorDimensions: 24,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:e056895c22c06459763fc521",
};

export const EVAL_ALT_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  ...EVAL_EMBEDDING_IDENTITY,
  modelId: "text-embedding-eval-alt",
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

export const multiSpaceFixture: RetrievalEvalFixture = {
  id: "multi-space",
  description: "Two capsules use distinct embedding model ids; a capsule-set query returns both.",
  capsules: [
    {
      id: capsuleId("cap-space-a"),
      displayName: "Space A",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-space-a"),
          documents: [
            {
              id: documentId("doc-space-a"),
              safeDisplayName: "space-a.md",
              parsedUnits: [
                {
                  id: "section-space-a",
                  unit: {
                    kind: "section",
                    sectionPath: ["Space A"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-space-a"),
                  text: "Space A documents the first governed retrieval lane.",
                  topic: "multi-space",
                  parsedUnitId: "section-space-a",
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: capsuleId("cap-space-b"),
      displayName: "Space B",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_ALT_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-space-b"),
          documents: [
            {
              id: documentId("doc-space-b"),
              safeDisplayName: "space-b.md",
              parsedUnits: [
                {
                  id: "section-space-b",
                  unit: {
                    kind: "section",
                    sectionPath: ["Space B"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-space-b"),
                  text: "Space B documents the second governed retrieval lane.",
                  topic: "multi-space",
                  parsedUnitId: "section-space-b",
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
      id: "q-multi-space",
      text: "Which governed retrieval lanes have evidence?",
      topic: "multi-space",
      scope: {
        kind: "capsule-set",
        capsuleSetId: "set-space",
        capsuleIds: [capsuleId("cap-space-a"), capsuleId("cap-space-b")],
      },
      expectedChunkIds: [chunkId("c-space-a"), chunkId("c-space-b")],
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
              id: documentId("doc-xlsx"),
              safeDisplayName: "controls.xlsx",
              mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              parserId: "xlsx",
              parsedUnits: [
                {
                  id: "xlsx-row-17",
                  unit: {
                    kind: "csv-row",
                    tableName: "Controls",
                    rowIndex: 16,
                    characterStart: 0,
                    characterEnd: 64,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-xlsx"),
                  text: "xlsx control row body",
                  topic: "xlsx-topic",
                  parsedUnitId: "xlsx-row-17",
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
    {
      id: "q-xlsx",
      text: "find the xlsx control row",
      topic: "xlsx-topic",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-structured") },
      expectedChunkIds: [chunkId("c-xlsx")],
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

export const broadQueryDiversityFixture: RetrievalEvalFixture = {
  id: "broad-query-diversity",
  description: "Broad query should prefer supporting evidence across documents over duplicates.",
  capsules: [
    {
      id: capsuleId("cap-diversity"),
      displayName: "Diversity",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-diversity"),
          documents: [
            {
              id: documentId("doc-div-a"),
              safeDisplayName: "controls-a.md",
              parsedUnits: [
                {
                  id: "section-a",
                  unit: {
                    kind: "section",
                    sectionPath: ["Controls"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-div-a1"),
                  text: "controls implementation evidence primary with rollout trace",
                  topic: "diverse",
                },
                {
                  id: chunkId("c-div-a2"),
                  text: "controls duplicate",
                  topic: "diverse",
                },
              ],
            },
            {
              id: documentId("doc-div-b"),
              safeDisplayName: "controls-b.md",
              parsedUnits: [
                {
                  id: "section-b",
                  unit: {
                    kind: "section",
                    sectionPath: ["Risk Monitoring"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-div-b"),
                  text: "risk monitoring rollout evidence",
                  topic: "diverse",
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
      id: "q-diverse",
      text: "Summarize controls implementation risk monitoring rollout evidence",
      topic: "diverse",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-diversity") },
      expectedChunkIds: [chunkId("c-div-a1"), chunkId("c-div-b")],
      topK: 2,
    },
  ],
};

export const exactTechnicalFixture: RetrievalEvalFixture = {
  id: "exact-technical",
  description: "Exact strategy recalls ADR ids, API names, policy clauses, and error codes.",
  capsules: [
    {
      id: capsuleId("cap-exact-technical"),
      displayName: "Exact Technical",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-exact-technical"),
          documents: [
            {
              id: documentId("doc-exact-technical"),
              safeDisplayName: "hybrid-retrieval-notes.md",
              parsedUnits: [
                {
                  id: "section-exact",
                  unit: {
                    kind: "section",
                    sectionPath: ["Hybrid Retrieval", "Diagnostics"],
                    characterStart: 0,
                    characterEnd: 260,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-exact-technical"),
                  text:
                    "ADR-0036 preserves RRF_K=60 for runLocalKnowledgeRetrieval. " +
                    "Policy clause LK-7 maps error E_RETRIEVAL_SCOPE_DENIED to a safe diagnostic.",
                  parsedUnitId: "section-exact",
                },
              ],
            },
            {
              id: documentId("doc-exact-decoy"),
              safeDisplayName: "search-overview.md",
              parsedUnits: [
                {
                  id: "section-decoy",
                  unit: {
                    kind: "section",
                    sectionPath: ["Search", "Overview"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-exact-decoy"),
                  text: "General search guidance discusses ranking quality without exact policy ids.",
                  parsedUnitId: "section-decoy",
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
      id: "q-exact-technical",
      text: "Where are ADR-0036 RRF_K runLocalKnowledgeRetrieval and E_RETRIEVAL_SCOPE_DENIED documented?",
      strategy: "exact",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-exact-technical") },
      expectedChunkIds: [chunkId("c-exact-technical")],
      topK: 1,
    },
  ],
};

export const semanticParaphraseFixture: RetrievalEvalFixture = {
  id: "semantic-paraphrase",
  description: "Broad semantic query retrieves evidence when wording differs from the corpus.",
  capsules: [
    {
      id: capsuleId("cap-semantic-paraphrase"),
      displayName: "Semantic Paraphrase",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-semantic-paraphrase"),
          documents: [
            {
              id: documentId("doc-semantic-paraphrase"),
              safeDisplayName: "review-readiness.md",
              parsedUnits: [
                {
                  id: "section-readiness",
                  unit: {
                    kind: "section",
                    sectionPath: ["Governance", "Review"],
                    characterStart: 0,
                    characterEnd: 200,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-semantic-review"),
                  text: "Release governance requires evidence-backed checklist updates before handoff.",
                  topic: "review-proof",
                  parsedUnitId: "section-readiness",
                },
                {
                  id: chunkId("c-semantic-noise"),
                  text: "The packaging guide lists archive cleanup commands.",
                  topic: "packaging",
                  parsedUnitId: "section-readiness",
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
      id: "q-semantic-review",
      text: "How should a contributor prove a change is ready for review?",
      topic: "review-proof",
      strategy: "broad",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-semantic-paraphrase") },
      expectedChunkIds: [chunkId("c-semantic-review")],
      topK: 1,
    },
  ],
};

export const multilingualFixture: RetrievalEvalFixture = {
  id: "multilingual-retrieval",
  description: "German question retrieves matching English evidence through vector recall.",
  capsules: [
    {
      id: capsuleId("cap-multilingual"),
      displayName: "Multilingual",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-multilingual"),
          documents: [
            {
              id: documentId("doc-multilingual"),
              safeDisplayName: "zahlungsfreigabe.md",
              parsedUnits: [
                {
                  id: "section-zahlung",
                  unit: {
                    kind: "section",
                    sectionPath: ["Kontrollen", "Freigabe"],
                    characterStart: 0,
                    characterEnd: 200,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-multilingual-payment"),
                  text:
                    "Payment approval requires an independent secondary review before " +
                    "monthly close.",
                  topic: "zahlung-freigabe",
                  parsedUnitId: "section-zahlung",
                },
                {
                  id: chunkId("c-multilingual-noise"),
                  text: "Inventory receiving is reconciled weekly by operations.",
                  topic: "inventory",
                  parsedUnitId: "section-zahlung",
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
      id: "q-zahlung",
      text: "Welche Freigabe braucht eine zweite Pruefung?",
      topic: "zahlung-freigabe",
      strategy: "broad",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-multilingual") },
      expectedChunkIds: [chunkId("c-multilingual-payment")],
      topK: 1,
    },
  ],
};

export const mixedStrategyFixture: RetrievalEvalFixture = {
  id: "mixed-strategy",
  description: "Exact, broad, and balanced strategies stay deterministic in one capsule.",
  capsules: [
    {
      id: capsuleId("cap-mixed-strategy"),
      displayName: "Mixed Strategy",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-mixed-strategy"),
          documents: [
            {
              id: documentId("doc-mixed-exact"),
              safeDisplayName: "control-catalog.md",
              parsedUnits: [
                {
                  id: "section-control",
                  unit: {
                    kind: "section",
                    sectionPath: ["Controls", "Catalog"],
                    characterStart: 0,
                    characterEnd: 140,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-mixed-exact"),
                  text: "Control CTRL-44-ALPHA records the exact approval evidence owner.",
                  parsedUnitId: "section-control",
                },
              ],
            },
            {
              id: documentId("doc-mixed-broad-a"),
              safeDisplayName: "access-review.md",
              parsedUnits: [
                {
                  id: "section-access",
                  unit: {
                    kind: "section",
                    sectionPath: ["Access Reviews"],
                    characterStart: 0,
                    characterEnd: 180,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-mixed-broad-a"),
                  text: "Access review rollout evidence covers approver sampling.",
                  topic: "mixed-broad",
                  parsedUnitId: "section-access",
                },
              ],
            },
            {
              id: documentId("doc-mixed-broad-b"),
              safeDisplayName: "risk-monitoring.md",
              parsedUnits: [
                {
                  id: "section-risk",
                  unit: {
                    kind: "section",
                    sectionPath: ["Risk Monitoring"],
                    characterStart: 0,
                    characterEnd: 180,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-mixed-broad-b"),
                  text: "Risk monitoring evidence records rollout exceptions.",
                  topic: "mixed-broad",
                  parsedUnitId: "section-risk",
                },
              ],
            },
            {
              id: documentId("doc-mixed-balanced"),
              safeDisplayName: "handoff-note.md",
              parsedUnits: [
                {
                  id: "section-handoff",
                  unit: {
                    kind: "section",
                    sectionPath: ["Handoff"],
                    characterStart: 0,
                    characterEnd: 160,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-mixed-balanced"),
                  text: "Evidence handoff notes describe local gate outcomes and limitations.",
                  topic: "mixed-balanced",
                  parsedUnitId: "section-handoff",
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
      id: "q-mixed-exact",
      text: "Where is CTRL-44-ALPHA documented?",
      strategy: "exact",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-mixed-strategy") },
      expectedChunkIds: [chunkId("c-mixed-exact")],
      topK: 1,
    },
    {
      id: "q-mixed-broad",
      text: "Summarize access review rollout risk monitoring evidence.",
      topic: "mixed-broad",
      strategy: "broad",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-mixed-strategy") },
      expectedChunkIds: [chunkId("c-mixed-broad-a"), chunkId("c-mixed-broad-b")],
      topK: 2,
    },
    {
      id: "q-mixed-balanced",
      text: "Which note covers evidence handoff outcomes?",
      topic: "mixed-balanced",
      strategy: "balanced",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-mixed-strategy") },
      expectedChunkIds: [chunkId("c-mixed-balanced")],
      topK: 1,
    },
  ],
};

// Governance goldset entry (#2011): a sealed-local pod must refuse the external-embedding
// retrieval lane and surface `policy-denied` no-evidence — a governance outcome, NOT a
// retrieval-quality miss. The query is lexically DISJOINT from the chunk body so no lexical
// candidate survives; the only route to the chunk is the (policy-denied) dense lane. It
// shares the chunk's topic salt, so a *standard* pod WOULD retrieve it — proving the seal,
// not a lexical/semantic gap, produces the outcome (the mutation is proven in the test).
// This makes sealed-pod enforcement (Epic #1819, unit-tested at the policy layer) visible at
// the scorecard layer the way `multi-space` (Epic #1818) already is.
export const sealedPodFixture: RetrievalEvalFixture = {
  id: "sealed-pod",
  description:
    "A sealed-local pod denies external-embedding retrieval; a dense-only query surfaces as " +
    "policy-denied governance behaviour rather than a retrieval-quality miss.",
  capsules: [
    {
      id: capsuleId("cap-sealed"),
      displayName: "Sealed Pod",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      modelUsePolicy: sealedLocalPodModelUsePolicy(),
      sources: [
        {
          id: sourceId("src-sealed"),
          documents: [
            {
              id: documentId("doc-sealed"),
              safeDisplayName: "sealed.md",
              parsedUnits: [
                {
                  id: "section-sealed",
                  unit: {
                    kind: "section",
                    sectionPath: ["Sealed"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-sealed"),
                  text: "Restricted compliance dossier body retained inside the sealed capsule.",
                  topic: "sealed-pod",
                  parsedUnitId: "section-sealed",
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
      id: "q-sealed",
      text: "Which governed lane may expose the embargoed filings?",
      topic: "sealed-pod",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-sealed") },
      expectedNoEvidence: true,
      expectedNoEvidenceReason: "policy-denied",
    },
  ],
};

// Epic #1855 / Issue #1888. Technical HTML manual retrieval over `html-block` units. Each chunk's
// text mirrors what the improved parser (#1886) writes into the normalized projection — a
// header-attached table row, a "Term: definition" pair, an anchored section — so the scorecard
// rewards structure-preserving extraction and regresses if a query can no longer recall its
// structural target. Distinct from `exact-technical` (Markdown sections, no HTML structure),
// `multilingual-retrieval` (Markdown), and `structured-files` (one generic html-block with no
// table/anchor/definition query). All bodies synthetic and body-safe.
//
// SCOPE NOTE (post-merge audit, #1888 finding 3): this fixture is pre-chunked, hand-authored
// text that already looks like the post-#1886 parser output — it does NOT invoke
// `html-parser.ts` or `chunker.ts`. It regresses the retrieval/citation-scoring layer over
// already-correct synthetic text, not the parser/chunker themselves. A parser regression (e.g.
// the old "Column N=value" table flattening, or broken `<dl>` pairing) will NOT be caught here;
// that coverage lives in `html-parser.test.ts` / `chunker.test.ts`. See
// docs/local-knowledge/technical-html-structure-ledger.md for the full disposition.
//
// QUERY AXIS NOTE (#1888 findings 4/5): every query below that carries a `topic` salt is, by
// the harness's own design (see `runner-seed.ts`), guaranteed to recall its target chunk through
// the scripted embedding adapter's dense topic-boost lane — that alone does not make an axis
// "genuine" or distinct from any other fixture that also uses a `topic` salt. All four queries
// below are additionally verified (locally, by temporarily stripping each query's/chunk's
// `topic` field and re-running the harness) to still recall their target chunk on the strength
// of real lexical/token overlap alone — `q-html-error-timeout` and `q-html-def-timeout` via
// their original wording, `q-html-torque` and `q-html-retries` via an `exact`-strategy literal
// phrase shared with the target chunk's text. None of the four is a dense-lane-only duplicate of
// another fixture's query axis (e.g. `multilingual-retrieval`'s cross-language dense recall).
export const htmlManualStructureFixture: RetrievalEvalFixture = {
  id: "html-manual-structure",
  description:
    "Technical HTML manual: table-row identifier, anchored section, definition, and retry-limit " +
    "question recall over html-block units.",
  capsules: [
    {
      id: capsuleId("cap-html-manual"),
      displayName: "HTML Manual Structure",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-html-manual"),
          documents: [
            {
              id: documentId("doc-html-manual"),
              safeDisplayName: "device-handbook.html",
              mediaType: "text/html",
              parserId: "html",
              parsedUnits: [
                {
                  id: "u-html-errors",
                  unit: {
                    kind: "html-block",
                    headingPath: ["Reference", "Error Codes"],
                    anchorId: "error-codes",
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
                {
                  id: "u-html-torque",
                  unit: {
                    kind: "html-block",
                    headingPath: ["Installation", "Mounting", "Torque"],
                    anchorId: "mounting-torque",
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
                {
                  id: "u-html-glossary",
                  unit: {
                    kind: "html-block",
                    headingPath: ["Glossary"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
                {
                  id: "u-html-retries",
                  unit: {
                    kind: "html-block",
                    headingPath: ["Reference", "Retries"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
                {
                  id: "u-html-legal",
                  unit: {
                    kind: "html-block",
                    headingPath: ["Legal", "Warranty"],
                    characterStart: 0,
                    characterEnd: 120,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("c-html-error-timeout"),
                  text:
                    "ErrorCode: E_TIMEOUT | Severity: high | Retryable: yes | " +
                    "Description: the request expired before a response arrived.",
                  topic: "error-timeout",
                  parsedUnitId: "u-html-errors",
                },
                {
                  id: chunkId("c-html-torque"),
                  text: "Tighten each mounting bracket bolt to 12 Nm during installation.",
                  topic: "mounting-torque",
                  parsedUnitId: "u-html-torque",
                },
                {
                  id: chunkId("c-html-def-timeout"),
                  text: "Timeout: the number of seconds the system waits before abandoning a request.",
                  topic: "definition-timeout",
                  parsedUnitId: "u-html-glossary",
                },
                {
                  id: chunkId("c-html-retries"),
                  text:
                    "The controller retries a failed request at most three times before reporting " +
                    "an error.",
                  topic: "retry-limit",
                  parsedUnitId: "u-html-retries",
                },
                {
                  id: chunkId("c-html-warranty-noise"),
                  text: "Warranty terms cover manufacturing defects for twenty-four months.",
                  topic: "warranty",
                  parsedUnitId: "u-html-legal",
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
      id: "q-html-error-timeout",
      text: "What severity and retryable flag does error code E_TIMEOUT carry?",
      topic: "error-timeout",
      strategy: "exact",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-html-manual") },
      expectedChunkIds: [chunkId("c-html-error-timeout")],
      topK: 1,
    },
    {
      // #1888 finding 5: this axis must be genuinely lexically grounded, not just
      // topic-boost-carried — the `exact` strategy plus a literal phrase shared with
      // `c-html-torque`'s text ("mounting bracket bolt ... 12 Nm") is verified (locally, by
      // temporarily stripping the `topic` salt) to still recall the target chunk on its own.
      id: "q-html-torque",
      text: 'What does "tighten each mounting bracket bolt to 12 Nm" mean for installation?',
      topic: "mounting-torque",
      strategy: "exact",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-html-manual") },
      expectedChunkIds: [chunkId("c-html-torque")],
      topK: 1,
    },
    {
      id: "q-html-def-timeout",
      text: "What does the timeout parameter control?",
      topic: "definition-timeout",
      strategy: "broad",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-html-manual") },
      expectedChunkIds: [chunkId("c-html-def-timeout")],
      topK: 1,
    },
    {
      // #1888 finding 4: a German query salted only by `topic` was mechanistically identical
      // to `multilingual-retrieval`'s own query (zero lexical overlap, resolved purely via the
      // scripted adapter's dense topic-boost lane) — that duplicates an existing cross-language
      // regression risk instead of testing anything HTML-structure-specific. Replaced with an
      // `exact`-strategy literal-phrase query against the retries `html-block` unit, verified
      // (locally, by stripping the `topic` salt) to still recall the target chunk on its own —
      // a genuine, non-duplicate axis over the html-block retry-limit sentence.
      id: "q-html-retries",
      text: 'What does "retries a failed request at most three times" mean for the controller?',
      topic: "retry-limit",
      strategy: "exact",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-html-manual") },
      expectedChunkIds: [chunkId("c-html-retries")],
      topK: 1,
    },
  ],
};

export const ALL_FIXTURES: readonly RetrievalEvalFixture[] = [
  singleTopicFixture,
  multiCapsuleFixture,
  multiSpaceFixture,
  noEvidenceFixture,
  ambiguousQueryFixture,
  sourceIsolationFixture,
  wrongScopeFixture,
  multiPageFixture,
  structuredFileFixture,
  contextBudgetFixture,
  staleIndexFixture,
  broadQueryDiversityFixture,
  exactTechnicalFixture,
  semanticParaphraseFixture,
  multilingualFixture,
  mixedStrategyFixture,
  sealedPodFixture,
  htmlManualStructureFixture,
] as const;
