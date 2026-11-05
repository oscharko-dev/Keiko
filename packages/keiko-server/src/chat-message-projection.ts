import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";

const CHAT_MESSAGES_PROJECTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.messages.projected",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-message-projection.browserChatMessages",
  fields: {
    messageCount: { type: "integer", dataClass: "count", required: true },
    omittedDocumentCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-turn"],
  proofIds: ["chat.messages.projected.document-context"],
  releaseImpact: "patch",
});

/** Private document bodies belong to stored prompt history, not repeated browser responses. */
export function browserChatMessages(
  messages: readonly ChatMessage[],
  correlationId?: string,
): readonly ChatMessage[] {
  let omittedDocumentCount = 0;
  const projected = messages.map((message) => {
    if (message.documentContext === undefined) return message;
    const { documentContext, ...visible } = message;
    omittedDocumentCount += documentContext.length;
    return visible;
  });
  if (omittedDocumentCount > 0)
    processServerLogSink().write(
      activityLogEvent(
        CHAT_MESSAGES_PROJECTED,
        { correlationId: correlationIdOrUnknown(correlationId) },
        {
          messageCount: messages.length,
          omittedDocumentCount,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  return projected;
}
