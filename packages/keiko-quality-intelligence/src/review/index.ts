// Public barrel for the Quality Intelligence review sub-namespace (Epic #270, Issue #282).
//
// Pure-domain review governance: state machine, lifecycle policy, four-eyes pairing
// guard, and the producer half of the audit-event envelope. No IO, no persistence,
// no clock — callers supply `at` timestamps and `by` actor labels.
//
// Consumers:
//   * Workflow runtime (#273) drives the state machine and emits audit events.
//   * Evidence layer (#274) and audit ledger persist the emitted events.
//   * UI (#280 follow-up) renders the resulting records.

export {
  applyReviewTransition,
  QualityIntelligenceReviewTransitionError,
  QUALITY_INTELLIGENCE_REVIEW_TRANSITION_EVENTS,
  type QualityIntelligenceReviewTransitionEvent,
  type QualityIntelligenceReviewTransitionErrorCode,
  type NextReviewState,
} from "./stateMachine.js";

export { isTerminalReviewState, canPairForFourEyes } from "./lifecyclePolicy.js";

export {
  assertFourEyesPair,
  QualityIntelligenceFourEyesViolationError,
  type QualityIntelligenceFourEyesViolationCode,
} from "./fourEyes.js";

export {
  buildReviewAuditEvent,
  transitionedPayloadFromNext,
  QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_SCHEMA_VERSION,
  QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_KINDS,
  type QualityIntelligenceReviewAuditEventKind,
  type QualityIntelligenceReviewOpenedPayload,
  type QualityIntelligenceReviewTransitionedPayload,
  type QualityIntelligenceReviewFourEyesPairedPayload,
  type QualityIntelligenceReviewTerminatedPayload,
  type QualityIntelligenceReviewAuditEventPayload,
  type QualityIntelligenceReviewAuditEvent,
  type BuildReviewAuditEventInput,
} from "./auditEvents.js";
