import type { ModelKind } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { RouteResult } from "./routes.js";
import { correlationIdOrUnknown, isValidCorrelationId } from "./correlation.js";
import { getServerLogger, type ServerLogSink } from "./observability/index.js";

type ObservedModelKind = ModelKind | "unknown";
export type ChatRejectionReason = "readiness" | "generation" | "grounding-scope";
// Which readiness state refused a model: `unobserved` when this process holds no current
// observation for it (nothing checked it since start or since the configuration changed),
// `not-ready` when a check ran and failed.
export type ChatReadinessObservation = "unobserved" | "not-ready";

interface ChatRejectionModelEvidence {
  readonly modelIdDigest?: string | undefined;
  readonly readinessObservation?: ChatReadinessObservation | undefined;
}

const MAX_REJECTION_MODEL_ID_DIGEST_CHARS = 16;
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

const CHAT_REJECTION_REGISTRATION = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "gateway",
  owner: "keiko-server",
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["chat-admission"],
  releaseImpact: "patch",
} as const;

const CHAT_REJECTION_COMMON_FIELDS = {
  modelKind: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["chat", "embedding", "ocr-vision", "voice", "unknown"],
  },
  // The refused model and, for a readiness refusal, the state that refused it. Without them a
  // refusal read as a failed live check even when no check had run in this process (#3557). The
  // model is only ever the digest `observability/model-id-evidence.ts` projects, never the id: a
  // model id is caller content or operator-chosen text that no check proves body-free.
  modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
  readinessObservation: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ["unobserved", "not-ready"],
  },
  completeness: { type: "string", dataClass: "completeness-state", required: true },
  loss: { type: "string", dataClass: "loss-state", required: true },
} as const;

const CHAT_CREATION_REJECTED_OPERATION = defineActivityLogOperation({
  ...CHAT_REJECTION_REGISTRATION,
  op: "chat.creation.rejected",
  emitter: "chat-activity.logChatCreationRejectionEvent",
  fields: {
    ...CHAT_REJECTION_COMMON_FIELDS,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["readiness", "configuration"],
    },
  },
  proofIds: ["chat.creation.rejected.reason"],
});

const CHAT_SEND_REJECTED_OPERATION = defineActivityLogOperation({
  ...CHAT_REJECTION_REGISTRATION,
  op: "chat.send.rejected",
  emitter: "chat-activity.logChatRejectionEvent.send",
  fields: {
    ...CHAT_REJECTION_COMMON_FIELDS,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["readiness", "generation", "grounding-scope"],
    },
  },
  proofIds: ["chat.send.rejected.reason"],
});

const CHAT_REGENERATION_REJECTED_OPERATION = defineActivityLogOperation({
  ...CHAT_REJECTION_REGISTRATION,
  op: "chat.regeneration.rejected",
  emitter: "chat-activity.logChatRejectionEvent.regeneration",
  fields: {
    ...CHAT_REJECTION_COMMON_FIELDS,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["readiness", "generation", "grounding-scope"],
    },
  },
  proofIds: ["chat.regeneration.rejected.reason"],
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

const CHAT_RESPONSE_MESSAGE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.response.message",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-activity.logChatResponseMessage",
  fields: {
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-turn"],
  proofIds: ["chat.response.message.causality"],
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
  if (reason === "readiness") return "unavailable";
  return reason === "generation" ? "internal" : "invalid-request";
}

// The caller (chat-handlers.ts) has already projected the candidate model id through
// `observability/model-id-evidence.ts` into its digest; the id itself never reaches this module.
// This only bounds defensively (in case a future caller forgets to) and reshapes into the emitted
// field set.
function rejectionModelFields(evidence: ChatRejectionModelEvidence): {
  readonly modelIdDigest?: string;
  readonly readinessObservation?: ChatReadinessObservation;
} {
  return {
    ...(evidence.modelIdDigest === undefined
      ? {}
      : { modelIdDigest: evidence.modelIdDigest.slice(0, MAX_REJECTION_MODEL_ID_DIGEST_CHARS) }),
    ...(evidence.readinessObservation === undefined
      ? {}
      : { readinessObservation: evidence.readinessObservation }),
  };
}

export function logChatCreationRejectionEvent(
  input: ChatRejectionModelEvidence & {
    readonly correlationId: string | undefined;
    readonly status: number;
    readonly reason: "readiness" | "configuration";
    readonly modelKind: ObservedModelKind;
  },
): void {
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
        ...rejectionModelFields(input),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export function logChatRejectionEvent(
  operation: "chat.send.rejected" | "chat.regeneration.rejected",
  input: ChatRejectionModelEvidence & {
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
    ...rejectionModelFields(input),
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

/** Connect durable assistant identities to each successful request, including replay/regeneration. */
export function logChatResponseMessages(body: unknown, correlationId: string | undefined): void {
  if (typeof body !== "object" || body === null || !("messages" in body)) return;
  if (!Array.isArray(body.messages)) return;
  const messages: readonly unknown[] = body.messages;
  for (const message of messages) {
    if (!isAssistantMessageIdentity(message)) continue;
    logChatResponseMessage(message.id, correlationId);
  }
}

export function logChatResponseMessage(
  assistantMessageId: string,
  correlationId: string | undefined,
): void {
  if (!isValidCorrelationId(assistantMessageId)) return;
  getServerLogger().info(
    activityLogEvent(
      CHAT_RESPONSE_MESSAGE_OPERATION,
      {
        correlationId: assistantMessageId,
        ...(correlationId === undefined || correlationId === assistantMessageId
          ? {}
          : { parentCorrelationId: correlationId }),
      },
      { completeness: "complete", loss: "none" },
    ),
  );
}

function isAssistantMessageIdentity(message: unknown): message is { readonly id: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "id" in message &&
    typeof message.id === "string"
  );
}

export function logChatResponse(
  result: RouteResult,
  correlationId: string | undefined,
): RouteResult {
  if (result.status === 200) logChatResponseMessages(result.body, correlationId);
  return result;
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
      {
        correlationId: resolvedCorrelationId,
        errorKind:
          admission.reason === "authority-expired" ? "validation-failed" : "authority-denied",
      },
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
