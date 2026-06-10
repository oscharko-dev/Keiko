// AC: cross-scope isolation. A retrieval call requesting scope A must surface only A's
// memories — never B's — and must call port.listByScope only with scope A.
//
// Mutation-robustness controls:
//  1. POSITIVE: result.included contains alice's memory id and NOT bob's.
//  2. NEGATIVE/CONTROL: the spy port records ONLY the requested scope; if the orchestrator
//     ever introduced a "list all" path the spy would record both, and this assertion
//     would fail. The control proves the isolation guarantee is structural, not coincidental.

import { describe, expect, it } from "vitest";

import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  loadFixture,
  makeRecord,
  sameScope,
  spyPortFromRecords,
  userScope,
} from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "cross-scope-isolation";

function runCrossScopeIsolation(): { passed: boolean; evidence: string } {
  const fixture = loadFixture("cross-scope-collision.json")[0];
  if (fixture === undefined) throw new Error("expected cross-scope-collision fixture");
  const records = fixture.memories.map(makeRecord);
  const port = spyPortFromRecords(records);
  const request: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "favourite editor terminal",
    nowMs: FIXED_NOW_MS,
  };
  const result = retrieveMemoryContext(request, port);
  const includedIds = result.included.map((m) => String(m.memoryId));
  const positivePass =
    includedIds.includes("alice-favourite-editor") && !includedIds.includes("bob-favourite-editor");
  // Spy assertion: every call was for user-alice; never user-bob.
  const onlyAlice = port.calledScopes.every((s) => sameScope(s, userScope("user-alice")));
  const noBobCall = !port.calledScopes.some((s) => sameScope(s, userScope("user-bob")));
  const controlPass = onlyAlice && noBobCall && port.calledScopes.length === 1;
  return {
    passed: positivePass && controlPass,
    evidence: `included=[${includedIds.join(",")}] calledScopes=${String(port.calledScopes.length)}`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runCrossScopeIsolation();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("only alice's memory surfaces and spy port saw only alice's scope", () => {
    const { passed, evidence } = runCrossScopeIsolation();
    expect(passed, evidence).toBe(true);
  });
});
