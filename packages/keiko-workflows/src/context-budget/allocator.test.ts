// Tests for the deterministic context-budget allocator (ADR-0052 gates 3/4/5). Proves the single
// token currency, no-overflow over evictable lanes, non-eviction + fixed order + determinism, and
// the edge cases. No randomness, no clock — the seeded generator is a pure LCG.

import { describe, expect, it } from "vitest";

import {
  CONTEXT_LANE_IDS,
  DEFAULT_CONTEXT_PROFILE,
  countContextTokens,
  deriveContextProfile,
  estimateTokens,
  type ContextBudget,
  type ContextLaneId,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";

import {
  allocateContext,
  type AllocateContextInput,
  type ContextLaneInput,
  type ContextLaneItemInput,
} from "./allocator.js";
import { DEFAULT_CONTEXT_BUDGET } from "./defaults.js";

function item(id: string, text: string, score: number): ContextLaneItemInput {
  return { id, text, score };
}

function lane(laneId: ContextLaneId, items: readonly ContextLaneItemInput[]): ContextLaneInput {
  return { laneId, items };
}

// Repeats a unit string so an item's estimated token cost is predictable and large.
function bulk(unit: string, repeats: number): string {
  return unit.repeat(repeats);
}

const EVICTABLE_LANES: readonly ContextLaneId[] = CONTEXT_LANE_IDS.filter(
  (id) => id !== "system-contract" && id !== "user-task",
);

const CALIBRATED_PROFILE: ContextProfile = deriveContextProfile({
  maxInputTokens: DEFAULT_CONTEXT_PROFILE.maxInputTokens,
  reservedOutputTokens: DEFAULT_CONTEXT_PROFILE.reservedOutputTokens,
  safetyMarginTokens: DEFAULT_CONTEXT_PROFILE.safetyMarginTokens,
  tokenAccounting: {
    source: "calibrated",
    counterId: "allocator-calibrated-fixture-v1",
    scaleMilli: 1_250,
    offsetTokens: 1,
  },
});

function budgetForProfile(profile: ContextProfile): ContextBudget {
  return { ...DEFAULT_CONTEXT_BUDGET, profile };
}

describe("DEFAULT_CONTEXT_BUDGET", () => {
  it("pins one row per lane against DEFAULT_CONTEXT_PROFILE with the fixed allocation order", () => {
    expect(DEFAULT_CONTEXT_BUDGET.profile).toBe(DEFAULT_CONTEXT_PROFILE);
    expect(new Set(DEFAULT_CONTEXT_BUDGET.lanes.map((row) => row.laneId))).toEqual(
      new Set(CONTEXT_LANE_IDS),
    );
    expect(DEFAULT_CONTEXT_BUDGET.lanes).toHaveLength(CONTEXT_LANE_IDS.length);
    const priorityByLane = new Map(
      DEFAULT_CONTEXT_BUDGET.lanes.map((row) => [row.laneId, row.priority]),
    );
    expect(priorityByLane.get("system-contract")).toBe(0);
    expect(priorityByLane.get("user-task")).toBe(1);
    expect(priorityByLane.get("active-plan")).toBe(2);
    expect(priorityByLane.get("working-memory")).toBe(3);
    expect(priorityByLane.get("repo-evidence")).toBe(4);
    expect(priorityByLane.get("tool-observations")).toBe(5);
    expect(priorityByLane.get("history-summary")).toBe(6);
    expect(priorityByLane.get("verification-evidence")).toBe(7);
    // The eight priorities are a permutation of 0..7 (a strict deterministic order).
    expect([...priorityByLane.values()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("marks system-contract + user-task non-evictable with a reserved floor under the budget", () => {
    const nonEvictable = DEFAULT_CONTEXT_BUDGET.lanes.filter((row) => row.eviction === "none");
    expect(nonEvictable.map((row) => row.laneId)).toEqual(["system-contract", "user-task"]);
    for (const row of nonEvictable) {
      expect(row.minReservedTokens).toBeGreaterThan(0);
    }
    const reservedSum = nonEvictable.reduce((sum, row) => sum + row.minReservedTokens, 0);
    expect(reservedSum).toBeLessThan(DEFAULT_CONTEXT_PROFILE.effectiveInputBudget);
  });
});

describe("allocateContext — gate 3 (single token currency)", () => {
  it("counts an included item's cost as exactly estimateTokens(text)", () => {
    const text = "function hello() { return 42; }";
    const input: AllocateContextInput = {
      profile: DEFAULT_CONTEXT_PROFILE,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes: [lane("repo-evidence", [item("a", text, 1)])],
    };
    const result = allocateContext(input);
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    expect(repo?.estimatedTokens).toBe(estimateTokens(text));
    expect(result.totalEstimatedTokens).toBe(estimateTokens(text));
  });

  it("uses calibrated profile accounting when supplied", () => {
    const text = "Memory: confirm tool observation and document context boundaries.";
    const input: AllocateContextInput = {
      profile: CALIBRATED_PROFILE,
      budget: budgetForProfile(CALIBRATED_PROFILE),
      lanes: [lane("working-memory", [item("memory-1", text, 1)])],
    };
    const result = allocateContext(input);
    const workingMemory = result.lanes.find((l) => l.laneId === "working-memory");
    const calibrated = countContextTokens(text, CALIBRATED_PROFILE.tokenAccounting);
    expect(workingMemory?.estimatedTokens).toBe(calibrated);
    expect(result.totalEstimatedTokens).toBe(calibrated);
    expect(calibrated).toBeGreaterThan(estimateTokens(text));
    expect(result.diagnostics.profile.tokenAccounting?.source).toBe("calibrated");
  });

  it("charges two lanes with identical text identical tokens", () => {
    const text = bulk("alpha beta gamma ", 50);
    const input: AllocateContextInput = {
      profile: DEFAULT_CONTEXT_PROFILE,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes: [
        lane("repo-evidence", [item("r", text, 1)]),
        lane("working-memory", [item("w", text, 1)]),
      ],
    };
    const result = allocateContext(input);
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    const wm = result.lanes.find((l) => l.laneId === "working-memory");
    expect(repo?.estimatedTokens).toBe(wm?.estimatedTokens);
    expect(repo?.estimatedTokens).toBe(estimateTokens(text));
  });
});

// Pure seeded generator (LCG) — deterministic, no Math.random.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generateLanes(seed: number): readonly ContextLaneInput[] {
  const rng = makeRng(seed);
  return CONTEXT_LANE_IDS.map((laneId) => {
    const count = Math.floor(rng() * 6);
    const items: ContextLaneItemInput[] = [];
    for (let i = 0; i < count; i += 1) {
      const repeats = 1 + Math.floor(rng() * 400);
      items.push(item(`${laneId}-${String(i)}`, bulk("token ", repeats), rng()));
    }
    return lane(laneId, items);
  });
}

function nonEvictableTokens(result: ReturnType<typeof allocateContext>): number {
  return result.lanes
    .filter((l) => l.laneId === "system-contract" || l.laneId === "user-task")
    .reduce((sum, l) => sum + l.estimatedTokens, 0);
}

function evictableTokens(result: ReturnType<typeof allocateContext>): number {
  return result.lanes
    .filter((l) => EVICTABLE_LANES.includes(l.laneId))
    .reduce((sum, l) => sum + l.estimatedTokens, 0);
}

describe("allocateContext — gate 4 (no evictable overflow)", () => {
  it("keeps the included evictable sum <= effectiveInputBudget across generated inputs", () => {
    const budget = DEFAULT_CONTEXT_BUDGET.profile.effectiveInputBudget;
    for (let seed = 1; seed <= 40; seed += 1) {
      const result = allocateContext({
        profile: DEFAULT_CONTEXT_PROFILE,
        budget: DEFAULT_CONTEXT_BUDGET,
        lanes: generateLanes(seed),
      });
      const reserved = nonEvictableTokens(result);
      expect(evictableTokens(result)).toBeLessThanOrEqual(budget - reserved);
      expect(evictableTokens(result)).toBeLessThanOrEqual(budget);
    }
  });

  it("never exceeds the total budget unless non-evictable content alone does", () => {
    const budget = DEFAULT_CONTEXT_PROFILE.effectiveInputBudget;
    for (let seed = 100; seed <= 130; seed += 1) {
      const result = allocateContext({
        profile: DEFAULT_CONTEXT_PROFILE,
        budget: DEFAULT_CONTEXT_BUDGET,
        lanes: generateLanes(seed),
      });
      if (result.totalEstimatedTokens > budget) {
        expect(nonEvictableTokens(result)).toBeGreaterThan(budget);
      }
    }
  });
});

describe("allocateContext — gate 5 (non-eviction + order + determinism)", () => {
  // A tiny profile so the non-evictable lanes alone exhaust the window and every evictable lane
  // competes for the scraps in priority order. The user-task content is large enough to also
  // exceed its own lane cap (non-evictable overflow).
  const tinyProfile: ContextProfile = deriveContextProfile({
    maxInputTokens: 300,
    reservedOutputTokens: 0,
    safetyMarginTokens: 0,
  });

  function overBudgetInput(): AllocateContextInput {
    const big = bulk("x ", 300);
    const lanes: ContextLaneInput[] = [
      lane("system-contract", [item("sys-1", bulk("S ", 400), 1)]),
      lane("user-task", [item("task-1", bulk("U ", 400), 1)]),
      lane("active-plan", [item("plan-1", big, 0.9)]),
      lane("repo-evidence", [item("repo-1", big, 0.9), item("repo-2", big, 0.1)]),
      lane("tool-observations", [item("tool-1", big, 0.5)]),
      lane("history-summary", [item("hist-1", big, 0.5)]),
    ];
    return { profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes };
  }

  it("keeps ALL non-evictable items while lower-priority lanes are evicted", () => {
    const result = allocateContext(overBudgetInput());
    const sys = result.lanes.find((l) => l.laneId === "system-contract");
    const task = result.lanes.find((l) => l.laneId === "user-task");
    expect(sys?.includedItemIds).toEqual(["sys-1"]);
    expect(task?.includedItemIds).toEqual(["task-1"]);
    // Reserved non-evictable content alone exceeds the window => overall pressure exceeded.
    expect(result.diagnostics.budgetPressure).toBe("exceeded");
    // Every evictable lane is fully evicted because the non-evictable lanes consumed the budget.
    for (const laneId of EVICTABLE_LANES) {
      const l = result.lanes.find((x) => x.laneId === laneId);
      if (l !== undefined) {
        expect(l.includedItemIds).toEqual([]);
      }
    }
  });

  it("evicts in the fixed priority order when only some budget remains", () => {
    // Budget large enough for the two non-evictable lanes plus exactly ONE evictable item.
    const sysText = bulk("S ", 100);
    const taskText = bulk("U ", 100);
    const evItem = bulk("E ", 100);
    const reserved = estimateTokens(sysText) + estimateTokens(taskText);
    const oneItem = estimateTokens(evItem);
    const profile = deriveContextProfile({
      maxInputTokens: reserved + oneItem,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const input: AllocateContextInput = {
      profile,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes: [
        lane("system-contract", [item("sys-1", sysText, 1)]),
        lane("user-task", [item("task-1", taskText, 1)]),
        lane("active-plan", [item("plan-1", evItem, 0.9)]),
        lane("repo-evidence", [item("repo-1", evItem, 0.9)]),
      ],
    };
    const result = allocateContext(input);
    // active-plan (priority 2) wins the single remaining slot; repo-evidence (priority 4) loses.
    const plan = result.lanes.find((l) => l.laneId === "active-plan");
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    expect(plan?.includedItemIds).toEqual(["plan-1"]);
    expect(repo?.includedItemIds).toEqual([]);
    expect(repo?.diagnostics.compactionReason).toBe("budget");
  });

  it("is deterministic — same input twice yields deeply-equal results", () => {
    const input = overBudgetInput();
    expect(allocateContext(input)).toEqual(allocateContext(input));
  });

  it("orders result lanes in canonical assembly order and flags orderedForRecency", () => {
    const result = allocateContext({
      profile: DEFAULT_CONTEXT_PROFILE,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes: [
        lane("verification-evidence", [item("v", "v", 1)]),
        lane("system-contract", [item("s", "s", 1)]),
        lane("repo-evidence", [item("r", "r", 1)]),
      ],
    });
    expect(result.lanes.map((l) => l.laneId)).toEqual([
      "system-contract",
      "repo-evidence",
      "verification-evidence",
    ]);
    expect(result.diagnostics.orderedForRecency).toBe(true);
  });
});

describe("allocateContext — within-lane score-greedy ordering", () => {
  it("includes higher-score items first and breaks ties by id ASC", () => {
    const unit = bulk("z ", 200);
    const cap = estimateTokens(unit) * 2;
    const profile = deriveContextProfile({
      maxInputTokens: cap,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const result = allocateContext({
      profile,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes: [
        lane("repo-evidence", [item("b", unit, 0.5), item("a", unit, 0.5), item("c", unit, 0.9)]),
      ],
    });
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    // c (0.9) first, then a (tie 0.5, id < b) — b is dropped for budget.
    expect(repo?.includedItemIds).toEqual(["c", "a"]);
    expect(repo?.excludedItemIds).toEqual(["b"]);
  });
});

describe("allocateContext — edge cases", () => {
  const baseInput = (lanes: readonly ContextLaneInput[]): AllocateContextInput => ({
    profile: DEFAULT_CONTEXT_PROFILE,
    budget: DEFAULT_CONTEXT_BUDGET,
    lanes,
  });

  it("handles empty lanes[]", () => {
    const result = allocateContext(baseInput([]));
    expect(result.lanes).toEqual([]);
    expect(result.totalEstimatedTokens).toBe(0);
    expect(result.diagnostics.budgetPressure).toBe("low");
  });

  it("handles a lane with no items", () => {
    const result = allocateContext(baseInput([lane("repo-evidence", [])]));
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    expect(repo?.includedItemIds).toEqual([]);
    expect(repo?.estimatedTokens).toBe(0);
  });

  it("excludes a single item larger than the whole budget from an evictable lane", () => {
    const huge = bulk("y ", 100_000);
    const result = allocateContext(baseInput([lane("repo-evidence", [item("big", huge, 1)])]));
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    expect(repo?.includedItemIds).toEqual([]);
    expect(repo?.excludedItemIds).toEqual(["big"]);
    expect(repo?.diagnostics.compactionReason).toBe("budget");
  });

  it("includes an over-budget item in a non-evictable lane and forces exceeded pressure", () => {
    const huge = bulk("y ", 100_000);
    const result = allocateContext(baseInput([lane("system-contract", [item("big", huge, 1)])]));
    const sys = result.lanes.find((l) => l.laneId === "system-contract");
    expect(sys?.includedItemIds).toEqual(["big"]);
    expect(sys?.diagnostics.budgetPressure).toBe("exceeded");
    expect(result.diagnostics.budgetPressure).toBe("exceeded");
  });

  it("handles a clamped 0 effectiveInputBudget — evictable excluded, non-evictable kept", () => {
    const zero = deriveContextProfile({
      maxInputTokens: 1_000,
      reservedOutputTokens: 800,
      safetyMarginTokens: 400,
    });
    expect(zero.effectiveInputBudget).toBe(0);
    const result = allocateContext({
      profile: zero,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes: [
        lane("user-task", [item("u", "task", 1)]),
        lane("repo-evidence", [item("r", "evidence", 1)]),
      ],
    });
    const task = result.lanes.find((l) => l.laneId === "user-task");
    const repo = result.lanes.find((l) => l.laneId === "repo-evidence");
    expect(task?.includedItemIds).toEqual(["u"]);
    expect(repo?.includedItemIds).toEqual([]);
    expect(result.diagnostics.budgetPressure).toBe("exceeded");
  });

  it("ignores an input lane absent from the budget rows", () => {
    const sparseBudget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      lanes: DEFAULT_CONTEXT_BUDGET.lanes.filter((row) => row.laneId !== "repo-evidence"),
    };
    const result = allocateContext({
      profile: DEFAULT_CONTEXT_PROFILE,
      budget: sparseBudget,
      lanes: [
        lane("repo-evidence", [item("r", "dropped", 1)]),
        lane("user-task", [item("u", "kept", 1)]),
      ],
    });
    expect(result.lanes.find((l) => l.laneId === "repo-evidence")).toBeUndefined();
    expect(result.lanes.find((l) => l.laneId === "user-task")?.includedItemIds).toEqual(["u"]);
  });

  it("does not mutate the input lanes or items", () => {
    const lanes: readonly ContextLaneInput[] = [
      lane("repo-evidence", [item("b", "bb", 0.1), item("a", "aa", 0.9)]),
    ];
    const snapshot = JSON.stringify(lanes);
    allocateContext(baseInput(lanes));
    expect(JSON.stringify(lanes)).toBe(snapshot);
  });
});
