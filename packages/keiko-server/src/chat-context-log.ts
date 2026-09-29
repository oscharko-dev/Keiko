import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { getServerLogger } from "./observability/index.js";

const CHAT_CONTEXT_MANAGEMENT = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.context.management",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-context-log.logChatContextManagement",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "inspected",
        "compacted",
        "unchanged",
        "failed",
        "summary-discarded",
        "prompt-compacted",
        "prompt-failed",
      ],
    },
    inputTokens: { type: "integer", dataClass: "count", required: true },
    inputBudget: { type: "integer", dataClass: "count", required: true },
    tokensSaved: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.context.management.line"],
  releaseImpact: "minor",
});

export function logChatContextManagement(
  outcome:
    | "inspected"
    | "compacted"
    | "unchanged"
    | "failed"
    | "summary-discarded"
    | "prompt-compacted"
    | "prompt-failed",
  status: Pick<ChatContextStatusWire, "estimatedInputTokens" | "inputBudgetTokens">,
  tokensSaved: number,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_CONTEXT_MANAGEMENT,
      { correlationId },
      {
        outcome,
        inputTokens: status.estimatedInputTokens,
        inputBudget: status.inputBudgetTokens,
        tokensSaved,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
