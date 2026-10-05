import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { Chat, UpdateChatPatch } from "@oscharko-dev/keiko-contracts/bff-wire";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";
import {
  chatGroundingSourceCounts,
  deriveChatGroundingScopeIdentity,
} from "./store/chat-grounding-scope-identity.js";

const CHAT_SCOPE_UPDATE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.scope.update",
  category: "gateway",
  owner: "keiko-server",
  emitter: "chat-scope-update-log.logChatScopeUpdate",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["applied", "conflict"],
    },
    expectedScopeDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    actualScopeDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    resultScopeDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    connectedSourceCount: { type: "integer", dataClass: "count", required: true },
    localKnowledgeSourceCount: { type: "integer", dataClass: "count", required: true },
    gitChangeSourceCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["chat-admission"],
  proofIds: ["chat.scope.update.outcome"],
  releaseImpact: "patch",
});

export function logChatScopeUpdate(
  outcome: "applied" | "conflict",
  existing: Chat,
  result: Chat,
  patch: UpdateChatPatch,
  correlationId: string | undefined,
): void {
  const expected = patch.expectedGroundingScopeIdentity;
  processServerLogSink().write(
    activityLogEvent(
      CHAT_SCOPE_UPDATE,
      {
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        status: outcome === "applied" ? 200 : 409,
      },
      {
        outcome,
        ...(expected === undefined
          ? {}
          : { expectedScopeDigest: expected.slice("gsi-v1:".length) }),
        actualScopeDigest: deriveChatGroundingScopeIdentity(existing).slice("gsi-v1:".length),
        resultScopeDigest: deriveChatGroundingScopeIdentity(result).slice("gsi-v1:".length),
        ...chatGroundingSourceCounts(result),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
