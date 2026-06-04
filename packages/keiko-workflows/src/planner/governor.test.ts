// Tests for the budget governor state machine (Issue #181).

import { describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ExplorationUsage,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";

import {
  advanceRing,
  applyUsage,
  canContinue,
  complete,
  createGovernor,
  type GovernorState,
} from "./governor.js";
import { createExplorationPlan, type ExplorationPlan } from "./plan.js";

function happyScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-1",
    workspaceRoot: "/work",
    kind: "directory",
    relativePaths: ["src"],
    conversationId: undefined,
    connectedAtMs: 1_700_000_000_000,
  };
}

function happyQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate src/foo/bar.ts behaviour of `MyClass`",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1_700_000_000_000,
  };
}

function readyPlan(): ExplorationPlan {
  return createExplorationPlan(
    { scope: happyScope(), query: happyQuery() },
    { nowMs: () => 1_700_000_000_000 },
  );
}

function delta(overrides: Partial<ExplorationUsage> = {}): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
    ...overrides,
  };
}

function makeGovernor(): GovernorState {
  return createGovernor(readyPlan());
}

describe("createGovernor", () => {
  it("throws when the plan is not in ready state", () => {
    const blocked: ExplorationPlan = { ...readyPlan(), state: "clarification-needed" };
    expect(() => createGovernor(blocked)).toThrow(RangeError);
  });

  it("initial state has zero usage, ring index 0, running status", () => {
    const g = makeGovernor();
    expect(g.usage).toEqual(delta());
    expect(g.currentRingIndex).toBe(0);
    expect(g.status).toBe("running");
    expect(g.stopReason).toBeUndefined();
  });
});

describe("applyUsage", () => {
  it("accumulates deltas across calls", () => {
    let g = makeGovernor();
    g = applyUsage(g, delta({ searchCalls: 1, filesRead: 2 }));
    g = applyUsage(g, delta({ searchCalls: 3 }));
    expect(g.usage.searchCalls).toBe(4);
    expect(g.usage.filesRead).toBe(2);
    expect(g.status).toBe("running");
  });

  it("exceeding filesRead budget transitions to budget-exhausted with named dimension", () => {
    let g = makeGovernor();
    g = applyUsage(g, delta({ filesRead: DEFAULT_EXPLORATION_BUDGET.filesReadMax + 1 }));
    expect(g.status).toBe("budget-exhausted");
    expect(g.stopReason).toContain("filesRead");
  });

  it("exceeding multiple dimensions at once names each in stopReason", () => {
    let g = makeGovernor();
    g = applyUsage(
      g,
      delta({
        filesRead: DEFAULT_EXPLORATION_BUDGET.filesReadMax + 1,
        elapsedMs: DEFAULT_EXPLORATION_BUDGET.elapsedMsMax + 1,
      }),
    );
    expect(g.status).toBe("budget-exhausted");
    expect(g.stopReason).toContain("filesRead");
    expect(g.stopReason).toContain("elapsedMs");
  });

  it("throws RangeError for a negative usage delta", () => {
    const g = makeGovernor();
    expect(() => applyUsage(g, delta({ searchCalls: -1 }))).toThrow(RangeError);
  });

  it("throws RangeError for a non-integer usage delta", () => {
    const g = makeGovernor();
    expect(() => applyUsage(g, delta({ filesRead: 1.5 }))).toThrow(RangeError);
  });

  it("throws RangeError for a non-finite usage delta", () => {
    const g = makeGovernor();
    expect(() => applyUsage(g, delta({ filesRead: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
  });
});

describe("canContinue", () => {
  it("returns true for a fresh running governor", () => {
    expect(canContinue(makeGovernor())).toBe(true);
  });

  it("returns false immediately after budget-exhausted", () => {
    let g = makeGovernor();
    g = applyUsage(g, delta({ filesRead: DEFAULT_EXPLORATION_BUDGET.filesReadMax + 1 }));
    expect(canContinue(g)).toBe(false);
  });
});

describe("advanceRing", () => {
  it("increments the current ring index", () => {
    const g = makeGovernor();
    const next = advanceRing(g);
    expect(next.currentRingIndex).toBe(g.currentRingIndex + 1);
  });

  it("stays at plan.rings.length once exhausted", () => {
    let g = makeGovernor();
    for (let i = 0; i < g.plan.rings.length + 3; i += 1) {
      g = advanceRing(g);
    }
    expect(g.currentRingIndex).toBe(g.plan.rings.length);
  });
});

describe("complete", () => {
  it("marks the state completed", () => {
    const g = complete(makeGovernor());
    expect(g.status).toBe("completed");
  });
});
