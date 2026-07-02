import { basename } from "node:path";

import type { ExplorationBudget } from "@oscharko-dev/keiko-contracts/connected-context";
import type { ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";

// Splits a base budget across n sources so total fan-out work stays bounded regardless of N.
// Per-source dimensions floor-divide with a Math.max(1, ...) floor so a source is never starved to
// zero. `rerankCallsMax` is left unchanged because it is a per-source cap, not a shared pool.
export function splitExplorationBudget(base: ExplorationBudget, n: number): ExplorationBudget {
  if (n <= 1) return base;
  const split = (value: number): number => Math.max(1, Math.floor(value / n));
  return {
    searchCallsMax: split(base.searchCallsMax),
    filesReadMax: split(base.filesReadMax),
    excerptBytesMax: split(base.excerptBytesMax),
    modelInputTokensMax: split(base.modelInputTokensMax),
    modelOutputTokensMax: split(base.modelOutputTokensMax),
    elapsedMsMax: split(base.elapsedMsMax),
    rerankCallsMax: base.rerankCallsMax,
  };
}

function rawSourceLabel(scope: ChatConnectedScope): string {
  return scope.root === undefined ? "project" : basename(scope.root);
}

function scopeBudgetWeight(scope: ChatConnectedScope, question: string): number {
  const lowered = question.toLowerCase();
  const basenameHit =
    scope.root !== undefined && lowered.includes(rawSourceLabel(scope).toLowerCase());
  const pathHit = scope.relativePaths.some((entry) =>
    lowered.includes(basename(entry).toLowerCase()),
  );
  return 1 + (basenameHit ? 3 : 0) + (pathHit ? 2 : 0);
}

function splitWeightedDimension(value: number, weights: readonly number[]): readonly number[] {
  if (weights.length <= 1) return [value];
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map((weight) => (value * weight) / totalWeight);
  const out = raw.map((part) => Math.max(1, Math.floor(part)));
  let remaining = Math.max(0, value - out.reduce((sum, part) => sum + part, 0));
  const order = raw
    .map((part, index) => ({
      index,
      fraction: part - Math.floor(part),
      weight: weights[index] ?? 0,
    }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);
  for (const entry of order) {
    if (remaining <= 0) break;
    out[entry.index] = (out[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return out;
}

export function splitExplorationBudgets(
  base: ExplorationBudget,
  scopes: readonly ChatConnectedScope[],
  question: string,
): readonly ExplorationBudget[] {
  if (scopes.length <= 1) return [base];
  const weights = scopes.map((scope) => scopeBudgetWeight(scope, question));
  const searchCalls = splitWeightedDimension(base.searchCallsMax, weights);
  const filesRead = splitWeightedDimension(base.filesReadMax, weights);
  const excerptBytes = splitWeightedDimension(base.excerptBytesMax, weights);
  const modelInput = splitWeightedDimension(base.modelInputTokensMax, weights);
  const modelOutput = splitWeightedDimension(base.modelOutputTokensMax, weights);
  const elapsed = splitWeightedDimension(base.elapsedMsMax, weights);
  return scopes.map((_, index) => ({
    searchCallsMax: searchCalls[index] ?? 1,
    filesReadMax: filesRead[index] ?? 1,
    excerptBytesMax: excerptBytes[index] ?? 1,
    modelInputTokensMax: modelInput[index] ?? 1,
    modelOutputTokensMax: modelOutput[index] ?? 1,
    elapsedMsMax: elapsed[index] ?? 1,
    rerankCallsMax: base.rerankCallsMax,
  }));
}
