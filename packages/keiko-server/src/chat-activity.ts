import type { ModelKind } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger, type ServerLogSink } from "./observability/index.js";

type ObservedModelKind = ModelKind | "unknown";
export type ChatRejectionReason = "readiness" | "generation" | "grounding-scope";
export type GitChangeDescriptionTurnDenial = "authority-expired" | "model-egress-denied";
export type GitChangeDescriptionTargetDenial =
  "repository-unavailable" | "reader-unauthorized" | "remote-unresolved";

export interface ChatTurnActivityFields {
  readonly messageCount: number;
  readonly systemCount: number;
  readonly userCount: number;
  readonly assistantCount: number;
  readonly toolCount: number;
  readonly imageAttachmentCount: number;
  readonly imageAttachmentBytes: number;
}

const CHAT_CREATION_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.creation.rejected",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-activity.logChatCreationRejectionEvent",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["readiness", "configuration"],
    },
    modelKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat", "embedding", "ocr-vision", "voice", "unknown"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["chat-admission"],
  proofIds: ["chat.creation.rejected.reason"],
  releaseImpact: "patch",
});

const CHAT_SEND_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.send.rejected",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-activity.logChatRejectionEvent.send",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["readiness", "generation", "grounding-scope"],
    },
    modelKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat", "embedding", "ocr-vision", "voice", "unknown"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["chat-admission"],
  proofIds: ["chat.send.rejected.reason"],
  releaseImpact: "patch",
});

const CHAT_REGENERATION_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.regeneration.rejected",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-activity.logChatRejectionEvent.regeneration",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["readiness", "generation", "grounding-scope"],
    },
    modelKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat", "embedding", "ocr-vision", "voice", "unknown"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["chat-admission"],
  proofIds: ["chat.regeneration.rejected.reason"],
  releaseImpact: "patch",
});

const CHAT_TURN_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.turn.started",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-activity.logChatTurnStartedEvent",
  fields: {
    messageCount: { type: "integer", dataClass: "count", required: true },
    systemCount: { type: "integer", dataClass: "count", required: true },
    userCount: { type: "integer", dataClass: "count", required: true },
    assistantCount: { type: "integer", dataClass: "count", required: true },
    toolCount: { type: "integer", dataClass: "count", required: true },
    imageAttachmentCount: { type: "integer", dataClass: "count", required: true },
    imageAttachmentBytes: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["chat-turn"],
  proofIds: ["chat.turn.started.shape"],
  releaseImpact: "patch",
});

const PR_DESCRIPTION_CHAT_TURN_ADMITTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "pr-description.chat.turn.admitted",
  category: "security",
  owner: "keiko-server",
  emitter: "chat-activity.logGitChangeTurnAuthorityEvent.admitted",
  fields: {
    relationshipId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["pr-description-chat-authority"],
  proofIds: ["pr-description.chat.turn.admitted.relationship"],
  releaseImpact: "patch",
});

const PR_DESCRIPTION_CHAT_TURN_DENIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "pr-description.chat.turn.denied",
  category: "security",
  owner: "keiko-server",
  emitter: "chat-activity.logGitChangeTurnAuthorityEvent.denied",
  fields: {
    relationshipId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["authority-expired", "model-egress-denied"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["pr-description-chat-authority"],
  proofIds: ["pr-description.chat.turn.denied.reason"],
  releaseImpact: "patch",
});

const GIT_CHANGE_DESCRIPTION_TARGET_DENIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git-change.chat.description-target.denied",
  category: "security",
  owner: "keiko-server",
  emitter: "chat-activity.gitChangeDescriptionTargetDeniedEvent",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["repository-unavailable", "reader-unauthorized", "remote-unresolved"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-change-description-target"],
  proofIds: ["git-change.chat.description-target.denied.reason"],
  releaseImpact: "patch",
});

const GIT_CHANGE_CHAT_APPLY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git-change.chat.apply",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-activity.gitChangeApplyEvent",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["preview", "observed", "blocked"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-change-description-apply"],
  proofIds: ["git-change.chat.apply.outcome"],
  releaseImpact: "patch",
});

function rejectionErrorKind(reason: ChatRejectionReason): ActivityLogErrorKind {
  return reason === "readiness" ? "unavailable" : "conflict";
}

export function logChatCreationRejectionEvent(input: {
  readonly correlationId: string | undefined;
  readonly status: number;
  readonly reason: "readiness" | "configuration";
  readonly modelKind: ObservedModelKind;
}): void {
  getServerLogger().warn(
    activityLogEvent(
      CHAT_CREATION_REJECTED_OPERATION,
      {
        correlationId: correlationIdOrUnknown(input.correlationId),
        status: input.status,
        errorKind: input.reason === "readiness" ? "unavailable" : "invalid-request",
      },
      {
        reason: input.reason,
        modelKind: input.modelKind,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export function logChatRejectionEvent(
  operation: "chat.send.rejected" | "chat.regeneration.rejected",
  input: {
    readonly correlationId: string | undefined;
    readonly status: number;
    readonly reason: ChatRejectionReason;
    readonly modelKind: ObservedModelKind;
  },
): void {
  const envelope = {
    correlationId: correlationIdOrUnknown(input.correlationId),
    status: input.status,
    errorKind: rejectionErrorKind(input.reason),
  } as const;
  const fields = {
    reason: input.reason,
    modelKind: input.modelKind,
    completeness: "complete",
    loss: "none",
  } as const;
  if (operation === "chat.send.rejected") {
    getServerLogger().warn(activityLogEvent(CHAT_SEND_REJECTED_OPERATION, envelope, fields));
  } else {
    getServerLogger().warn(
      activityLogEvent(CHAT_REGENERATION_REJECTED_OPERATION, envelope, fields),
    );
  }
}

export function logChatTurnStartedEvent(
  correlationId: string | undefined,
  fields: ChatTurnActivityFields,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_TURN_STARTED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { ...fields, completeness: "complete", loss: "none" },
    ),
  );
}

export function logGitChangeTurnAuthorityEvent(
  correlationId: string | undefined,
  admission:
    | { readonly admitted: true }
    | { readonly admitted: false; readonly reason: GitChangeDescriptionTurnDenial },
  relationshipId: string,
): void {
  const resolvedCorrelationId = correlationIdOrUnknown(correlationId);
  if (admission.admitted) {
    getServerLogger().info(
      activityLogEvent(
        PR_DESCRIPTION_CHAT_TURN_ADMITTED_OPERATION,
        { correlationId: resolvedCorrelationId },
        { relationshipId, completeness: "complete", loss: "none" },
      ),
    );
    return;
  }
  getServerLogger().warn(
    activityLogEvent(
      PR_DESCRIPTION_CHAT_TURN_DENIED_OPERATION,
      { correlationId: resolvedCorrelationId, errorKind: "authority-denied" },
      {
        relationshipId,
        reason: admission.reason,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export function logGitChangeDescriptionTargetDenied(
  sink: ServerLogSink,
  correlationId: string,
  reason: GitChangeDescriptionTargetDenial,
): void {
  sink.write(
    activityLogEvent(
      GIT_CHANGE_DESCRIPTION_TARGET_DENIED_OPERATION,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind: reason === "reader-unauthorized" ? "authority-denied" : "unavailable",
      },
      { reason, completeness: "complete", loss: "none" },
    ),
  );
}

export function logGitChangeApply(
  sink: ServerLogSink,
  correlationId: string,
  outcome: "preview" | "observed" | "blocked",
): void {
  sink.write(
    activityLogEvent(
      GIT_CHANGE_CHAT_APPLY_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        ...(outcome === "blocked" ? { errorKind: "conflict" as const } : {}),
      },
      { outcome, completeness: "complete", loss: "none" },
    ),
  );
}
