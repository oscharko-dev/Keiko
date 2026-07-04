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
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly provenanceCount: number;
  readonly anchorOverlap: number;
  readonly pathDepthAffinity: number;
  readonly testPairBonus: number;
  readonly stacktracePositionBonus: number;
  readonly generatedPenalty: number;
  // Intent-conditioned signals (enterprise retrieval M4). OPTIONAL so existing weight literals stay
  // valid and DEFAULT_SCORING_WEIGHTS is unchanged; weight 0 / undefined ⇒ inert (computeScore
  // skips an absent weight). Non-zero only for the intents weightsForIntent boosts.
  readonly canonicalMetadata?: number;
  readonly structuralEdge?: number;
  readonly gitRecency?: number;
  readonly gitChurn?: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  provenanceBestScore: 0.35,
  semanticScore: 0.25,
  provenanceCount: 0.1,
  anchorOverlap: 0.25,
  pathDepthAffinity: 0.1,
  testPairBonus: 0.1,
  stacktracePositionBonus: 0.05,
  generatedPenalty: 0.3,
} as const;

// Intent-conditioned weight overrides (M4). Only the named intents receive non-default weights for
// the new canonical-metadata / structural-edge signals; every other intent (and the no-intent
// default path) returns DEFAULT_SCORING_WEIGHTS verbatim, so ranking is byte-identical there.
// Weights are deliberately modest (tie-breaker magnitude) to nudge, not dominate, the established
// provenance/anchor signals.
const INTENT_BOOSTED: ReadonlySet<string> = new Set([
  "project-metadata",
  "repository-overview",
  "targeted-code-search",
  "diagnostic-search",
]);

export function isIntentBoosted(intent: string | undefined): boolean {
  return intent !== undefined && INTENT_BOOSTED.has(intent);
}

function isMetadataIntent(intent: string): boolean {
  return intent === "project-metadata" || intent === "repository-overview";
}

function isCodeSearchIntent(intent: string): boolean {
  return intent === "targeted-code-search" || intent === "diagnostic-search";
}

export function weightsForIntent(intent: string | undefined): ScoringWeights {
  if (intent === undefined || !INTENT_BOOSTED.has(intent)) {
    return DEFAULT_SCORING_WEIGHTS;
  }
  const metadataIntent = isMetadataIntent(intent);
  const codeSearchIntent = isCodeSearchIntent(intent);
  const canonicalMetadata = metadataIntent ? 0.25 : 0.1;
  const structuralEdge = codeSearchIntent ? 0.2 : 0.1;
  const gitRecency = codeSearchIntent ? 0.12 : 0.06;
  const gitChurn = codeSearchIntent ? 0.08 : 0.04;
  return { ...DEFAULT_SCORING_WEIGHTS, canonicalMetadata, structuralEdge, gitRecency, gitChurn };
}

const SIGNAL_WEIGHT_KEYS: Readonly<Record<string, keyof ScoringWeights>> = {
  "provenance-best-score": "provenanceBestScore",
  "lexical-score": "lexicalScore",
  "semantic-score": "semanticScore",
  "provenance-count": "provenanceCount",
  "anchor-overlap": "anchorOverlap",
  "path-depth-affinity": "pathDepthAffinity",
  "test-pair-bonus": "testPairBonus",
  "stacktrace-position-bonus": "stacktracePositionBonus",
  "generated-penalty": "generatedPenalty",
  "canonical-metadata": "canonicalMetadata",
  "structural-edge": "structuralEdge",
  "git-recency": "gitRecency",
  "git-churn": "gitChurn",
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
    const weight = weights[key];
    if (weight === undefined) {
      continue;
    }
    raw += signal.value * weight;
  }
  return clampUnit(raw);
}
