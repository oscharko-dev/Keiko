// Activity Log evidence of the Keiko for Quality review runtime (ADR-0182 `review.run.*` and
// `review.finding.reported`, Issue #4135).
//
// Every field is a count, a closed outcome, a duration, an opaque id or a digest (ADR-0173 D4):
// never code, a prompt, model output, a path, a rules text or finding prose. Run ids are recorded
// as digests; the correlation id joins the lines of one review run.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ReviewFindingReport,
  ReviewProfileRefusalReason,
  ReviewReportAcknowledgement,
  ReviewRulesFileOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { CodingToolAction } from "../../coding-runtime/codingToolIpc.js";
import type { ServerLogSink } from "../../observability/index.js";
import { correlationIdOrUnknown } from "../../correlation.js";
import { reviewEvidenceDigest } from "../activity-log.js";

export type ReviewRuntimeStopTrigger = "idle" | "shutdown" | "start-failed";
export type ReviewRuntimeRefusalLayer = "tool-facade" | "catalog-bridge";

const REVIEW_RUN_RUNTIME_STARTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.run.runtime-started",
  category: "process",
  owner: "keiko-server",
  emitter: "review/runtime/activity-log.logReviewRuntimeStarted",
  fields: {
    runtimeInstanceId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 64 },
    toolProfile: { type: "string", dataClass: "closed-enum", required: true, values: ["review"] },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["review-runtime-lifecycle"],
  proofIds: ["review.run.runtime-started.line"],
  releaseImpact: "patch",
});

const REVIEW_RUN_RUNTIME_STOPPED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.run.runtime-stopped",
  category: "process",
  owner: "keiko-server",
  emitter: "review/runtime/activity-log.logReviewRuntimeStopped",
  fields: {
    runtimeInstanceId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 64 },
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["idle", "shutdown", "start-failed"],
    },
    idleDurationMs: { type: "integer", dataClass: "duration", required: true },
    runCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["review-runtime-lifecycle"],
  proofIds: ["review.run.runtime-stopped.line"],
  releaseImpact: "patch",
});

const REVIEW_RUN_PROFILE_REFUSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.run.profile-refused",
  category: "security",
  owner: "keiko-server",
  emitter: "review/runtime/activity-log.logReviewProfileRefused",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["review-profile-invalid", "native-profile", "authority-missing"],
    },
    layer: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["configuration", "tool-set", "authority", "facade", "profile"],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["review-runtime-profile"],
  proofIds: ["review.run.profile-refused.line"],
  releaseImpact: "patch",
});

const REVIEW_RUN_RULES_FILE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.run.rules-file",
  category: "process",
  owner: "keiko-server",
  emitter: "review/runtime/activity-log.logReviewRulesFile",
  fields: {
    runDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["loaded", "absent", "too-large", "not-utf8", "path-invalid", "read-failed"],
    },
    byteCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["review-rules-file"],
  proofIds: ["review.run.rules-file.line"],
  releaseImpact: "patch",
});

const REVIEW_RUN_ACTION_REFUSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.run.action-refused",
  category: "security",
  owner: "keiko-server",
  emitter: "review/runtime/activity-log.logReviewActionRefused",
  fields: {
    layer: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["tool-facade", "catalog-bridge"],
    },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "read",
        "discover",
        "search",
        "edit",
        "command",
        "verification",
        "git",
        "delivery",
        "connector",
        "egress",
        "skill",
        "skill-discover",
        "child-agent",
        "review-report",
      ],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["review-runtime-profile"],
  proofIds: ["review.run.action-refused.line"],
  releaseImpact: "patch",
});

const REVIEW_FINDING_REPORTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.finding.reported",
  category: "process",
  owner: "keiko-server",
  emitter: "review/runtime/activity-log.logReviewFindingReported",
  fields: {
    runDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "accepted",
        "schema-invalid",
        "path-outside-worktree",
        "range-invalid",
        "evidence-mismatch",
        "limit-reached",
      ],
    },
    acceptedCount: { type: "integer", dataClass: "count", required: false },
    findingCategory: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "correctness",
        "security",
        "reliability",
        "performance",
        "concurrency",
        "data-integrity",
        "test-gap",
        "maintainability",
      ],
    },
    severity: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["high", "medium", "low"],
    },
    evidenceCount: { type: "integer", dataClass: "count", required: false },
    fingerprintDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["review-finding-intake"],
  proofIds: ["review.finding.reported.line"],
  releaseImpact: "patch",
});

export function logReviewRuntimeStarted(
  log: ServerLogSink,
  correlationId: string | undefined,
  instanceId: string,
  durationMs: number,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_RUNTIME_STARTED,
      { correlationId: correlationIdOrUnknown(correlationId), durationMs },
      { runtimeInstanceId: instanceId, toolProfile: "review" },
    ),
  );
}

export interface ReviewRuntimeStoppedLine {
  readonly instanceId: string;
  readonly trigger: ReviewRuntimeStopTrigger;
  readonly idleDurationMs: number;
  readonly runCount: number;
}

export function logReviewRuntimeStopped(
  log: ServerLogSink,
  correlationId: string | undefined,
  line: ReviewRuntimeStoppedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_RUNTIME_STOPPED,
      {
        level: line.trigger === "start-failed" ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId),
      },
      {
        runtimeInstanceId: line.instanceId,
        trigger: line.trigger,
        idleDurationMs: Math.max(0, Math.round(line.idleDurationMs)),
        runCount: line.runCount,
      },
    ),
  );
}

export type ReviewProfileLayer = "configuration" | "tool-set" | "authority" | "facade" | "profile";

export function logReviewProfileRefused(
  log: ServerLogSink,
  correlationId: string | undefined,
  reason: ReviewProfileRefusalReason,
  layer: ReviewProfileLayer,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_PROFILE_REFUSED,
      {
        level: "error",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind: "authority-denied",
      },
      { reason, layer },
    ),
  );
}

export function logReviewRulesFile(
  log: ServerLogSink,
  runId: string,
  outcome: ReviewRulesFileOutcome | "read-failed",
  byteCount: number,
): void {
  const level = outcome === "loaded" || outcome === "absent" ? "info" : "warn";
  log.write(
    activityLogEvent(
      REVIEW_RUN_RULES_FILE,
      { level, correlationId: correlationIdOrUnknown(runId) },
      { runDigest: reviewEvidenceDigest("run", runId), outcome, byteCount },
    ),
  );
}

export function logReviewActionRefused(
  log: ServerLogSink,
  correlationId: string | undefined,
  layer: ReviewRuntimeRefusalLayer,
  action: CodingToolAction,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_ACTION_REFUSED,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind: "authority-denied",
      },
      { layer, action },
    ),
  );
}

/** The acknowledged report's body-free facts; prose, paths and line numbers never appear. */
export function logReviewFindingReported(
  log: ServerLogSink,
  runId: string,
  acknowledgement: ReviewReportAcknowledgement,
  accepted?: { readonly fingerprint: string; readonly report: ReviewFindingReport },
): void {
  log.write(
    activityLogEvent(
      REVIEW_FINDING_REPORTED,
      {
        level: acknowledgement.status === "accepted" ? "info" : "warn",
        correlationId: correlationIdOrUnknown(runId),
      },
      {
        runDigest: reviewEvidenceDigest("run", runId),
        outcome:
          acknowledgement.status === "rejected" ? acknowledgement.reason : acknowledgement.status,
        ...(acknowledgement.status === "accepted"
          ? { acceptedCount: acknowledgement.accepted }
          : {}),
        ...(accepted === undefined
          ? {}
          : {
              findingCategory: accepted.report.category,
              severity: accepted.report.severity,
              evidenceCount: accepted.report.evidence.length,
              fingerprintDigest: accepted.fingerprint,
            }),
      },
    ),
  );
}
