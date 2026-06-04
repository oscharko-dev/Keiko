// Budget governor state machine (Epic #177, Issue #181).
// Accumulates ExplorationUsage and stops execution when any dimension exceeds its budget cap.
// Immutable state objects only — every transition returns a fresh GovernorState. No persistence;
// callers persist via the audit ledger in #187.

import {
  isWithinBudget,
  type ExplorationBudget,
  type ExplorationUsage,
} from "@oscharko-dev/keiko-contracts/connected-context";

import type { ExplorationPlan } from "./plan.js";

export type GovernorStatus = "running" | "completed" | "budget-exhausted";

export interface GovernorState {
  readonly plan: ExplorationPlan;
  readonly usage: ExplorationUsage;
  readonly currentRingIndex: number;
  readonly status: GovernorStatus;
  readonly stopReason: string | undefined;
}

const ZERO_USAGE: ExplorationUsage = {
  searchCalls: 0,
  filesRead: 0,
  excerptBytes: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
  rerankCalls: 0,
} as const;

const USAGE_KEYS: readonly (keyof ExplorationUsage)[] = [
  "searchCalls",
  "filesRead",
  "excerptBytes",
  "modelInputTokens",
  "modelOutputTokens",
  "elapsedMs",
  "rerankCalls",
];

const BUDGET_KEY_FOR_USAGE: Readonly<Record<keyof ExplorationUsage, keyof ExplorationBudget>> = {
  searchCalls: "searchCallsMax",
  filesRead: "filesReadMax",
  excerptBytes: "excerptBytesMax",
  modelInputTokens: "modelInputTokensMax",
  modelOutputTokens: "modelOutputTokensMax",
  elapsedMs: "elapsedMsMax",
  rerankCalls: "rerankCallsMax",
};

function assertUsageDelta(delta: ExplorationUsage): void {
  for (const key of USAGE_KEYS) {
    const value = delta[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Governor usage delta has invalid ${key}: ${String(value)}`);
    }
  }
}

function addUsage(a: ExplorationUsage, b: ExplorationUsage): ExplorationUsage {
  return {
    searchCalls: a.searchCalls + b.searchCalls,
    filesRead: a.filesRead + b.filesRead,
    excerptBytes: a.excerptBytes + b.excerptBytes,
    modelInputTokens: a.modelInputTokens + b.modelInputTokens,
    modelOutputTokens: a.modelOutputTokens + b.modelOutputTokens,
    elapsedMs: a.elapsedMs + b.elapsedMs,
    rerankCalls: a.rerankCalls + b.rerankCalls,
  };
}

function violatedDimensions(usage: ExplorationUsage, budget: ExplorationBudget): readonly string[] {
  const out: string[] = [];
  for (const key of USAGE_KEYS) {
    const cap = budget[BUDGET_KEY_FOR_USAGE[key]];
    if (usage[key] > cap) {
      out.push(key);
    }
  }
  return out;
}

export function createGovernor(plan: ExplorationPlan): GovernorState {
  if (plan.state !== "ready") {
    throw new RangeError(
      `Cannot govern a plan in state "${plan.state}"; only "ready" plans are runnable.`,
    );
  }
  return {
    plan,
    usage: ZERO_USAGE,
    currentRingIndex: 0,
    status: "running",
    stopReason: undefined,
  };
}

export function applyUsage(state: GovernorState, delta: ExplorationUsage): GovernorState {
  assertUsageDelta(delta);
  const nextUsage = addUsage(state.usage, delta);
  if (isWithinBudget(nextUsage, state.plan.budget)) {
    return { ...state, usage: nextUsage };
  }
  const violated = violatedDimensions(nextUsage, state.plan.budget);
  const stopReason =
    violated.length > 0 ? `budget-exhausted on ${violated.join(", ")}` : "budget-exhausted";
  return {
    ...state,
    usage: nextUsage,
    status: "budget-exhausted",
    stopReason,
  };
}

export function canContinue(state: GovernorState): boolean {
  return state.status === "running" && isWithinBudget(state.usage, state.plan.budget);
}

export function advanceRing(state: GovernorState): GovernorState {
  if (state.status !== "running") {
    return state;
  }
  if (state.currentRingIndex >= state.plan.rings.length) {
    return state;
  }
  return { ...state, currentRingIndex: state.currentRingIndex + 1 };
}

export function complete(state: GovernorState): GovernorState {
  if (state.status === "budget-exhausted") {
    return state;
  }
  return { ...state, status: "completed" };
}
