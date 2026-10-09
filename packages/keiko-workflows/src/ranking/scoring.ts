// Weighted scoring composition for ranked candidates (Epic #177, Issue #182).
// Pure function: signal vector × weight vector → clamped unit score. The generated penalty
// weight is 0.30; the filter layer's `omitGenerated` default excludes generated files regardless
// of score. Exact paths, directory segments and basenames contribute independent weighted signals.
// The weight table derives normalization headroom while preserving the configured definition
// share. Callers may override weights to tune ring-specific behaviour.

import type { ExtractedSignals } from "./signals.js";

export interface ScoringWeights {
  readonly provenanceBestScore: number;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly provenanceCount: number;
  readonly anchorOverlap: number;
  readonly pathDepthAffinity: number;
  readonly exactPathMatch?: number;
  readonly pathSegmentAffinity?: number;
  readonly basenameMatch?: number;
  readonly testPairBonus: number;
  readonly stacktracePositionBonus: number;
  readonly generatedPenalty: number;
  // Intent-conditioned signals (enterprise retrieval M4). OPTIONAL so existing weight literals stay
  // valid; weight 0 / undefined ⇒ inert (computeScore
  // skips an absent weight). Non-zero only for the intents weightsForIntent boosts.
  readonly canonicalMetadata?: number;
  readonly structuralEdge?: number;
  readonly symbolDefinition?: number;
  readonly gitRecency?: number;
  readonly gitChurn?: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  provenanceBestScore: 0.35,
  semanticScore: 0.25,
  provenanceCount: 0.1,
  anchorOverlap: 0.25,
  pathDepthAffinity: 0.1,
  exactPathMatch: 0.3,
  pathSegmentAffinity: 0.15,
  basenameMatch: 0.1,
  testPairBonus: 0.1,
  stacktracePositionBonus: 0.05,
  generatedPenalty: 0.3,
} as const;

// Intent-conditioned weight overrides (M4). Only the named intents receive non-default weights for
// canonical-metadata / structural-edge and path signals; every other intent (and the no-intent
// default path) returns DEFAULT_SCORING_WEIGHTS verbatim.
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

function pathWeights(
  codeSearchIntent: boolean,
): Pick<ScoringWeights, "exactPathMatch" | "pathSegmentAffinity" | "basenameMatch"> {
  return {
    exactPathMatch: codeSearchIntent ? 0.4 : 0.1,
    pathSegmentAffinity: codeSearchIntent ? 0.2 : 0.1,
    basenameMatch: codeSearchIntent ? 0.1 : 0.05,
  };
}

export function weightsForIntent(intent: string | undefined): ScoringWeights {
  if (intent === undefined || !INTENT_BOOSTED.has(intent)) {
    return DEFAULT_SCORING_WEIGHTS;
  }
  const metadataIntent = isMetadataIntent(intent);
  const codeSearchIntent = isCodeSearchIntent(intent);
  const canonicalMetadata = metadataIntent ? 0.25 : 0.1;
  const structuralEdge = codeSearchIntent ? 0.2 : 0.1;
  const symbolDefinition = codeSearchIntent ? 0.3 : 0.05;
  const gitRecency = codeSearchIntent ? 0.12 : 0.06;
  const gitChurn = codeSearchIntent ? 0.08 : 0.04;
  return {
    ...DEFAULT_SCORING_WEIGHTS,
    ...pathWeights(codeSearchIntent),
    canonicalMetadata,
    structuralEdge,
    symbolDefinition,
    gitRecency,
    gitChurn,
  };
}

const SIGNAL_WEIGHT_KEYS: Readonly<Record<string, keyof ScoringWeights>> = {
  "provenance-best-score": "provenanceBestScore",
  "lexical-score": "lexicalScore",
  "semantic-score": "semanticScore",
  "provenance-count": "provenanceCount",
  "anchor-overlap": "anchorOverlap",
  "path-depth-affinity": "pathDepthAffinity",
  "exact-path-match": "exactPathMatch",
  "path-segment-affinity": "pathSegmentAffinity",
  "basename-match": "basenameMatch",
  "test-pair-bonus": "testPairBonus",
  "stacktrace-position-bonus": "stacktracePositionBonus",
  "generated-penalty": "generatedPenalty",
  "canonical-metadata": "canonicalMetadata",
  "structural-edge": "structuralEdge",
  "symbol-definition": "symbolDefinition",
  "git-recency": "gitRecency",
  "git-churn": "gitChurn",
};

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function positiveWeightTotal(weights: ScoringWeights): number {
  let total = 0;
  for (const key of Object.keys(weights) as (keyof ScoringWeights)[]) {
    if (key !== "generatedPenalty") total += Math.max(0, weights[key] ?? 0);
  }
  return total;
}

function normalizeNonDefinitionScore(raw: number, weights: ScoringWeights): number {
  const definitionWeight = Math.max(0, weights.symbolDefinition ?? 0);
  if (definitionWeight === 0) return raw;
  const headroom = Math.max(0, 1 - Math.min(1, definitionWeight));
  if (headroom === 0) return 0;
  const nonDefinitionTotal = positiveWeightTotal(weights) - definitionWeight;
  if (nonDefinitionTotal <= headroom) return raw;
  return (raw * headroom) / nonDefinitionTotal;
}

export function computeScore(
  signals: ExtractedSignals,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  let nonDefinitionRaw = 0;
  let definitionContribution = 0;
  let generatedPenalty = 0;
  for (const signal of signals.signals) {
    const key = SIGNAL_WEIGHT_KEYS[signal.name];
    if (key === undefined) {
      continue;
    }
    const weight = weights[key];
    if (weight === undefined) {
      continue;
    }
    const contribution = signal.value * weight;
    if (signal.name === "generated-penalty") {
      generatedPenalty += contribution;
    } else if (signal.name === "symbol-definition") {
      definitionContribution += contribution;
    } else {
      nonDefinitionRaw += contribution;
    }
  }
  // A boosted definition keeps its configured share. The remaining positive vector is normalized
  // only into the headroom left by that share, preventing saturation from erasing the definition
  // distinction. Weights without a positive definition retain the historical scoring path.
  return clampUnit(
    normalizeNonDefinitionScore(nonDefinitionRaw, weights) +
      definitionContribution +
      generatedPenalty,
  );
}

// The floor reserves 90% of the full lexical contribution alone, computed through the same
// normalization as the score. Targeted intent: provenance weight .35, definition headroom .70,
// non-definition positive total 2.40 => full lexical baseline .10208, floor .091875. A depth-six
// full hit adds depth/count evidence and clears this; a half-hit shallow decoy remains below it.
export function absoluteRelevanceFloor(weights: ScoringWeights): number {
  return (
    0.9 *
    computeScore(
      {
        scopePath: "",
        baseScore: 0,
        generatedHint: false,
        signals: [
          { name: "provenance-best-score", value: 1 },
          { name: "lexical-score", value: 1 },
        ],
      },
      weights,
    )
  );
}
