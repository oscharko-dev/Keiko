// Public barrel for the Discussion Intelligence evaluation suite (Epic #491, Issue #502; ADR-0065).
// Exposes the deterministic observation derivation, the seven-dimension scorer, the suite runner, the
// scorecard renderer, the fixture registry, and the result/fixture types. Re-exported from the package
// barrel as a single auditable namespace (`DiscussionEval`), mirroring `PromptEnhancerEval`.

export { deriveDiscussionObservation, runDiscussionEvaluation } from "./runner.js";
export { scoreDiscussionQuality, aggregateDiscussionQuality } from "./scorer.js";
export { renderDiscussionSummary } from "./render.js";
export {
  ALL_DISCUSSION_FIXTURES,
  discussionFixturesForCategory,
  discussionFixtureByName,
} from "./fixtures/index.js";
export {
  DISCUSSION_QUALITY_DIMENSIONS,
  DISCUSSION_FIXTURE_CATEGORIES,
  DISCUSSION_EVAL_SCHEMA_VERSION,
  type DiscussionQualityDimension,
  type DiscussionFixtureCategory,
  type DiscussionOracle,
  type DiscussionEvalFixture,
  type DiscussionRecoveryTrajectory,
  type DiscussionObservation,
  type DiscussionQualityOutcome,
  type DiscussionDimensionResult,
  type DiscussionFixtureResult,
  type DiscussionScorecardEntry,
  type DiscussionEvalSummary,
  type DiscussionScorecard,
} from "./types.js";
