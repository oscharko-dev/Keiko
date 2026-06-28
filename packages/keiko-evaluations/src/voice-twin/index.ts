// Public barrel for the Voice Digital Twin evaluation suite (Epic #491, Issue #505 — the capstone;
// ADR-0068). Exposes the deterministic observation derivation, the eleven-dimension scorer, the suite
// runner, the scorecard renderer, the privacy / metric / profile / capability helpers, the fixture
// registry, and the result / fixture types. Re-exported from the package barrel as the `VoiceTwinEval`
// namespace, and proven by suite.test.ts.

export { deriveVoiceTwinObservation, runVoiceTwinEvaluation } from "./runner.js";
export { scoreVoiceTwinQuality, aggregateVoiceTwinQuality } from "./scorer.js";
export { renderVoiceTwinSummary } from "./render.js";
export {
  ALL_VOICE_PROFILES,
  VOICE_ENVIRONMENT_DESCRIPTORS,
  effectiveVoiceProfile,
  egressDestinationClassFor,
  localProfilesMatchContract,
  type VoiceEnvironmentDescriptor,
  type VoiceNetworkPosture,
} from "./profiles.js";
export { deriveCapabilityCell } from "./capability.js";
export {
  ALLOWED_MEDIA_RUNTIME,
  DENIED_MEDIA_PACKAGES,
  auditVoiceEgress,
  scanManifestsForDeniedMediaPackages,
} from "./privacy.js";
export {
  VOICE_TWIN_REPLAY_CAPACITY,
  deriveBufferBoundednessMetric,
  deriveEndOfTurnMetric,
  deriveInterruptionMetric,
  deriveLatencyClassMetric,
  deriveProviderFailureRecoveryMetric,
  deriveTranscriptCorrectionMetric,
} from "./metrics.js";
export {
  ALL_VOICE_TWIN_FIXTURES,
  voiceTwinFixturesForCategory,
  voiceTwinFixtureByName,
} from "./fixtures/index.js";
export {
  VOICE_TWIN_EVAL_SCHEMA_VERSION,
  VOICE_TWIN_DIMENSIONS,
  VOICE_TWIN_FIXTURE_CATEGORIES,
  VOICE_ENVIRONMENT_PROFILES,
  type VoiceTwinDimension,
  type VoiceEnvironmentProfile,
  type VoiceTwinFixtureCategory,
  type EgressDestinationClass,
  type VoiceTwinOracle,
  type VoiceTwinManifestFixture,
  type VoiceTwinEgressDestination,
  type VoiceTwinFixture,
  type VoiceTwinCapabilityCell,
  type InterruptionMetricRecord,
  type EndOfTurnMetricRecord,
  type TranscriptCorrectionMetricRecord,
  type ProviderFailureRecoveryMetricRecord,
  type BufferBoundednessMetricRecord,
  type LatencyClassMetricRecord,
  type VoiceTwinMetricBundle,
  type VoiceTwinEgressAudit,
  type VoiceTwinDeniedManifestHit,
  type VoiceTwinManifestScan,
  type VoiceTwinObservation,
  type VoiceTwinOutcome,
  type VoiceTwinDimensionResult,
  type VoiceTwinFixtureResult,
  type VoiceTwinScorecardEntry,
  type VoiceTwinMatrixCell,
  type VoiceTwinEvalSummary,
  type VoiceTwinScorecard,
} from "./types.js";
