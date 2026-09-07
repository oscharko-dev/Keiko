import {
  PR_DESCRIPTION_APPLICATION_REASON_STATES,
  PR_DESCRIPTION_APPLICATION_MAX_AGE_MS,
  type PrDescriptionApplicationBinding,
  type PrDescriptionApplicationStatus,
  type PrDescriptionApplicationCompleteness,
  type PrDescriptionApplicationReason,
  type PrDescriptionApplicationEffect,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorKindOf } from "../observability/server-log.js";
import {
  PrDescriptionFailure,
  type PrDescriptionContext,
  type PrDescriptionServiceOptions,
} from "./prDescriptionTypes.js";

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
export function logDescription(
  options: PrDescriptionServiceOptions,
  context: PrDescriptionContext,
  phase: "preview" | "approval" | "apply" | "reconcile",
  reason: PrDescriptionApplicationReason,
  status?: PrDescriptionApplicationStatus,
  error?: unknown,
): void {
  (options.execution.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.pr-description",
    correlationId: context.correlationId,
    ...(error === undefined ? {} : { level: "warn", errorKind: errorKindOf(error) }),
    extra: {
      phase,
      reason,
      state: status?.state,
      effect: status?.effect,
      snapshotDigest: status?.binding.snapshotDigest,
      artifactDigest: status?.binding.draftDigest,
      bodyDigest: status?.binding.finalBodyDigest,
      ...(error === undefined ? {} : describeError(error)),
    },
  });
}
