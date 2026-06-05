// AC: no-memory mode. When memory is "off" the retrieval call returns an empty context
// block — no included memories, empty text, the request is still echoed back. We model
// "off" as `maxIncluded: 0` (no entries selected) AND `budgetTokens: 0` (no text rendered).
// Both knobs are part of the public request surface so a BFF or workflow port can disable
// memory without ripping out the call site.
//
// Mutation-robustness controls:
//  1. POSITIVE: included.length === 0 AND contextBlock.text === "" AND budget.tokens === 0.
//  2. NEGATIVE/CONTROL: the same fixture with defaults (no overrides) DOES surface
//     memories — proves the empty result is caused by the off knobs, not by an upstream
//     fixture problem.

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

const SCENARIO_NAME = "no-memory-mode";

function runNoMemoryMode(): { passed: boolean; evidence: string } {
  const fixture = loadFixture("user-preferences.json")[0];
  if (fixture === undefined) throw new Error("expected user-preferences fixture");
  const records = fixture.memories.map(makeRecord);
  const port = spyPortFromRecords(records);
  const offRequest: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "vitest",
    nowMs: FIXED_NOW_MS,
    maxIncluded: 0,
    budgetTokens: 0,
  };
  const onRequest: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "vitest",
    nowMs: FIXED_NOW_MS,
  };
  const offResult = retrieveMemoryContext(offRequest, port);
  const onResult = retrieveMemoryContext(onRequest, port);
  const offPass =
    offResult.included.length === 0 &&
    offResult.contextBlock.text === "" &&
    offResult.budget.tokens === 0;
  const controlPass = onResult.included.length > 0;
  return {
    passed: offPass && controlPass,
    evidence: `off.included=${String(offResult.included.length)} off.text="${offResult.contextBlock.text}" on.included=${String(onResult.included.length)}`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runNoMemoryMode();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("off knobs yield empty context block; control with defaults includes memories", () => {
    const { passed, evidence } = runNoMemoryMode();
    expect(passed, evidence).toBe(true);
  });
});
