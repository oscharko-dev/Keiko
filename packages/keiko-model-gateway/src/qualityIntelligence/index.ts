// Public barrel for the Quality Intelligence sub-module of the model gateway
// (Epic #270, Issue #279). Re-exports the typed task profiles, the prompt-segmentation
// seam, the capability gate, the safe-error taxonomy, and (added in later milestones)
// the routing/budget/cancellation primitives and the dispatcher.

// ─── M1: task profiles ───────────────────────────────────────────────────────
export type {
  QualityIntelligenceCapability,
  QualityIntelligenceTaskProfile,
  QualityIntelligenceTaskProfileId,
} from "./taskProfiles.js";
export {
  QUALITY_INTELLIGENCE_TASK_PROFILES,
  getQualityIntelligenceTaskProfile,
  listQualityIntelligenceTaskProfiles,
} from "./taskProfiles.js";

// ─── M1: prompt segmentation ─────────────────────────────────────────────────
export type {
  QualityIntelligencePromptSegments,
  QualityIntelligenceUntrustedEvidenceInput,
  QualityIntelligenceUntrustedEvidenceKind,
} from "./promptSegmentation.js";
export { buildPromptSegments } from "./promptSegmentation.js";

// ─── M1: capability gate ─────────────────────────────────────────────────────
export { assertProfileCompatibleWithModel } from "./capabilityGate.js";

// ─── M1: safe-error taxonomy ─────────────────────────────────────────────────
export type {
  QualityIntelligenceBudgetExhaustedError,
  QualityIntelligenceCancelledError,
  QualityIntelligenceCapabilityMismatchError,
  QualityIntelligenceProviderError,
  QualityIntelligenceRedactionFailedError,
  QualityIntelligenceSafeError,
  QualityIntelligenceSafeErrorCode,
  QualityIntelligenceTimeoutError,
} from "./safeError.js";
export {
  QualityIntelligenceSafeErrorException,
  makeBudgetExhaustedError,
  makeCancelledError,
  makeCapabilityMismatchError,
  makeProviderError,
  makeRedactionFailedError,
  makeTimeoutError,
} from "./safeError.js";

// ─── M2: routing ─────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceModelRegistry,
  QualityIntelligenceSelectedModel,
} from "./routing.js";
export { selectModelForProfile } from "./routing.js";

// ─── M2: budget ──────────────────────────────────────────────────────────────
export type { QualityIntelligenceBudgetState } from "./budget.js";
export {
  createBudget,
  isExhausted,
  remainingBudget,
  releaseBudget,
  reserveBudget,
} from "./budget.js";

// ─── M2: circuit breaker ─────────────────────────────────────────────────────
export type {
  QualityIntelligenceCircuitBreakerConfig,
  QualityIntelligenceCircuitBreakerState,
  QualityIntelligenceCircuitEvent,
  QualityIntelligenceCircuitState,
} from "./circuitBreaker.js";
export {
  DEFAULT_QUALITY_INTELLIGENCE_CIRCUIT_BREAKER_CONFIG,
  createCircuitBreakerState,
  shouldAttempt,
  transitionOn,
} from "./circuitBreaker.js";

// ─── M2: replay cache ────────────────────────────────────────────────────────
export type { QualityIntelligenceReplayCachePort } from "./replayCache.js";
export { createInMemoryReplayCache, deriveReplayCacheKey, isCacheable } from "./replayCache.js";

// ─── M2: cancellation ────────────────────────────────────────────────────────
export type { QualityIntelligenceCancellationHandle } from "./cancellation.js";
export { composeCancellationSignal } from "./cancellation.js";

// ─── M3: dispatcher (port composition) ───────────────────────────────────────
export type {
  QualityIntelligenceDispatcherArgs,
  QualityIntelligenceDispatcherResult,
} from "./dispatcher.js";
export { dispatchQualityIntelligenceRequest } from "./dispatcher.js";
