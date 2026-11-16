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
    // Set when the list carried answers whose Local Knowledge index lifecycle was refreshed: how the
    // current capsule stamps were obtained, and for how many capsules.
    stampMemo: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["hit", "reread-token", "reread-age", "reread-missing"],
    },
    capsuleCount: { type: "integer", dataClass: "count", required: false },
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

/** How an index-lifecycle refresh obtained the current capsule stamps; counts and a closed word. */
export interface ChatLifecycleRefresh {
  readonly stampMemo: "hit" | "reread-token" | "reread-age" | "reread-missing";
  readonly capsuleCount: number;
}

/** Private document bodies belong to stored prompt history, not repeated browser responses. */
export function browserChatMessages(
  messages: readonly ChatMessage[],
  correlationId?: string,
  refresh?: ChatLifecycleRefresh,
): readonly ChatMessage[] {
  let omittedDocumentCount = 0;
  const projected = messages.map((message) => {
    if (message.documentContext === undefined) return message;
    const { documentContext, ...visible } = message;
    omittedDocumentCount += documentContext.length;
    return visible;
  });
  if (omittedDocumentCount > 0 || refresh !== undefined)
    processServerLogSink().write(
      activityLogEvent(
        CHAT_MESSAGES_PROJECTED,
        { correlationId: correlationIdOrUnknown(correlationId) },
        {
          messageCount: messages.length,
          omittedDocumentCount,
          ...(refresh === undefined
            ? {}
            : { stampMemo: refresh.stampMemo, capsuleCount: refresh.capsuleCount }),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  return projected;
}
