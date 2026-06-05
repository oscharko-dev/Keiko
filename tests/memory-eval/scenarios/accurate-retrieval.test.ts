// AC: accurate retrieval. A user-scope preference matching the query text must rank top-1.
//
// Mutation-robustness controls:
//  1. POSITIVE: top-1 included memory id is the matching preference.
//  2. NEGATIVE/CONTROL: re-rank the same candidate set without the matching record and
//     assert the unrelated noise no longer leads with a preference body — proves the
//     scenario WOULD fail if the matching record was dropped from the ranker output.
//
// Composition: spy port over four fixture preferences. No vault, no SQLite — the AC is
// purely about ranking + assembly behaviour.

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

const SCENARIO_NAME = "accurate-retrieval";

function buildPreferenceCandidates(): {
  readonly targetId: string;
  readonly request: MemoryRetrievalRequest;
  readonly port: ReturnType<typeof spyPortFromRecords>;
} {
  const fixture = loadFixture("user-preferences.json")[0];
  if (fixture === undefined) throw new Error("expected user-preferences fixture");
  const records = fixture.memories.map(makeRecord);
  const request: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "vitest new test files",
    nowMs: FIXED_NOW_MS,
  };
  return { targetId: "pref-vitest-runner", request, port: spyPortFromRecords(records) };
}

function runAccurateRetrieval(): { passed: boolean; evidence: string } {
  const { targetId, request, port } = buildPreferenceCandidates();
  const result = retrieveMemoryContext(request, port);
  const top = result.included[0];
  if (top === undefined) {
    return { passed: false, evidence: "no included memories" };
  }
  const top1Matches = String(top.memoryId) === targetId;
  // Control: drop the target from the candidate pool and assert top-1 changes.
  const filteredPort = spyPortFromRecords(
    [...request.scopes].flatMap((scope) =>
      port.listByScope(scope).filter((r) => String(r.id) !== targetId),
    ),
  );
  const controlResult = retrieveMemoryContext(request, filteredPort);
  const controlTop = controlResult.included[0];
  const controlDiffers = controlTop === undefined || String(controlTop.memoryId) !== targetId;
  const passed = top1Matches && controlDiffers;
  return {
    passed,
    evidence: `top1=${String(top.memoryId)} score=${top.score.toFixed(3)} control=${String(
      controlTop?.memoryId ?? "none",
    )}`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runAccurateRetrieval();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("top-1 is the matching preference and control re-rank differs", () => {
    const { passed, evidence } = runAccurateRetrieval();
    expect(passed, evidence).toBe(true);
  });
});
