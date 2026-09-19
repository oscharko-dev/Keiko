import {
  PR_DESCRIPTION_APPLICATION_REASON_STATES,
  PR_DESCRIPTION_APPLICATION_MAX_AGE_MS,
  type PrDescriptionApplicationBinding,
  type PrDescriptionApplicationStatus,
  type PrDescriptionApplicationCompleteness,
  type PrDescriptionApplicationReason,
  type PrDescriptionApplicationEffect,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorKindOf } from "../observability/server-log.js";
import {
  gitDeliveryActivityCode,
  gitDeliveryActivityErrorKind,
  gitDeliveryActivityFailureKind,
} from "./execution.js";
import {
  PrDescriptionFailure,
  type PrDescriptionContext,
  type PrDescriptionFailureDetail,
  type PrDescriptionServiceOptions,
} from "./prDescriptionTypes.js";

const PR_DESCRIPTION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.pr-description",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/prDescriptionProjection.logDescription",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["preview", "approval", "apply", "reconcile"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "applied",
        "reconciled",
        "partial-applied",
        "fallback-applied",
        "approval-required",
        "approval-invalid",
        "authority-denied",
        "receipt-refused",
        "policy-blocked",
        "invalid-request",
        "malformed-region",
        "unsafe-content",
        "stale-pr",
        "stale-snapshot",
        "body-changed",
        "expired",
        "provider-failed",
        "recovery-required",
        "unchanged-after-write",
      ],
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["current", "partial", "fallback", "blocked", "stale", "failed"],
    },
    effect: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["none", "confirmed", "reconciled", "uncertain"],
    },
    snapshotDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    artifactDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    bodyDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    detail: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "adapter-unavailable",
        "read-already-exists",
        "read-base-missing",
        "read-head-unpublished",
        "read-validation-error",
        "read-permission-denied",
        "read-not-found",
        "read-rate-limited",
        "read-provider-unavailable",
        "read-unknown",
        "read-invalid-response",
        "read-body-invalid",
      ],
    },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
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
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-pr-description"],
  proofIds: ["git.pr-description.emitted-line"],
  releaseImpact: "patch",
});

export function applicationStatus(
  binding: PrDescriptionApplicationBinding,
  completeness: PrDescriptionApplicationCompleteness,
  reason: PrDescriptionApplicationReason,
  effect: PrDescriptionApplicationEffect,
  now: number,
): PrDescriptionApplicationStatus {
  return {
    schemaVersion: "1",
    binding,
    completeness,
    reason,
    state: PR_DESCRIPTION_APPLICATION_REASON_STATES[reason],
    effect,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PR_DESCRIPTION_APPLICATION_MAX_AGE_MS).toISOString(),
    concurrency: "read-check-write-verify",
  };
}
export function descriptionFailureReason(error: unknown): PrDescriptionApplicationReason {
  return error instanceof PrDescriptionFailure ? error.reason : "provider-failed";
}
/** The closed detail word a `PrDescriptionFailure` carries behind its generic reason, if any. */
function failureDetail(error: unknown): { readonly detail?: PrDescriptionFailureDetail } {
  return error instanceof PrDescriptionFailure && error.detail !== undefined
    ? { detail: error.detail }
    : {};
}

function descriptionFailureFields(error: unknown): Record<string, unknown> {
  const description = describeError(error);
  const code = gitDeliveryActivityCode(description.code);
  return {
    errorClass: description.errorClass,
    ...(code === undefined ? {} : { code }),
    ...(description.frames === undefined ? {} : { frames: description.frames }),
    ...(description.causeChain === undefined ? {} : { causeChain: description.causeChain }),
  };
}

function descriptionStatusFields(status: PrDescriptionApplicationStatus): Record<string, unknown> {
  return {
    state: status.state,
    effect: status.effect,
    snapshotDigest: status.binding.snapshotDigest,
    artifactDigest: status.binding.draftDigest,
    bodyDigest: status.binding.finalBodyDigest,
  };
}
export function logDescription(
  options: PrDescriptionServiceOptions,
  context: PrDescriptionContext,
  phase: "preview" | "approval" | "apply" | "reconcile",
  reason: PrDescriptionApplicationReason,
  status?: PrDescriptionApplicationStatus,
  error?: unknown,
): void {
  const failureKind =
    error === undefined ? undefined : gitDeliveryActivityFailureKind(errorKindOf(error));
  (options.execution.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      PR_DESCRIPTION_OPERATION,
      {
        correlationId: context.correlationId,
        ...(failureKind === undefined
          ? {}
          : { level: "warn", errorKind: gitDeliveryActivityErrorKind(failureKind) }),
      },
      {
        phase,
        reason,
        ...(status === undefined ? {} : descriptionStatusFields(status)),
        ...(failureKind === undefined ? {} : { failureKind }),
        ...(error === undefined ? {} : descriptionFailureFields(error)),
        ...failureDetail(error),
      },
    ),
  );
}
