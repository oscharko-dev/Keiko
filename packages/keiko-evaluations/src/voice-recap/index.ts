// Public barrel for the Voice Session Recap evaluation suite (Epic #491, Issue #504; ADR-0067). Exposes the
// deterministic observation derivation, the seven-dimension scorer, the suite runner, the scorecard
// renderer, the fixture registry, the content-free candidate model, and the result/fixture types.
// Re-exported from the package barrel as a single auditable namespace (`VoiceRecapEval`), mirroring the
// `DiscussionEval` convention.

export { deriveVoiceRecapObservation, runVoiceRecapEvaluation } from "./runner.js";
export { scoreVoiceRecapQuality, aggregateVoiceRecapQuality } from "./scorer.js";
export { renderVoiceRecapSummary } from "./render.js";
export { committedTextEmbedsSecret, deriveCandidateOutcome } from "./candidate-model.js";
export {
  ALL_VOICE_RECAP_FIXTURES,
  voiceRecapFixturesForCategory,
  voiceRecapFixtureByName,
} from "./fixtures/index.js";
export {
  VOICE_RECAP_DIMENSIONS,
  VOICE_RECAP_FIXTURE_CATEGORIES,
  VOICE_RECAP_EVAL_SCHEMA_VERSION,
  type VoiceRecapDimension,
  type VoiceRecapFixtureCategory,
  type VoiceRecapUserSpan,
  type VoiceRecapAssistantSpan,
  type VoiceRecapOracle,
  type VoiceRecapEvalFixture,
  type VoiceRecapCandidateVerdict,
  type VoiceRecapCandidateOutcome,
  type VoiceRecapObservation,
  type VoiceRecapOutcome,
  type VoiceRecapDimensionResult,
  type VoiceRecapFixtureResult,
  type VoiceRecapScorecardEntry,
  type VoiceRecapEvalSummary,
  type VoiceRecapScorecard,
} from "./types.js";
