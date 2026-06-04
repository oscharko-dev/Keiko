// Hand-crafted synthetic fixtures for the retrieval evaluation harness
// (Epic #189, Issue #268). Each fixture is a `const` typed by `RetrievalEvalFixture` so a
// caller can iterate them or pick one by id.
//
// Design constraints:
//   - Topic salt: every chunk and matching query carry a topic marker. The scripted
//     embedding adapter (see `scripted-embedding-adapter.ts`) routes vectors toward the
//     marked topic so the ground-truth chunk for a query becomes deterministically the
//     top result — without depending on accidental hash collisions.
//   - Page-unit citations only: every fixture uses `kind: "page"` parsed units. That is
//     the simplest path that lets `scoreCitationQuality` assert presence of `pageNumber`.
//     Other unit kinds are exercised in the dimension tests.
//   - Five fixtures cover the five behaviours called out in the spec:
//       1. single-topic / ground-truth recall + precision
//       2. multi-capsule / cross-capsule retrieval
//       3. no-evidence / off-topic query
//       4. ambiguous-query / multiple acceptable ground truths
//       5. source-isolation / scope-bound retrieval

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import type { RetrievalEvalFixture } from "./types.js";

// ─── Shared identity ─────────────────────────────────────────────────────────
// Small vector dim so cosine math is fast and reproducible. The retrieval runner does
// NOT care about the dim value as long as the capsule's pinned identity matches what the
// adapter emits — which the runner guarantees by passing this same identity into the
// scripted adapter.
export const EVAL_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-eval",
  vectorDimensions: 16,
  vectorMetric: "cosine",
};

// Topic boost is 1.0 for fixtures: a query carrying topic X must dominate any other
// topic's chunks. A lower boost would let unrelated chunks creep above the top-K
// threshold and break the recall=1.0 / precision=1.0 acceptance criteria.
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

// ─── Fixture 1: single-topic ─────────────────────────────────────────────────
// One capsule, one source, one document, three chunks. Two chunks share topic "alpha";
// the third is topic "noise". Query asks about "alpha" — the two alpha chunks must come
// back, the noise chunk must not.
export const singleTopicFixture: RetrievalEvalFixture = {
  id: "single-topic",
  description: "One capsule with three chunks; query targets the two 'alpha' chunks.",
  capsules: [
    {
      id: capsuleId("cap-single"),
      displayName: "Single Topic",
      // best-effort so the grounding policy never converts our results into an
      // "answer-grounding-rejected" before scoring sees the references.
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-single"),
          documents: [
            {
              id: documentId("doc-single"),
              safeDisplayName: "single.txt",
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 1,
                  pageLabel: "1",
                  characterStart: 0,
                  characterEnd: 200,
                },
              },
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

// ─── Fixture 2: multi-capsule ────────────────────────────────────────────────
// Two capsules in one set. Each capsule has one "shared" chunk topic and one private one.
// Query asks about the shared topic — both capsules' shared chunks must come back.
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
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 1,
                  pageLabel: "1",
                  characterStart: 0,
                  characterEnd: 100,
                },
              },
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
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 2,
                  pageLabel: "2",
                  characterStart: 0,
                  characterEnd: 100,
                },
              },
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

// ─── Fixture 3: no-evidence ──────────────────────────────────────────────────
// One capsule about "alpha". Query asks about "beta" with a `minScore` floor that the
// alpha chunks fail to clear — so the retrieval correctly returns empty refs and
// `noEvidence: true`.
//
// We rely on the fact that an unmarked query (no topic) hashes to a vector orthogonal to
// the alpha-topic vectors (cosine ≈ 0), and the alpha capsule's `best-effort` policy
// lets the empty-result flow through unmangled.
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
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 1,
                  pageLabel: "1",
                  characterStart: 0,
                  characterEnd: 100,
                },
              },
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
      // Query has no topic marker, so the scripted adapter emits a body-only vector that
      // has near-zero cosine with the alpha-boosted chunk vectors. The `minScore: 0.99`
      // floor then drops every candidate ⇒ retrieval returns empty refs.
      scope: { kind: "capsule", capsuleId: capsuleId("cap-no-evidence") },
      expectedNoEvidence: true,
    },
  ],
};

// ─── Fixture 4: ambiguous query ──────────────────────────────────────────────
// Two equally acceptable chunks for one query. Recall is `1.0` if EITHER is returned in
// top-K=1, but the runner always evaluates against the full `expectedChunkIds`. We pick
// `topK: 2` so both ambiguous chunks come back — recall stays 1.0 and precision stays
// 1.0 (both returned chunks are expected).
export const ambiguousQueryFixture: RetrievalEvalFixture = {
  id: "ambiguous-query",
  description: "Two chunks share the query topic; both are acceptable ground truths.",
  capsules: [
    {
      id: capsuleId("cap-ambig"),
      displayName: "Ambiguous",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-ambig"),
          documents: [
            {
              id: documentId("doc-ambig"),
              safeDisplayName: "ambig.txt",
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 1,
                  pageLabel: "1",
                  characterStart: 0,
                  characterEnd: 100,
                },
              },
              chunks: [
                { id: chunkId("c-ambig-1"), text: "ambig body one", topic: "ambig" },
                { id: chunkId("c-ambig-2"), text: "ambig body two", topic: "ambig" },
                { id: chunkId("c-ambig-noise"), text: "noise", topic: "ambig-noise" },
              ],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-ambig",
      text: "ambiguous query",
      topic: "ambig",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-ambig") },
      expectedChunkIds: [chunkId("c-ambig-1"), chunkId("c-ambig-2")],
      topK: 2,
    },
  ],
};

// ─── Fixture 5: source isolation ─────────────────────────────────────────────
// Two capsules, A and B. Both have chunks marked topic "iso". Query is scoped to A only;
// the scope contract MUST keep B's chunks out of the result even though B has equally
// well-matching vectors.
export const sourceIsolationFixture: RetrievalEvalFixture = {
  id: "source-isolation",
  description: "Two capsules with identical topic; query scoped to A must not leak B.",
  capsules: [
    {
      id: capsuleId("cap-iso-a"),
      displayName: "Iso A",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-iso-a"),
          documents: [
            {
              id: documentId("doc-iso-a"),
              safeDisplayName: "a.txt",
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 1,
                  pageLabel: "1",
                  characterStart: 0,
                  characterEnd: 100,
                },
              },
              chunks: [{ id: chunkId("c-iso-a-1"), text: "iso body a", topic: "iso" }],
            },
          ],
        },
      ],
    },
    {
      id: capsuleId("cap-iso-b"),
      displayName: "Iso B",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-iso-b"),
          documents: [
            {
              id: documentId("doc-iso-b"),
              safeDisplayName: "b.txt",
              parsedUnit: {
                unit: {
                  kind: "page",
                  pageNumber: 2,
                  pageLabel: "2",
                  characterStart: 0,
                  characterEnd: 100,
                },
              },
              chunks: [{ id: chunkId("c-iso-b-1"), text: "iso body b", topic: "iso" }],
            },
          ],
        },
      ],
    },
  ],
  queries: [
    {
      id: "q-iso-a-only",
      text: "iso query restricted to A",
      topic: "iso",
      // Single-capsule scope: B is loaded into the store but never reachable through
      // this query.
      scope: { kind: "capsule", capsuleId: capsuleId("cap-iso-a") },
      expectedChunkIds: [chunkId("c-iso-a-1")],
      topK: 5,
    },
  ],
};

export const ALL_FIXTURES: readonly RetrievalEvalFixture[] = [
  singleTopicFixture,
  multiCapsuleFixture,
  noEvidenceFixture,
  ambiguousQueryFixture,
  sourceIsolationFixture,
];
