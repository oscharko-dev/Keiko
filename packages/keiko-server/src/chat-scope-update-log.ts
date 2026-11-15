import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { Chat, UpdateChatPatch } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CHAT_TOOL_DEFAULT_MODE } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";
import {
  chatGroundingSourceCounts,
  deriveChatGroundingScopeIdentity,
} from "./store/chat-grounding-scope-identity.js";

// Why a scope update that named a Knowledge Pod was refused before it changed anything (#4371).
export const KNOWLEDGE_SCOPE_REFUSAL_REASONS = [
  "knowledge-pod-missing",
  "knowledge-pod-set-missing",
  "knowledge-pod-deleting",
  "knowledge-store-unavailable",
] as const;
export type KnowledgeScopeRefusalReason = (typeof KNOWLEDGE_SCOPE_REFUSAL_REASONS)[number];

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
    refusalReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: KNOWLEDGE_SCOPE_REFUSAL_REASONS,
    },
    expectedScopeDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    actualScopeDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    resultScopeDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    connectedSourceCount: { type: "integer", dataClass: "count", required: true },
    localKnowledgeSourceCount: { type: "integer", dataClass: "count", required: true },
    gitChangeSourceCount: { type: "integer", dataClass: "count", required: true },
    jiraSourceCount: { type: "integer", dataClass: "count", required: false },
    jiraBindingGeneration: { type: "integer", dataClass: "count", required: false },
    jiraAdministrationEnabled: { type: "boolean", dataClass: "closed-enum", required: false },
    toolMode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
    cancelledGenerationCount: { type: "integer", dataClass: "count", required: false },
    mcpServerSelectionCount: { type: "integer", dataClass: "count", required: false },
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
  refusalReason?: KnowledgeScopeRefusalReason,
): void {
  const expected = patch.expectedGroundingScopeIdentity;
  let status = 200;
  if (outcome === "conflict") status = 409;
  else if (outcome === "denied") status = refusalStatus(refusalReason);
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
        ...(refusalReason === undefined ? {} : { refusalReason }),
        ...(expected === undefined
          ? {}
          : { expectedScopeDigest: expected.slice("gsi-v1:".length) }),
        actualScopeDigest: deriveChatGroundingScopeIdentity(existing).slice("gsi-v1:".length),
        resultScopeDigest: deriveChatGroundingScopeIdentity(result).slice("gsi-v1:".length),
        ...chatGroundingSourceCounts(result),
        ...jiraStateEvidence(result),
        ...(result.mcpServers === undefined
          ? {}
          : { mcpServerSelectionCount: result.mcpServers.length }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function refusalStatus(reason: KnowledgeScopeRefusalReason | undefined): number {
  if (reason === undefined) return 400;
  return reason === "knowledge-store-unavailable" ? 503 : 409;
}

function jiraStateEvidence(chat: Chat): {
  readonly jiraSourceCount?: number;
  readonly jiraBindingGeneration?: number;
  readonly jiraAdministrationEnabled?: boolean;
  readonly toolMode?: NonNullable<Chat["toolMode"]>;
} {
  if ((chat.jiraBindingGeneration ?? 0) === 0) return {};
  return {
    jiraSourceCount: Number(chat.jiraPodBinding !== undefined),
    jiraBindingGeneration: chat.jiraBindingGeneration ?? 0,
    jiraAdministrationEnabled: chat.jiraAdministrationEnabled === true,
    toolMode: chat.toolMode ?? CHAT_TOOL_DEFAULT_MODE,
  };
}
