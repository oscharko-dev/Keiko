// Public barrel for the Prompt Enhancer evaluation suite (Epic #1307, Issue #1315; ADR-0044 §6).
// Exposes the deterministic pipeline runner, the eight-dimension scorer, the suite runner, the
// scorecard renderer, the fixture registry, and the result/fixture types. Re-exported from the package
// barrel as a single auditable namespace (`PromptEnhancerEval`).

export { runEnhancement } from "./pipeline.js";
export { scorePromptQuality, aggregatePromptQuality } from "./scorer.js";
export { runPromptEnhancerEvaluation } from "./runner.js";
export { renderPromptEnhancerSummary } from "./render.js";
export {
  ALL_PROMPT_ENHANCER_FIXTURES,
  fixturesForCategory,
  promptEnhancerFixtureByName,
} from "./fixtures/index.js";
export {
  PROMPT_QUALITY_DIMENSIONS,
  PROMPT_ENHANCER_FIXTURE_CATEGORIES,
  PROMPT_ENHANCER_EVAL_SCHEMA_VERSION,
  type PromptQualityDimension,
  type PromptEnhancerFixtureCategory,
  type PromptEnhancerFixtureRequest,
  type PromptEnhancerOracle,
  type PromptEnhancerEvalFixture,
  type EnhancementObservation,
  type PromptQualityOutcome,
  type PromptQualityDimensionResult,
  type PromptEnhancerFixtureResult,
  type PromptQualityScorecardEntry,
  type PromptEnhancerEvalSummary,
  type PromptEnhancerScorecard,
} from "./types.js";
