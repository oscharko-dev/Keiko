// AC: workspace-scope benchmark coverage and large-memory boundary behaviour. Retrieval must
// query only the requested workspace, respect the package fetch cap, and still surface the
// relevant workspace memory among hundreds of synthetic records.
//
// Mutation-robustness controls:
//  1. POSITIVE: the target workspace decision is included from a capped 500-record fetch.
//  2. NEGATIVE/CONTROL: a similarly worded memory in a different workspace is never returned
//     and the port receives exactly one listByScope call for ws-main.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  retrieveMemoryContext,
  type ListByScopeOptions,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";

import { FIXED_NOW_MS, loadFixture, makeRecord, sameScope, workspaceScopeOf } from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "workspace-scale-boundary";
const TARGET_ID = "workspace-ci-runner-policy";
const OTHER_WORKSPACE_ID = "workspace-other-ci-runner-policy";
const FILLER_COUNT = DEFAULT_LIST_BY_SCOPE_MAX_RESULTS + 40;

interface ObservedPort extends MemoryQueryPort {
  readonly calledScopes: readonly MemoryScope[];
  readonly fetchedCounts: readonly number[];
  readonly maxResultsHints: readonly (number | undefined)[];
}

function loadWorkspaceSeed(): readonly MemoryRecord[] {
  const fixture = loadFixture("workspace-scale.json")[0];
  if (fixture === undefined) throw new Error("expected workspace-scale fixture");
  return fixture.memories.map(makeRecord);
}

function fillerRecord(index: number): MemoryRecord {
  const serial = index.toString().padStart(3, "0");
  return makeRecord({
    id: `workspace-noise-${serial}`,
    scope: { kind: "workspace", workspaceId: "ws-main" },
    type: "semantic-fact",
    body: `workspace generated noise ${serial} tracks unrelated editor preference catalog entries`,
    tags: ["noise"],
    confidence: 0.72,
  });
}

function buildLargeWorkspaceCorpus(): readonly MemoryRecord[] {
  const records = [...loadWorkspaceSeed()];
  for (let i = 0; i < FILLER_COUNT; i += 1) {
    records.push(fillerRecord(i));
  }
  return records;
}

function boundedPort(records: readonly MemoryRecord[]): ObservedPort {
  const calls: MemoryScope[] = [];
  const fetchedCounts: number[] = [];
  const maxResultsHints: (number | undefined)[] = [];
  return {
    calledScopes: calls,
    fetchedCounts,
    maxResultsHints,
    listByScope: (scope: MemoryScope, options?: ListByScopeOptions): readonly MemoryRecord[] => {
      calls.push(scope);
      maxResultsHints.push(options?.maxResults);
      const scoped = records.filter((record) => sameScope(record.scope, scope));
      const capped = scoped.slice(0, options?.maxResults ?? scoped.length);
      fetchedCounts.push(capped.length);
      return capped;
    },
  };
}

function request(): MemoryRetrievalRequest {
  return {
    scopes: [workspaceScopeOf("ws-main")],
    queryText: "deterministic memory benchmark evidence release",
    nowMs: FIXED_NOW_MS,
  };
}

function runWorkspaceScaleBoundary(): { passed: boolean; evidence: string } {
  const port = boundedPort(buildLargeWorkspaceCorpus());
  const result = retrieveMemoryContext(request(), port);
  const included = result.included.map((memory) => String(memory.memoryId));
  const onlyRequestedWorkspace =
    port.calledScopes.length === 1 &&
    port.calledScopes.every((scope) => sameScope(scope, workspaceScopeOf("ws-main")));
  const fetchedAtCap = port.fetchedCounts[0] === DEFAULT_LIST_BY_SCOPE_MAX_RESULTS;
  const capHintApplied = port.maxResultsHints[0] === DEFAULT_LIST_BY_SCOPE_MAX_RESULTS;
  const targetIncluded = included.includes(TARGET_ID);
  const otherWorkspaceExcluded = !included.includes(OTHER_WORKSPACE_ID);
  return {
    passed:
      onlyRequestedWorkspace &&
      fetchedAtCap &&
      capHintApplied &&
      targetIncluded &&
      otherWorkspaceExcluded,
    evidence: `calls=${String(port.calledScopes.length)} fetched=${String(
      port.fetchedCounts[0] ?? 0,
    )} cap=${String(port.maxResultsHints[0] ?? "none")} included=[${included.join(",")}]`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runWorkspaceScaleBoundary();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("queries only the requested workspace and honours the 500-record retrieval cap", () => {
    const { passed, evidence } = runWorkspaceScaleBoundary();
    expect(passed, evidence).toBe(true);
  });
});
