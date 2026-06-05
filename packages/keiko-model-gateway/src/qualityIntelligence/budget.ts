// Quality Intelligence token-budget accounting (Epic #270, Issue #279).
//
// Pure-function budget state machine: reserve, release, exhaustion check. State is an
// immutable shape — every mutating call returns a NEW state value. Negative reservations
// and refunds are clamped to zero so callers cannot accidentally inflate or underflow the
// budget.

export interface QualityIntelligenceBudgetState {
  readonly totalBudget: number;
  readonly consumed: number;
}

export function createBudget(totalBudget: number): QualityIntelligenceBudgetState {
  const clamped = Number.isFinite(totalBudget) && totalBudget > 0 ? totalBudget : 0;
  return Object.freeze({ totalBudget: clamped, consumed: 0 });
}

function clampCost(cost: number): number {
  if (!Number.isFinite(cost) || cost <= 0) {
    return 0;
  }
  return cost;
}

export function reserveBudget(
  state: QualityIntelligenceBudgetState,
  cost: number,
): QualityIntelligenceBudgetState {
  const delta = clampCost(cost);
  const nextConsumed = Math.min(state.totalBudget, state.consumed + delta);
  return Object.freeze({
    totalBudget: state.totalBudget,
    consumed: nextConsumed,
  });
}

export function releaseBudget(
  state: QualityIntelligenceBudgetState,
  refund: number,
): QualityIntelligenceBudgetState {
  const delta = clampCost(refund);
  const nextConsumed = Math.max(0, state.consumed - delta);
  return Object.freeze({
    totalBudget: state.totalBudget,
    consumed: nextConsumed,
  });
}

export function isExhausted(state: QualityIntelligenceBudgetState): boolean {
  return state.consumed >= state.totalBudget;
}

export function remainingBudget(state: QualityIntelligenceBudgetState): number {
  return Math.max(0, state.totalBudget - state.consumed);
}
