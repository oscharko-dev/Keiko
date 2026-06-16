// Pure, deterministic graded-quality metrics for the memory evaluation harness (Epic #204 / #215).
//
// These upgrade the harness from pass/fail booleans to graded, CI-gateable quality numbers
// (recall@k, precision@k, and the forgetting-aware FAMA metric) so a regression in ranking, decay,
// supersession, or suppression behaviour is caught QUANTITATIVELY — not just structurally. This is
// the safety net every plasticity/forgetting change is measured against.
//
// Every metric is EXACT-MATCH set arithmetic over (a) the ordered ids the retrieval layer chose to
// include and (b) caller-supplied ground-truth label sets read straight from the fixtures. There is
// NO clock, NO IO, NO randomness, and NO LLM judge, so two runs over identical fixtures produce
// byte-identical numbers. Values are rounded to METRIC_PRECISION decimals so the serialised
// scorecard stays byte-stable across runs (the eval-runner determinism guard asserts this).
//
// FAMA (Forgetting-Aware Memory Accuracy), after the forgetting-aware evaluation literature:
//   MPA  = fraction of currently-valid TARGET memories that were INCLUDED  (recall of what to keep)
//   FAA  = fraction of INVALIDATED memories that were correctly OMITTED     (accuracy of forgetting)
//   FAMA = max(0, MPA - lambda * (1 - FAA))
// A system that surfaces a stale / superseded / forgotten fact is penalised even when its raw recall
// is perfect — exactly the failure plain recall@k hides.

import type { MemoryRetrievalResult } from "@oscharko-dev/keiko-memory-retrieval";

export const METRIC_PRECISION = 4 as const;
const DEFAULT_FAMA_LAMBDA = 1;

// Round to a fixed number of decimals so a ratio of small integers serialises identically every run.
export function roundMetric(value: number): number {
  const factor = 10 ** METRIC_PRECISION;
  return Math.round(value * factor) / factor;
}

// The ids the ranker chose to surface, in rank order. String-projected so callers compare against
// plain fixture id strings without juggling branded ids.
export function includedIds(result: MemoryRetrievalResult): readonly string[] {
  return result.included.map((m) => String(m.memoryId));
}

function topK(ids: readonly string[], k: number): readonly string[] {
  return k >= ids.length ? ids : ids.slice(0, k);
}

// Recall@k: of the relevant ids, how many appear in the top-k surfaced set. An empty relevant set
// yields 1.0 (nothing to miss); callers asserting recall should pass a non-empty relevant set.
export function recallAtK(
  includedRanked: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  if (relevantIds.length === 0) return 1;
  const top = new Set(topK(includedRanked, k));
  let hit = 0;
  for (const id of relevantIds) if (top.has(id)) hit += 1;
  return roundMetric(hit / relevantIds.length);
}

// Precision@k: of the top-k surfaced ids, how many are relevant. An empty surfaced set yields 0.
export function precisionAtK(
  includedRanked: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  const top = topK(includedRanked, k);
  if (top.length === 0) return 0;
  const relevant = new Set(relevantIds);
  let hit = 0;
  for (const id of top) if (relevant.has(id)) hit += 1;
  return roundMetric(hit / top.length);
}

export interface FamaInputs {
  /** Ids the ranker surfaced (rank order is irrelevant to FAMA; membership is what counts). */
  readonly includedRanked: readonly string[];
  /** Currently-valid memories that SHOULD have been surfaced. */
  readonly validTargetIds: readonly string[];
  /** Invalidated (stale / superseded / forgotten / expired) memories that should NOT be surfaced. */
  readonly invalidIds: readonly string[];
  /** Penalty weight on forgetting errors. Defaults to 1 (a leaked stale fact fully offsets a hit). */
  readonly lambda?: number;
}

export interface FamaScore {
  readonly mpa: number;
  readonly faa: number;
  readonly fama: number;
}

export function famaScore(inputs: FamaInputs): FamaScore {
  const lambda = inputs.lambda ?? DEFAULT_FAMA_LAMBDA;
  const included = new Set(inputs.includedRanked);
  const mpa =
    inputs.validTargetIds.length === 0
      ? 1
      : inputs.validTargetIds.filter((id) => included.has(id)).length /
        inputs.validTargetIds.length;
  const faa =
    inputs.invalidIds.length === 0
      ? 1
      : inputs.invalidIds.filter((id) => !included.has(id)).length / inputs.invalidIds.length;
  const fama = Math.max(0, mpa - lambda * (1 - faa));
  return { mpa: roundMetric(mpa), faa: roundMetric(faa), fama: roundMetric(fama) };
}
