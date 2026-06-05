// Quality Intelligence run plan + versioned run-event envelope (Epic #270, Issue #277).
//
// The run plan describes the deterministic stage sequence a QI run will execute. The
// run-event envelope is the wire-stable record of what actually happened. Both are
// versioned via the `eventSchemaVersion` literal so future evolutions land as new
// literal members rather than mutating "1" (same rule as MEMORY_SCHEMA_VERSION /
// CONNECTED_CONTEXT_SCHEMA_VERSION).
//
// Events carry a monotonic per-run `sequence` integer and an ISO 8601 `timestamp`.
// The runtime (#273) is responsible for assigning sequences in the order events are
// observed.

import type {
  QualityIntelligenceEvidenceAtomId,
  QualityIntelligenceRunId,
  QualityIntelligenceTestCaseId,
  QualityIntelligenceValidationFindingId,
} from "./ids.js";

export const QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION = 1 as const;

export type QualityIntelligencePlannerKind = "scripted" | "model-routed";

export const QUALITY_INTELLIGENCE_PLANNER_KINDS: readonly QualityIntelligencePlannerKind[] = [
  "scripted",
  "model-routed",
] as const;

export interface QualityIntelligenceRunStage {
  /** Stable stage name (e.g. "ingest", "design", "validate", "review"). */
  readonly name: string;
  /** Opaque descriptor identifier the runtime maps to a stage implementation. */
  readonly descriptor: string;
}

export interface QualityIntelligenceRunPlan {
  readonly id: QualityIntelligenceRunId;
  /** ISO 8601 timestamp. */
  readonly requestedAt: string;
  readonly plannerKind: QualityIntelligencePlannerKind;
  readonly stages: readonly QualityIntelligenceRunStage[];
}

// ─── Event payloads ────────────────────────────────────────────────────────────
export interface QualityIntelligenceRunQueuedPayload {
  readonly kind: "run:queued";
}

export interface QualityIntelligenceRunStartedPayload {
  readonly kind: "run:started";
}

export interface QualityIntelligenceStageStartedPayload {
  readonly kind: "stage:started";
  readonly stageName: string;
}

export interface QualityIntelligenceStageCompletedPayload {
  readonly kind: "stage:completed";
  readonly stageName: string;
}

export interface QualityIntelligenceStageFailedPayload {
  readonly kind: "stage:failed";
  readonly stageName: string;
  /** Non-secret single-sentence failure reason; producer-redacted. */
  readonly reasonSummary: string;
}

export interface QualityIntelligenceCandidateProposedPayload {
  readonly kind: "candidate:proposed";
  readonly candidateId: QualityIntelligenceTestCaseId;
  readonly derivedFromAtomIds: readonly QualityIntelligenceEvidenceAtomId[];
}

export interface QualityIntelligenceFindingRecordedPayload {
  readonly kind: "finding:recorded";
  readonly findingId: QualityIntelligenceValidationFindingId;
}

export interface QualityIntelligenceReviewRequestedPayload {
  readonly kind: "review:requested";
  readonly candidateId: QualityIntelligenceTestCaseId;
}

export interface QualityIntelligenceReviewCompletedPayload {
  readonly kind: "review:completed";
  readonly candidateId: QualityIntelligenceTestCaseId;
}

export interface QualityIntelligenceRunSucceededPayload {
  readonly kind: "run:succeeded";
}

export interface QualityIntelligenceRunFailedPayload {
  readonly kind: "run:failed";
  /** Non-secret single-sentence failure reason; producer-redacted. */
  readonly reasonSummary: string;
}

export interface QualityIntelligenceRunCancelledPayload {
  readonly kind: "run:cancelled";
}

export type QualityIntelligenceRunEventPayload =
  | QualityIntelligenceRunQueuedPayload
  | QualityIntelligenceRunStartedPayload
  | QualityIntelligenceStageStartedPayload
  | QualityIntelligenceStageCompletedPayload
  | QualityIntelligenceStageFailedPayload
  | QualityIntelligenceCandidateProposedPayload
  | QualityIntelligenceFindingRecordedPayload
  | QualityIntelligenceReviewRequestedPayload
  | QualityIntelligenceReviewCompletedPayload
  | QualityIntelligenceRunSucceededPayload
  | QualityIntelligenceRunFailedPayload
  | QualityIntelligenceRunCancelledPayload;

export type QualityIntelligenceRunEventKind = QualityIntelligenceRunEventPayload["kind"];

export const QUALITY_INTELLIGENCE_RUN_EVENT_KINDS: readonly QualityIntelligenceRunEventKind[] = [
  "run:queued",
  "run:started",
  "stage:started",
  "stage:completed",
  "stage:failed",
  "candidate:proposed",
  "finding:recorded",
  "review:requested",
  "review:completed",
  "run:succeeded",
  "run:failed",
  "run:cancelled",
] as const;

export interface QualityIntelligenceRunEvent {
  readonly eventSchemaVersion: typeof QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION;
  readonly runId: QualityIntelligenceRunId;
  /** Monotonic per-run non-negative integer. */
  readonly sequence: number;
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  readonly payload: QualityIntelligenceRunEventPayload;
}

/**
 * Assert sequence numbers in `events` are strictly increasing. Returns `void` on
 * success; throws `RangeError` on the first violation (including non-integer or
 * negative values).
 */
export const assertRunEventSequenceMonotonic = (
  events: readonly QualityIntelligenceRunEvent[],
): void => {
  let previous = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      throw new RangeError(`Run event[${String(index)}] is missing`);
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new RangeError(
        `Run event[${String(index)}] has invalid sequence ${String(event.sequence)}`,
      );
    }
    if (event.sequence <= previous) {
      throw new RangeError(
        `Run event[${String(index)}] sequence ${String(
          event.sequence,
        )} is not strictly greater than previous ${String(previous)}`,
      );
    }
    previous = event.sequence;
  }
};
