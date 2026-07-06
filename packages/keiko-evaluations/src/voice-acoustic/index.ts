// Public barrel for the offline acoustic-quality companion gate (P10).

export { runVoiceAcousticEvaluation } from "./runner.js";
export {
  aggregateVoiceAcousticMetrics,
  characterErrorRate,
  DEFAULT_VOICE_ACOUSTIC_BUDGETS,
  deriveVoiceAcousticMetrics,
  resolveVoiceAcousticBudgets,
  scoreVoiceAcousticFixture,
  wordErrorRate,
} from "./scorer.js";
export { renderVoiceAcousticSummary } from "./render.js";
export {
  ALL_VOICE_ACOUSTIC_FIXTURES,
  voiceAcousticFixtureByName,
  voiceAcousticFixturesForScenario,
} from "./fixtures/index.js";
export {
  VOICE_ACOUSTIC_EVAL_SCHEMA_VERSION,
  VOICE_ACOUSTIC_METRICS,
  VOICE_ACOUSTIC_SCENARIOS,
  type VoiceAcousticBudgets,
  type VoiceAcousticEvalSummary,
  type VoiceAcousticFixture,
  type VoiceAcousticFixturePolarity,
  type VoiceAcousticFixtureResult,
  type VoiceAcousticMetric,
  type VoiceAcousticMetricCheck,
  type VoiceAcousticMetrics,
  type VoiceAcousticMetricSummary,
  type VoiceAcousticProfile,
  type VoiceAcousticScenario,
  type VoiceAcousticScorecard,
  type VoiceAcousticTraceEvent,
  type VoiceAcousticTraceEventKind,
} from "./types.js";
