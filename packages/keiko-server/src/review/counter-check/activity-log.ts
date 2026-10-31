// Activity Log evidence of the Keiko for Quality counter-check (ADR-0182 `review.counter-check.*`,
// Issue #4136). Each counter-check session has its own correlation id and points at its review
// run through `parentCorrelationId`. Every field is a closed value, a count, a duration or a digest
// (ADR-0173 D4): never finding prose, code, a prompt, model output or a path.

import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { CounterCheckVerdict } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";

import type { ServerLogSink } from "../../observability/index.js";
import { reviewEvidenceDigest } from "../activity-log.js";

// Literal copies of the contract vocabularies (the op-catalog generator reads registrations as
// closed literals); `activity-log.test.ts` pins them to `COUNTER_CHECK_VERDICTS` and
// `COUNTER_CHECK_REASON_CODES`.
export const COUNTER_CHECK_LOG_VERDICTS = ["confirmed", "refuted", "undecided"] as const;
export const COUNTER_CHECK_LOG_REASON_CODES = [
  "defect-reproduced-in-code",
  "cause-not-in-change",
  "guarded-elsewhere",
  "evidence-mismatch",
  "insufficient-context",
  "out-of-budget",
] as const;

/** What a counter-check's ending means for its run's settlement. */
const COUNTER_CHECK_EFFECTS = [
  "none",
  "budget-exhausted",
  "deadline-exceeded",
  "model-failed",
  "cancelled",
] as const;
export type CounterCheckEffect = (typeof COUNTER_CHECK_EFFECTS)[number];

/** Closed failure classes of a counter-check session that did not end normally. */
const COUNTER_CHECK_FAILURE_CLASSES = [
  "model-unavailable",
  "model-failed",
  "budget-exhausted",
  "deadline-exceeded",
  "cancelled",
  "governance-denied",
] as const;
export type CounterCheckFailureClass = (typeof COUNTER_CHECK_FAILURE_CLASSES)[number];

const COUNTER_CHECK_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  owner: "keiko-server",
  causal: "parent-correlation",
  releaseImpact: "patch",
  failureClasses: ["review-counter-check"],
} as const;

const SESSION_FIELDS = {
  fingerprintDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  toolCallCount: { type: "integer", dataClass: "count", required: true },
  durationMs: { type: "integer", dataClass: "duration", required: true },
} as const;

const REVIEW_COUNTER_CHECK_COMPLETED = defineActivityLogOperation({
  ...COUNTER_CHECK_OPERATION_BASE,
  op: "review.counter-check.completed",
  category: "process",
  emitter: "review/counter-check/activity-log.logCounterCheckCompleted",
  fields: {
    ...SESSION_FIELDS,
    verdict: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: COUNTER_CHECK_LOG_VERDICTS,
    },
    reasonCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: COUNTER_CHECK_LOG_REASON_CODES,
    },
    effect: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: COUNTER_CHECK_EFFECTS,
    },
    evidenceInHead: { type: "boolean", dataClass: "closed-enum", required: true },
    promptTokens: { type: "integer", dataClass: "count", required: true },
    completionTokens: { type: "integer", dataClass: "count", required: true },
  },
  lifecycle: "end",
  analyzerProjection: "timeline",
  proofIds: ["review.counter-check.completed.line"],
});

const REVIEW_COUNTER_CHECK_FAILED = defineActivityLogOperation({
  ...COUNTER_CHECK_OPERATION_BASE,
  op: "review.counter-check.failed",
  category: "process",
  emitter: "review/counter-check/activity-log.logCounterCheckFailed",
  fields: {
    ...SESSION_FIELDS,
    failureClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: COUNTER_CHECK_FAILURE_CLASSES,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  proofIds: ["review.counter-check.failed.line"],
});

export interface CounterCheckSessionFacts {
  readonly correlationId: string;
  readonly runCorrelationId: string;
  readonly fingerprint: string;
  readonly toolCallCount: number;
  readonly durationMs: number;
}

function sessionFields(facts: CounterCheckSessionFacts): {
  readonly fingerprintDigest: string;
  readonly toolCallCount: number;
  readonly durationMs: number;
} {
  return {
    fingerprintDigest: reviewEvidenceDigest("fingerprint", facts.fingerprint),
    toolCallCount: facts.toolCallCount,
    durationMs: Math.max(0, Math.round(facts.durationMs)),
  };
}

export function logCounterCheckCompleted(
  log: ServerLogSink,
  facts: CounterCheckSessionFacts,
  outcome: {
    readonly verdict: CounterCheckVerdict;
    readonly effect: CounterCheckEffect;
    readonly evidenceInHead: boolean;
    readonly promptTokens: number;
    readonly completionTokens: number;
  },
): void {
  log.write(
    activityLogEvent(
      REVIEW_COUNTER_CHECK_COMPLETED,
      {
        correlationId: facts.correlationId,
        parentCorrelationId: facts.runCorrelationId,
        level: outcome.effect === "none" ? "info" : "warn",
      },
      {
        ...sessionFields(facts),
        verdict: outcome.verdict.verdict,
        reasonCode: outcome.verdict.reasonCode,
        effect: outcome.effect,
        evidenceInHead: outcome.evidenceInHead,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
      },
    ),
  );
}

const FAILURE_ERROR_KINDS: Readonly<Record<CounterCheckFailureClass, ActivityLogErrorKind>> = {
  "model-unavailable": "unavailable",
  "model-failed": "unavailable",
  "budget-exhausted": "rate-limited",
  "deadline-exceeded": "timeout",
  cancelled: "cancelled",
  "governance-denied": "authority-denied",
};

export function logCounterCheckFailed(
  log: ServerLogSink,
  facts: CounterCheckSessionFacts,
  failureClass: CounterCheckFailureClass,
  error: unknown,
): void {
  log.write(
    activityLogEvent(
      REVIEW_COUNTER_CHECK_FAILED,
      {
        correlationId: facts.correlationId,
        parentCorrelationId: facts.runCorrelationId,
        level: "warn",
        errorKind: FAILURE_ERROR_KINDS[failureClass],
      },
      {
        ...sessionFields(facts),
        failureClass,
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}
