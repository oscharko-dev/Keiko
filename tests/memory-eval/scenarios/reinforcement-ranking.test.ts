// Reinforcement ranking (Epic #204 plasticity / O-P1). End-to-end proof that reuse changes what is
// surfaced: two equally-relevant memories are retrieved, and supplying a per-memory reinforcement
// strength for one of them lifts it to rank 1 — the online realisation of "a memory gets stronger
// when reused" (ACT-R base-level activation).
//
// Mutation-robustness:
//   POSITIVE — with a strength score on the reused record, it ranks first.
//   CONTROL  — with NO strength scores the two are equal and fall back to the id tiebreak (the other
//              record wins), proving the re-ordering is the reinforcement signal, not fixture chance.

import { describe, expect, it } from "vitest";

import {
  buildStrengthById,
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import { FIXED_NOW_MS, makeRecord, memoryId, spyPortFromRecords, userScope } from "../_support.js";
import { includedIds } from "../metrics.js";
import type { Scorecard, ScenarioMetric } from "../scorecard.js";

const SCENARIO_NAME = "reinforcement-ranking";
const REUSED_ID = "reused-fact";
const FRESH_ID = "fresh-fact-rr";

function reinforcementResult(): {
  passed: boolean;
  evidence: string;
  metrics: readonly ScenarioMetric[];
} {
  // Two records with identical bodies => identical relevance/recency/confidence, so ranking is a
  // pure tie until reinforcement breaks it.
  const records = [REUSED_ID, FRESH_ID].map((id) =>
    makeRecord({
      id,
      scope: { kind: "user", userId: "user-alice" },
      type: "semantic-fact",
      body: "the deploy pipeline runs nightly from main",
      confidence: 0.8,
    }),
  );
  const base: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "deploy pipeline",
    nowMs: FIXED_NOW_MS,
  };

  // Reuse history for exactly one record, projected through the canonical strength formula.
  const strengthById = buildStrengthById(
    new Map([[memoryId(REUSED_ID), { accessCount: 20, lastAccessedAt: FIXED_NOW_MS }]]),
    FIXED_NOW_MS,
  );

  const reinforced = retrieveMemoryContext({ ...base, strengthById }, spyPortFromRecords(records));
  const control = retrieveMemoryContext(base, spyPortFromRecords(records));

  const reinforcedTop = includedIds(reinforced)[0];
  const controlTop = includedIds(control)[0];
  const reusedRanksFirst = reinforcedTop === REUSED_ID;
  // Without reinforcement the id tiebreak (fresh-fact-rr < reused-fact) wins.
  const controlDiffers = controlTop === FRESH_ID;
  const passed = reusedRanksFirst && controlDiffers;

  return {
    passed,
    evidence: `reinforced-top=${String(reinforcedTop)} (expected ${REUSED_ID}), control-top=${String(
      controlTop,
    )} (expected ${FRESH_ID})`,
    metrics: [{ name: "reused-ranks-first", value: reusedRanksFirst ? 1 : 0 }],
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence, metrics } = reinforcementResult();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence, metrics);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("lifts a reused memory to rank 1 while the control falls back to the id tiebreak", () => {
    const { passed, evidence } = reinforcementResult();
    expect(passed, evidence).toBe(true);
  });
});
