import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";

const CHAT_DRAFT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.draft.operation",
  category: "setup",
  owner: "keiko-server",
  emitter: "chat-draft-log.logChatDraftOperation",
  fields: {
    action: { type: "string", dataClass: "closed-enum", required: true, values: ["read", "save"] },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started", "completed", "rejected", "failed"],
    },
    httpStatus: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-draft-persistence"],
  proofIds: ["chat.draft.operation.lifecycle"],
  releaseImpact: "patch",
});

export function logChatDraftOperation(
  correlationId: string | undefined,
  action: "read" | "save",
  phase: "started" | "completed" | "rejected" | "failed",
  httpStatus: number,
): void {
  processServerLogSink().write(
    activityLogEvent(
      CHAT_DRAFT_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { action, phase, httpStatus, completeness: "complete", loss: "none" },
    ),
  );
}
