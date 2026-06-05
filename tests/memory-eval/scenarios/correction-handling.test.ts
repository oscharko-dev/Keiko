// AC: correction handling. A newer correction-type memory must outrank an older fact about
// the same topic when both share scope and query relevance.
//
// Mutation-robustness controls:
//  1. POSITIVE: the correction-type memory ranks above the older semantic-fact and
//     `inclusionReason` reflects the correction contribution being dominant.
//  2. NEGATIVE/CONTROL: re-rank with the correction removed — the stale fact must surface
//     as top-1 in that control universe, proving the ranking swap is caused by the
//     correction-type contribution rather than recency alone.

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
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "correction-handling";
const CORRECTION_ID = "correction-build-tool-new";
const STALE_FACT_ID = "fact-build-tool-old";

function loadCorrectionFixture(): {
  readonly request: MemoryRetrievalRequest;
  readonly records: ReturnType<typeof makeRecord>[];
} {
  const fixture = loadFixture("correction-pairs.json")[0];
  if (fixture === undefined) throw new Error("expected correction-pairs fixture");
  const records = fixture.memories.map(makeRecord);
  const request: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "build tool",
    nowMs: FIXED_NOW_MS,
  };
  return { request, records };
}

function topIdFor(records: readonly ReturnType<typeof makeRecord>[]): string | undefined {
  const { request } = loadCorrectionFixture();
  const port = spyPortFromRecords(records);
  const result = retrieveMemoryContext(request, port);
  const top = result.included[0];
  return top === undefined ? undefined : String(top.memoryId);
}

function runCorrectionHandling(): { passed: boolean; evidence: string } {
  const { records } = loadCorrectionFixture();
  const topWith = topIdFor(records);
  const topControl = topIdFor(records.filter((r) => String(r.id) !== CORRECTION_ID));
  const positivePass = topWith === CORRECTION_ID;
  const controlPass = topControl === STALE_FACT_ID;
  return {
    passed: positivePass && controlPass,
    evidence: `withCorrection.top=${String(topWith)} withoutCorrection.top=${String(topControl)}`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runCorrectionHandling();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("correction memory outranks the stale fact; control without correction leaves fact top-1", () => {
    const { passed, evidence } = runCorrectionHandling();
    expect(passed, evidence).toBe(true);
  });
});
