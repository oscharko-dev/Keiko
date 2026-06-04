// Weighted scoring composition for ranked candidates (Epic #177, Issue #182).
// Pure function: signal vector × weight vector → clamped unit score. The default positive
// weights sum to 0.95 and the generated penalty weight is 0.30; the filter layer's
// `omitGenerated` default keeps generated files OUT of the kept set regardless of score,
// so the scoring penalty is a secondary defence (a fully-positive generated file scores
// 0.65). Callers may override weights to tune ring-specific behaviour; never uses
// parseFloat or .toFixed.

import type { ExtractedSignals } from "./signals.js";

export interface ScoringWeights {
  readonly provenanceBestScore: number;
  readonly provenanceCount: number;
  readonly anchorOverlap: number;
  readonly pathDepthAffinity: number;
  readonly testPairBonus: number;
  readonly stacktracePositionBonus: number;
  readonly generatedPenalty: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  provenanceBestScore: 0.35,
  provenanceCount: 0.1,
  anchorOverlap: 0.25,
  pathDepthAffinity: 0.1,
  testPairBonus: 0.1,
  stacktracePositionBonus: 0.05,
  generatedPenalty: 0.3,
} as const;

const SIGNAL_WEIGHT_KEYS: Readonly<Record<string, keyof ScoringWeights>> = {
  "provenance-best-score": "provenanceBestScore",
  "provenance-count": "provenanceCount",
  "anchor-overlap": "anchorOverlap",
  "path-depth-affinity": "pathDepthAffinity",
  "test-pair-bonus": "testPairBonus",
  "stacktrace-position-bonus": "stacktracePositionBonus",
  "generated-penalty": "generatedPenalty",
};

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function computeScore(
  signals: ExtractedSignals,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  let raw = 0;
  for (const signal of signals.signals) {
    const key = SIGNAL_WEIGHT_KEYS[signal.name];
    if (key === undefined) {
      continue;
    }
    raw += signal.value * weights[key];
  }
  return clampUnit(raw);
}
