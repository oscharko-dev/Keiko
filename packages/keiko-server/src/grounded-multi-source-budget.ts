import { basename } from "node:path";

import type {
  ExplorationBudget,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";

const BUDGET_KEYS = [
  "searchCallsMax",
  "filesReadMax",
  "excerptBytesMax",
  "modelInputTokensMax",
  "modelOutputTokensMax",
  "elapsedMsMax",
  "rerankCallsMax",
] as const satisfies readonly (keyof ExplorationBudget)[];

function rawSourceLabel(scope: ChatConnectedScope): string {
  return scope.root === undefined ? "project" : basename(scope.root);
}

function sourceQueryTerms(text: string): readonly string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/gu) ?? [])].filter(
    (term) => term.length >= 2,
  );
}

function sourceSearchText(scope: ChatConnectedScope): string {
  return [scope.root, rawSourceLabel(scope), scope.kind, ...scope.relativePaths]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function sourceRelevanceWeight(scope: ChatConnectedScope, query: RetrievalQuery): number {
  const text = sourceSearchText(scope);
  let weight = 1;
  for (const term of sourceQueryTerms(query.text)) {
    if (text.includes(term)) {
      weight += text.split(/[^\w-]+/u).includes(term) ? 3 : 1;
    }
  }
  return weight;
}

function normalizedWeights(weights: readonly number[]): readonly number[] {
  return weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 1));
}

function zeroAllocation(count: number): readonly number[] {
  return Array.from({ length: count }, () => 0);
}

function seededAllocation(
  count: number,
  totalUnits: number,
): { readonly allocation: number[]; readonly remaining: number } {
  const floor = totalUnits >= count ? 1 : 0;
  return {
    allocation: Array.from({ length: count }, () => floor),
    remaining: totalUnits - floor * count,
  };
}

function addWholeShares(allocation: number[], wholeShares: readonly number[]): void {
  for (let index = 0; index < allocation.length; index += 1) {
    allocation[index] = (allocation[index] ?? 0) + (wholeShares[index] ?? 0);
  }
}

function remainderOrder(
  weights: readonly number[],
  rawShares: readonly number[],
  wholeShares: readonly number[],
): readonly { readonly index: number; readonly weight: number; readonly fraction: number }[] {
  return weights
    .map((weight, index) => ({
      index,
      weight,
      fraction: (rawShares[index] ?? 0) - (wholeShares[index] ?? 0),
    }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);
}

function addRemainderUnits(
  allocation: number[],
  order: readonly { readonly index: number }[],
  remaining: number,
): void {
  for (let i = 0; i < remaining; i += 1) {
    const entry = order[i % order.length];
    if (entry !== undefined) {
      allocation[entry.index] = (allocation[entry.index] ?? 0) + 1;
    }
  }
}

function allocateDimension(total: number, rawWeights: readonly number[]): readonly number[] {
  const count = rawWeights.length;
  if (count === 0) return [];
  const totalUnits = Math.max(0, Math.floor(total));
  if (totalUnits === 0) return zeroAllocation(count);
  const seeded = seededAllocation(count, totalUnits);
  if (seeded.remaining <= 0) return seeded.allocation;
  const weights = normalizedWeights(rawWeights);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const rawShares = weights.map((weight) => (seeded.remaining * weight) / weightSum);
  const wholeShares = rawShares.map((share) => Math.floor(share));
  addWholeShares(seeded.allocation, wholeShares);
  addRemainderUnits(
    seeded.allocation,
    remainderOrder(weights, rawShares, wholeShares),
    seeded.remaining - wholeShares.reduce((sum, share) => sum + share, 0),
  );
  return seeded.allocation;
}

function allocationAt(
  allocations: ReadonlyMap<keyof ExplorationBudget, readonly number[]>,
  key: keyof ExplorationBudget,
  index: number,
): number {
  return allocations.get(key)?.[index] ?? 0;
}

function budgetAt(
  allocations: ReadonlyMap<keyof ExplorationBudget, readonly number[]>,
  index: number,
): ExplorationBudget {
  return {
    searchCallsMax: allocationAt(allocations, "searchCallsMax", index),
    filesReadMax: allocationAt(allocations, "filesReadMax", index),
    excerptBytesMax: allocationAt(allocations, "excerptBytesMax", index),
    modelInputTokensMax: allocationAt(allocations, "modelInputTokensMax", index),
    modelOutputTokensMax: allocationAt(allocations, "modelOutputTokensMax", index),
    elapsedMsMax: allocationAt(allocations, "elapsedMsMax", index),
    rerankCallsMax: allocationAt(allocations, "rerankCallsMax", index),
  };
}

function budgetsFromWeights(
  base: ExplorationBudget,
  weights: readonly number[],
): readonly ExplorationBudget[] {
  if (weights.length <= 1) return [base];
  const allocations = new Map<keyof ExplorationBudget, readonly number[]>();
  for (const key of BUDGET_KEYS) {
    allocations.set(key, allocateDimension(base[key], weights));
  }
  return weights.map((_, index) => budgetAt(allocations, index));
}

export function splitExplorationBudget(base: ExplorationBudget, n: number): ExplorationBudget {
  return budgetsFromWeights(
    base,
    Array.from({ length: Math.max(1, n) }, () => 1),
  )[0] ?? base;
}

// Relevance-weighted fan-out allocation. The sum of every budget dimension equals the base cap, so
// connecting N sources cannot multiply work; query-matching roots/relative paths receive the largest
// shares. If a dimension has fewer units than sources, lower-scored sources receive a truthful zero
// cap for that dimension instead of silently multiplying total work.
export function splitExplorationBudgets(
  base: ExplorationBudget,
  scopes: readonly ChatConnectedScope[],
  query: RetrievalQuery,
): readonly ExplorationBudget[] {
  if (scopes.length <= 1) return [base];
  return budgetsFromWeights(
    base,
    scopes.map((scope) => sourceRelevanceWeight(scope, query)),
  );
}
