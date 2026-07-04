// Public barrel for the Voice Action Governance evaluation suite (Epic #491, Issue #503; ADR-0108).
// Exposes the deterministic observation derivation, the six-dimension scorer, the suite runner, the
// scorecard renderer, the fixture registry, and the result/fixture types. Self-contained: it is NOT
// re-exported from the package barrel (the discussion suite is likewise self-contained), so this
// security suite stands alone and is proven by suite.test.ts.

export { deriveVoiceActionObservation, runVoiceActionEvaluation } from "./runner.js";
export { scoreVoiceActionQuality, aggregateVoiceActionQuality } from "./scorer.js";
export { renderVoiceActionSummary } from "./render.js";
export {
  ALL_VOICE_ACTION_FIXTURES,
  voiceActionFixturesForCategory,
  voiceActionFixtureByName,
} from "./fixtures/index.js";
export {
  VOICE_ACTION_DIMENSIONS,
  VOICE_ACTION_FIXTURE_CATEGORIES,
  VOICE_ACTION_EVAL_SCHEMA_VERSION,
  type VoiceActionDimension,
  type VoiceActionFixtureCategory,
  type VoiceActionOracle,
  type VoiceActionEvalFixture,
  type VoiceActionStalenessTrajectory,
  type VoiceActionObservation,
  type VoiceActionOutcome,
  type VoiceActionDimensionResult,
  type VoiceActionFixtureResult,
  type VoiceActionScorecardEntry,
  type VoiceActionEvalSummary,
  type VoiceActionScorecard,
} from "./types.js";
