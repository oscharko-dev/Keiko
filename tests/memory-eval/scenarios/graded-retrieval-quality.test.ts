// Graded retrieval quality (Epic #204 / #215). Upgrades "accurate-retrieval" from a top-1 boolean
// to graded recall@k / precision@k over a populated pool, and additionally exercises three signals
// the boolean suite never touched: recency (one relevant record is 30 days older), the pinned
// signal (the dominant default weight), and the embedding-semantic path (a record with zero lexical
// overlap is surfaced ONLY when a semantic score is supplied).
//
// Mutation-robustness:
//   POSITIVE — recall@5 over the three relevant records is perfect and the pinned record surfaces.
//   CONTROL  — the off-topic noise records are omitted (precision stays 1.0), and the semantic-only
//              record is ABSENT without a semantic score yet PRESENT with one (proves the semantic
//              subscore, not lexical overlap, surfaced it).

import { describe, expect, it } from "vitest";

import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  loadFixture,
  makeRecord,
  memoryId,
  spyPortFromRecords,
  userScope,
} from "../_support.js";
import { includedIds, precisionAtK, recallAtK } from "../metrics.js";
import type { Scorecard, ScenarioMetric } from "../scorecard.js";

const SCENARIO_NAME = "graded-retrieval-quality";
const QUERY = "vitest test runner configuration";
const RELEVANT_IDS = ["grq-vitest-config", "grq-runner-ci", "grq-pinned-setup"] as const;
const PINNED_ID = "grq-pinned-setup";
const SEMANTIC_ONLY_ID = "grq-semantic-only";

function gradedResult(): { passed: boolean; evidence: string; metrics: readonly ScenarioMetric[] } {
  const fixture = loadFixture("graded-relevance.json")[0];
  if (fixture === undefined) throw new Error("expected graded-relevance fixture");
  const records = fixture.memories.map(makeRecord);
  const baseRequest: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: QUERY,
    nowMs: FIXED_NOW_MS,
  };

  // Lexical run — no semantic scores supplied.
  const lexical = retrieveMemoryContext(baseRequest, spyPortFromRecords(records));
  const lexicalIds = includedIds(lexical);
  const recall = recallAtK(lexicalIds, [...RELEVANT_IDS], 5);
  const precision = precisionAtK(lexicalIds, [...RELEVANT_IDS], 5);
  const pinnedIncluded = lexicalIds.includes(PINNED_ID);
  const semanticAbsentWithoutScore = !lexicalIds.includes(SEMANTIC_ONLY_ID);

  // Semantic run — supply a high cosine score for the lexically-invisible record only.
  const semanticById = new Map([[memoryId(SEMANTIC_ONLY_ID), 0.9]]);
  const semantic = retrieveMemoryContext(
    { ...baseRequest, semanticById },
    spyPortFromRecords(records),
  );
  const semanticPresentWithScore = includedIds(semantic).includes(SEMANTIC_ONLY_ID);

  const passed =
    recall === 1 &&
    precision === 1 &&
    pinnedIncluded &&
    semanticAbsentWithoutScore &&
    semanticPresentWithScore;

  return {
    passed,
    evidence: `recall@5=${recall.toFixed(3)} precision@5=${precision.toFixed(
      3,
    )} pinned=${String(pinnedIncluded)} semantic(off→on)=${String(
      semanticAbsentWithoutScore,
    )}→${String(semanticPresentWithScore)}`,
    metrics: [
      { name: "recall@5", value: recall },
      { name: "precision@5", value: precision },
    ],
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence, metrics } = gradedResult();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence, metrics);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("achieves perfect recall@5 / precision@5, surfaces the pinned record, and uses the semantic path", () => {
    const { passed, evidence } = gradedResult();
    expect(passed, evidence).toBe(true);
  });
});
