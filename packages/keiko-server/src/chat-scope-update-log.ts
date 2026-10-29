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
      values: ["applied", "conflict", "cancellation-requested", "denied"],
    },
    expectedScopeDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    actualScopeDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    resultScopeDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    connectedSourceCount: { type: "integer", dataClass: "count", required: true },
    localKnowledgeSourceCount: { type: "integer", dataClass: "count", required: true },
    gitChangeSourceCount: { type: "integer", dataClass: "count", required: true },
    jiraSourceCount: { type: "integer", dataClass: "count", required: false },
    jiraBindingGeneration: { type: "integer", dataClass: "count", required: false },
    toolMode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
    cancelledGenerationCount: { type: "integer", dataClass: "count", required: false },
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
  outcome: "applied" | "conflict" | "cancellation-requested" | "denied",
  existing: Chat,
  result: Chat,
  patch: UpdateChatPatch,
  correlationId: string | undefined,
  cancelledGenerationCount?: number,
): void {
  const expected = patch.expectedGroundingScopeIdentity;
  let status = 200;
  if (outcome === "conflict") status = 409;
  else if (outcome === "denied") status = 400;
  processServerLogSink().write(
    activityLogEvent(
      CHAT_SCOPE_UPDATE,
      {
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        status,
      },
      {
        outcome,
        ...(cancelledGenerationCount === undefined ? {} : { cancelledGenerationCount }),
        ...(expected === undefined
          ? {}
          : { expectedScopeDigest: expected.slice("gsi-v1:".length) }),
        actualScopeDigest: deriveChatGroundingScopeIdentity(existing).slice("gsi-v1:".length),
        resultScopeDigest: deriveChatGroundingScopeIdentity(result).slice("gsi-v1:".length),
        ...chatGroundingSourceCounts(result),
        ...jiraStateEvidence(result),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function jiraStateEvidence(chat: Chat): {
  readonly jiraSourceCount?: number;
  readonly jiraBindingGeneration?: number;
  readonly toolMode?: NonNullable<Chat["toolMode"]>;
} {
  if ((chat.jiraBindingGeneration ?? 0) === 0) return {};
  return {
    jiraSourceCount: Number(chat.jiraPodBinding !== undefined),
    jiraBindingGeneration: chat.jiraBindingGeneration ?? 0,
    toolMode: chat.toolMode ?? "governed-assist",
  };
}
