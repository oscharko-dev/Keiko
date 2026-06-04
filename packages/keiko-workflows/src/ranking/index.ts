// Public sub-barrel for deterministic hybrid candidate ranking and negative context
// filtering (Epic #177, Issue #182). External consumers import every ranking symbol
// through this module; internal modules (signals.ts, scoring.ts, filter.ts, rank.ts)
// remain implementation detail.

export type { ExtractedSignals, RankingHints, RankingInput } from "./signals.js";
export { DEFAULT_GENERATED_PATTERNS, extractSignals } from "./signals.js";

export type { ScoringWeights } from "./scoring.js";
export { DEFAULT_SCORING_WEIGHTS, computeScore } from "./scoring.js";

export type { AnnotatedCandidate, FilterOptions, FilterResult } from "./filter.js";
export { DEFAULT_FILTER_OPTIONS, filterCandidates } from "./filter.js";

export type { RankingDiagnostics, RankingOptions, RankingResult } from "./rank.js";
export { rankCandidates } from "./rank.js";
