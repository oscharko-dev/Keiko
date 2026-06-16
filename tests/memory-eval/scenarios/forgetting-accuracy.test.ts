// Forgetting accuracy / FAMA (Epic #204 / #215). Plain recall@k rewards a system for surfacing the
// right fact even if it ALSO surfaces a stale one; FAMA penalises the leak. This is the metric every
// decay / supersession / suppression change must be held against, so a regression that starts
// leaking invalidated facts is caught quantitatively rather than silently.
//
// Two fixtures, two ways a fact becomes invalid:
//   A. stale-memories — low-confidence, expired, rejected, and conflicted records must be OMITTED
//      while the one fresh fact is INCLUDED (suppression-by-status / validity / confidence).
//   B. knowledge-update — a superseded value must be OMITTED while its accepted replacement is
//      INCLUDED (the bi-temporal knowledge-update competency), joined by a supersedes edge.
//
// Mutation-robustness: each part asserts BOTH that the valid target is present (MPA=1) AND that every
// invalid id is absent (FAA=1) — so dropping the suppression OR dropping the valid target fails it.

import { describe, expect, it } from "vitest";

import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  loadFixture,
  makeEdge,
  makeRecord,
  projectScopeOf,
  spyPortFromRecords,
  spyPortFromRecordsAndEdges,
  userScope,
} from "../_support.js";
import { famaScore, includedIds } from "../metrics.js";
import type { Scorecard, ScenarioMetric } from "../scorecard.js";

const SCENARIO_NAME = "forgetting-accuracy";

interface PartScore {
  readonly mpa: number;
  readonly faa: number;
  readonly fama: number;
}

function staleSuppressionFama(): PartScore {
  const fixture = loadFixture("stale-memories.json")[0];
  if (fixture === undefined) throw new Error("expected stale-memories fixture");
  const records = fixture.memories.map(makeRecord);
  const request: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    queryText: "deploy script",
    nowMs: FIXED_NOW_MS,
  };
  const result = retrieveMemoryContext(request, spyPortFromRecords(records));
  return famaScore({
    includedRanked: includedIds(result),
    validTargetIds: ["fresh-fact"],
    invalidIds: ["stale-low-confidence", "stale-expired", "blocked-rejected", "blocked-conflicted"],
  });
}

function knowledgeUpdateFama(): PartScore {
  const fixture = loadFixture("knowledge-update.json")[0];
  if (fixture === undefined) throw new Error("expected knowledge-update fixture");
  const records = fixture.memories.map(makeRecord);
  const edges = (fixture.edges ?? []).map(makeEdge);
  const request: MemoryRetrievalRequest = {
    scopes: [projectScopeOf("proj-keiko")],
    queryText: "primary deploy region",
    nowMs: FIXED_NOW_MS,
  };
  const result = retrieveMemoryContext(request, spyPortFromRecordsAndEdges(records, edges));
  return famaScore({
    includedRanked: includedIds(result),
    validTargetIds: ["ku-region-new"],
    invalidIds: ["ku-region-old"],
  });
}

function forgettingAccuracyResult(): {
  passed: boolean;
  evidence: string;
  metrics: readonly ScenarioMetric[];
} {
  const stale = staleSuppressionFama();
  const update = knowledgeUpdateFama();
  const passed = stale.fama === 1 && update.fama === 1;
  return {
    passed,
    evidence: `stale: mpa=${String(stale.mpa)} faa=${String(stale.faa)} fama=${String(
      stale.fama,
    )}; update: mpa=${String(update.mpa)} faa=${String(update.faa)} fama=${String(update.fama)}`,
    metrics: [
      { name: "fama-stale-suppression", value: stale.fama },
      { name: "fama-knowledge-update", value: update.fama },
    ],
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence, metrics } = forgettingAccuracyResult();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence, metrics);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("achieves FAMA=1 for both status-suppression and knowledge-update supersession", () => {
    const { passed, evidence } = forgettingAccuracyResult();
    expect(passed, evidence).toBe(true);
  });
});
