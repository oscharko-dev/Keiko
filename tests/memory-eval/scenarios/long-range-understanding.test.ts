// AC: long-range understanding. A memory linked by a `related` edge to a high-rank seed must
// receive a graph-proximity boost over an unrelated memory in the same candidate set.
//
// Mutation-robustness controls:
//  1. POSITIVE: the linked decision (dec-rate-limit-burst) appears in the included set with
//     a non-zero `graph` subscore.
//  2. NEGATIVE/CONTROL: re-run retrieval against a port whose edge methods always return
//     empty lists — the linked record's `graph` subscore must collapse to 0. This proves
//     the test would fail if the graph contribution disappeared.

import { describe, expect, it } from "vitest";

import {
  retrieveMemoryContext,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  loadFixture,
  makeEdge,
  makeRecord,
  projectScopeOf,
  spyPortFromRecordsAndEdges,
  spyPortFromRecords,
} from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "long-range-understanding";
const LINKED_ID = "dec-rate-limit-burst";

function loadDecisionsFixture(): {
  readonly request: MemoryRetrievalRequest;
  readonly portWithEdges: MemoryQueryPort;
  readonly portNoEdges: MemoryQueryPort;
} {
  const fixture = loadFixture("project-decisions.json")[0];
  if (fixture === undefined) throw new Error("expected project-decisions fixture");
  const records = fixture.memories.map(makeRecord);
  const edges = (fixture.edges ?? []).map(makeEdge);
  const request: MemoryRetrievalRequest = {
    scopes: [projectScopeOf("proj-keiko")],
    queryText: "rate limiter token bucket",
    nowMs: FIXED_NOW_MS,
  };
  return {
    request,
    portWithEdges: spyPortFromRecordsAndEdges(records, edges),
    portNoEdges: spyPortFromRecords(records),
  };
}

function graphSubscoreFor(
  port: MemoryQueryPort,
  request: MemoryRetrievalRequest,
  id: string,
): number | undefined {
  const result = retrieveMemoryContext(request, port);
  const match = result.included.find((m) => String(m.memoryId) === id);
  return match?.subscores.graph;
}

function runLongRangeUnderstanding(): { passed: boolean; evidence: string } {
  const { request, portWithEdges, portNoEdges } = loadDecisionsFixture();
  const withGraph = graphSubscoreFor(portWithEdges, request, LINKED_ID);
  const withoutEdges = retrieveMemoryContext(request, portNoEdges);
  const withoutGraph = withoutEdges.included.find((m) => String(m.memoryId) === LINKED_ID)?.subscores.graph;
  const omittedReason = withoutEdges.omitted.find((m) => String(m.memoryId) === LINKED_ID)?.reason;
  const positivePass = withGraph !== undefined && withGraph > 0;
  const controlPass = withoutGraph === undefined && omittedReason === "below-threshold";
  return {
    passed: positivePass && controlPass,
    evidence: `withEdges.graph=${String(withGraph)} noEdges.graph=${String(withoutGraph)} noEdges.omitted=${String(omittedReason)}`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runLongRangeUnderstanding();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("linked memory is retained via graph signal; without edges it falls below threshold", () => {
    const { passed, evidence } = runLongRangeUnderstanding();
    expect(passed, evidence).toBe(true);
  });
});
