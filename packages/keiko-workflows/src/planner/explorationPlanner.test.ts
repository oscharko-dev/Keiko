// Tests for the planner facade (Issue #181).

import { describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";

import { createExplorationPlan } from "./plan.js";
import { planAndGovern, planExploration } from "./explorationPlanner.js";

function happyScope(overrides: Partial<SelectedScope> = {}): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-1",
    workspaceRoot: "/work",
    kind: "directory",
    relativePaths: ["src"],
    conversationId: undefined,
    connectedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function happyQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate src/foo/bar.ts behaviour of `MyClass`",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

const FIXED_NOW = { nowMs: (): number => 1_700_000_000_000 };

describe("planExploration", () => {
  it("returns the same plan as createExplorationPlan", () => {
    const input = { scope: happyScope(), query: happyQuery() };
    const facade = planExploration(input, FIXED_NOW);
    const direct = createExplorationPlan(input, FIXED_NOW);
    expect(facade).toEqual(direct);
  });
});

describe("planAndGovern", () => {
  it("returns undefined governor when the plan is not ready", () => {
    const result = planAndGovern(
      { scope: happyScope(), query: happyQuery({ text: "the and for of" }) },
      FIXED_NOW,
    );
    expect(result.plan.state).toBe("clarification-needed");
    expect(result.governor).toBeUndefined();
  });

  it("returns a fresh-zeroed governor when the plan is ready", () => {
    const result = planAndGovern({ scope: happyScope(), query: happyQuery() }, FIXED_NOW);
    expect(result.plan.state).toBe("ready");
    expect(result.governor).toBeDefined();
    expect(result.governor?.status).toBe("running");
    expect(result.governor?.currentRingIndex).toBe(0);
    expect(result.governor?.usage.searchCalls).toBe(0);
  });
});
