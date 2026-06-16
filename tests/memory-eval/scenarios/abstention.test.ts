// Abstention (Epic #204 / #215). A memory system must surface NOTHING when nothing relevant is
// stored — phantom inclusion is how stale/irrelevant context leaks into a prompt. LongMemEval names
// abstention an explicit competency; the boolean suite never tested it.
//
// Mutation-robustness:
//   POSITIVE — an off-topic query over the preference pool surfaces zero memories (the relevance
//              floor omits every candidate as below-threshold).
//   CONTROL  — an on-topic query over the SAME pool surfaces at least one memory, proving the empty
//              result is the floor working, not a broken fixture/port that can only ever return [].

import { describe, expect, it } from "vitest";

import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  loadFixture,
  makeRecord,
  spyPortFromRecords,
  userScope,
} from "../_support.js";
import { includedIds } from "../metrics.js";
import type { Scorecard, ScenarioMetric } from "../scorecard.js";

const SCENARIO_NAME = "abstention";
const OFF_TOPIC_QUERY = "quantum chromodynamics seminar";
const ON_TOPIC_QUERY = "dark mode";

function abstentionResult(): {
  passed: boolean;
  evidence: string;
  metrics: readonly ScenarioMetric[];
} {
  const fixture = loadFixture("user-preferences.json")[0];
  if (fixture === undefined) throw new Error("expected user-preferences fixture");
  const records = fixture.memories.map(makeRecord);
  const baseRequest: Omit<MemoryRetrievalRequest, "queryText"> = {
    scopes: [userScope("user-alice")],
    nowMs: FIXED_NOW_MS,
  };

  const offTopic = retrieveMemoryContext(
    { ...baseRequest, queryText: OFF_TOPIC_QUERY },
    spyPortFromRecords(records),
  );
  const onTopic = retrieveMemoryContext(
    { ...baseRequest, queryText: ON_TOPIC_QUERY },
    spyPortFromRecords(records),
  );

  const offCount = includedIds(offTopic).length;
  const onCount = includedIds(onTopic).length;
  const passed = offCount === 0 && onCount > 0;

  return {
    passed,
    evidence: `off-topic included=${String(offCount)} (expected 0), on-topic included=${String(
      onCount,
    )} (expected >0)`,
    // Forgetting-accuracy view: nothing leaked on the off-topic query => abstention accuracy 1.0.
    metrics: [{ name: "abstention-accuracy", value: offCount === 0 ? 1 : 0 }],
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence, metrics } = abstentionResult();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence, metrics);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("surfaces nothing for an off-topic query but something for an on-topic one", () => {
    const { passed, evidence } = abstentionResult();
    expect(passed, evidence).toBe(true);
  });
});
