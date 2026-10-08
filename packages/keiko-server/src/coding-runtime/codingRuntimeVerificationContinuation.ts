import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { describeError } from "../diagnostics-log.js";

export const VERIFICATION_CONTINUATION_MAX = 2;
export const VERIFICATION_CONTINUATION_INTENT =
  "Verification is not complete for the accepted task. Continue within its original scope and authority: inspect the latest governed verification result, read the relevant source and test files, repair the diagnosed cause without weakening assertions, and rerun the same smallest relevant verification. A nonempty verification must pass after the final edit before you claim completion. If authority or the test environment prevents verification, explain the blocker accurately; do not claim success.";

type ContinuationState =
  "continued" | "dispatch-refused" | "dispatch-threw" | "run-superseded" | "not-evidenced";

const VERIFICATION_CONTINUATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.verification-continuation",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeVerificationContinuation.recordVerificationContinuation",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    attempt: { type: "integer", dataClass: "count", required: true },
    max: { type: "integer", dataClass: "count", required: true },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "continued",
        "dispatch-refused",
        "dispatch-threw",
        "run-superseded",
        "not-evidenced",
      ],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-verification"],
  proofIds: ["coding-runtime.run.verification-continuation.emitted-line"],
  releaseImpact: "patch",
});

export function recordVerificationContinuation(
  activityLog: ServerLogSink | undefined,
  runId: string,
  attempt: number,
  state: ContinuationState,
  error?: unknown,
): void {
  activityLog?.write(
    activityLogEvent(
      VERIFICATION_CONTINUATION_OPERATION,
      {
        correlationId: isValidCorrelationId(runId) ? runId : UNKNOWN_CORRELATION_ID,
        level: state === "continued" ? "info" : "warn",
        ...(state === "continued" ? {} : { errorKind: continuationErrorKind(state) }),
      },
      {
        runId,
        attempt,
        max: VERIFICATION_CONTINUATION_MAX,
        state,
        ...(error === undefined ? {} : continuationErrorFields(error)),
      },
    ),
  );
}

function continuationErrorFields(error: unknown): {
  readonly errorClass: string;
  readonly code?: string;
  readonly causeChain?: readonly string[];
  readonly frames?: readonly string[];
} {
  const description = describeError(error);
  return {
    errorClass: description.errorClass,
    ...(description.code === undefined ? {} : { code: description.code }),
    ...(description.causeChain === undefined ? {} : { causeChain: description.causeChain }),
    ...(description.frames === undefined ? {} : { frames: description.frames }),
  };
}

function continuationErrorKind(
  state: Exclude<ContinuationState, "continued">,
): ActivityLogErrorKind {
  if (state === "run-superseded") return "conflict";
  return state === "not-evidenced" ? "validation-failed" : "unavailable";
}
