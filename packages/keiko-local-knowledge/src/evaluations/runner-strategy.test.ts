// Scope: this file pins ONLY the eval-runner forwarding contract — that a `RetrievalEvalQuery`'s
// `strategy`/`topK` overrides reach `runLocalKnowledgeRetrieval` unchanged. It mocks the retrieval
// module, so it deliberately does NOT prove that the strategies produce different budgets or
// rankings; that behavioural proof lives in `../retrieval/scoped-vector-search.test.ts`
// (per-strategy budget diagnostics, auto-classification, and RRF fusion tests).

import { describe, expect, it, vi } from "vitest";

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { EVAL_EMBEDDING_IDENTITY } from "./fixtures.js";
import type { RetrievalQuery } from "../retrieval/types.js";
import type { RetrievalEvalFixture } from "./types.js";

const observedQueries: RetrievalQuery[] = [];

function capsuleId(value: string): KnowledgeCapsuleId {
  return value as KnowledgeCapsuleId;
}

function sourceId(value: string): KnowledgeSourceId {
  return value as KnowledgeSourceId;
}

function documentId(value: string): DocumentId {
  return value as DocumentId;
}

function chunkId(value: string): ChunkId {
  return value as ChunkId;
}

vi.mock("../retrieval/index.js", () => ({
  runLocalKnowledgeRetrieval: (
    _deps: unknown,
    query: RetrievalQuery,
  ): {
    readonly references: readonly [];
    readonly noEvidence: true;
    readonly reason: "no-evidence-stated";
  } => {
    observedQueries.push(query);
    return { references: [], noEvidence: true, reason: "no-evidence-stated" };
  },
}));

const fixture: RetrievalEvalFixture = {
  id: "strategy-forwarding",
  description: "Pins eval query strategy forwarding.",
  capsules: [
    {
      id: capsuleId("cap-strategy-forwarding"),
      displayName: "Strategy Forwarding",
      answerGroundingPolicy: "best-effort",
      embeddingModelIdentity: EVAL_EMBEDDING_IDENTITY,
      sources: [
        {
          id: sourceId("src-strategy-forwarding"),
          documents: [
            {
              id: documentId("doc-strategy-forwarding"),
              safeDisplayName: "strategy.txt",
              parsedUnits: [
                {
                  id: "page-strategy",
                  unit: {
                    kind: "page",
                    pageNumber: 1,
                    pageLabel: "1",
                    characterStart: 0,
                    characterEnd: 80,
                  },
                },
              ],
              chunks: [
                {
                  id: chunkId("chunk-strategy-forwarding"),
                  text: "strategy forwarding evidence",
                  parsedUnitId: "page-strategy",
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
      id: "q-strategy",
      text: "Summarize broad-looking text while forcing exact mode.",
      strategy: "exact",
      scope: { kind: "capsule", capsuleId: capsuleId("cap-strategy-forwarding") },
      expectedNoEvidence: true,
      expectedNoEvidenceReason: "no-evidence-stated",
      topK: 3,
    },
  ],
};

describe("runRetrievalEval — strategy forwarding", () => {
  it("passes per-query strategy overrides to Local Knowledge retrieval", async () => {
    observedQueries.length = 0;
    const { runRetrievalEval } = await import("./runner.js");

    const scorecard = await runRetrievalEval(fixture);

    expect(scorecard.dimensions.noEvidenceAccuracy).toBe(1);
    expect(observedQueries).toHaveLength(1);
    expect(observedQueries[0]).toMatchObject({ strategy: "exact", topK: 3 });
  });
});
