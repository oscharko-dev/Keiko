import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { getServerLogger } from "./observability/index.js";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";

const CHAT_CONTEXT_FAILED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.context.failed",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-context-log.logChatContextFailure",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["checkpoint-not-saved"],
    },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxItems: 8,
      maxLength: 512,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxItems: 5,
      maxLength: 128,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.context.failed.line"],
  releaseImpact: "patch",
});

export function logChatContextFailure(error: Error, correlationId: string): void {
  getServerLogger().error(
    activityLogEvent(
      CHAT_CONTEXT_FAILED,
      { correlationId, errorKind: "internal" },
      {
        outcome: "checkpoint-not-saved",
        frames: keikoStackFrames(error),
        causeChain: causeChain(error),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

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
    // An inspection that projected automatic compaction: the stored history before the projection
    // and the projected history after it, so an oversized history that the meter reports as fitting
    // stays distinguishable from a small one (PR #3678 review).
    storedHistoryTokens: { type: "integer", dataClass: "count", required: false },
    projectedHistoryTokens: { type: "integer", dataClass: "count", required: false },
    projectedMessagesCompacted: { type: "integer", dataClass: "count", required: false },
    knowledgeSourceTokens: { type: "integer", dataClass: "count", required: false },
    contextWindowAssumed: { type: "boolean", dataClass: "closed-enum", required: false },
    // The reading as the meter shows it, so a reported percentage and its breakdown can be rebuilt
    // from the log alone (PR #3678 review): the trigger (a grounded chat's lane-based one differs
    // from the whole-window one), the last knowledge request and the known shares.
    autoCompactionAtTokens: { type: "integer", dataClass: "count", required: false },
    lastRequestTokens: { type: "integer", dataClass: "count", required: false },
    lastRequestMeasured: { type: "boolean", dataClass: "closed-enum", required: false },
    lastRequestEstimatedTokens: { type: "integer", dataClass: "count", required: false },
    sentReferenceCount: { type: "integer", dataClass: "count", required: false },
    availableReferenceCount: { type: "integer", dataClass: "count", required: false },
    systemTokens: { type: "integer", dataClass: "count", required: false },
    summaryTokens: { type: "integer", dataClass: "count", required: false },
    messageTokens: { type: "integer", dataClass: "count", required: false },
    contextWindowProbePending: { type: "boolean", dataClass: "closed-enum", required: false },
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
  status: ContextManagementStatus,
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
        ...contextStatusEvidence(status),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

type ContextManagementStatus = Pick<
  ChatContextStatusWire,
  "estimatedInputTokens" | "inputBudgetTokens"
> &
  Partial<
    Pick<
      ChatContextStatusWire,
      | "pendingCompaction"
      | "knowledgeSources"
      | "contextWindowAssumed"
      | "autoCompactionAtTokens"
      | "lastRequest"
      | "segments"
      | "contextWindowProbePending"
    >
  >;

type Evidence = Record<string, number | boolean>;

function contextStatusEvidence(status: ContextManagementStatus): Evidence {
  const pending = status.pendingCompaction;
  return {
    ...(pending === undefined
      ? {}
      : {
          storedHistoryTokens: pending.tokensBefore,
          projectedHistoryTokens: pending.tokensAfter,
          projectedMessagesCompacted: pending.messagesCompacted,
        }),
    ...knowledgeEvidence(status),
    ...segmentEvidence(status.segments),
    ...(status.contextWindowAssumed === true ? { contextWindowAssumed: true } : {}),
    ...(status.contextWindowProbePending === true ? { contextWindowProbePending: true } : {}),
    ...(status.autoCompactionAtTokens === undefined
      ? {}
      : { autoCompactionAtTokens: status.autoCompactionAtTokens }),
  };
}

function knowledgeEvidence(status: ContextManagementStatus): Evidence {
  const sources = status.knowledgeSources;
  const last = status.lastRequest;
  return {
    ...(sources === undefined
      ? {}
      : {
          knowledgeSourceTokens: sources.tokens,
          sentReferenceCount: sources.sentReferenceCount,
          availableReferenceCount: sources.availableReferenceCount,
        }),
    ...(last === undefined
      ? {}
      : {
          lastRequestTokens: last.promptTokens,
          lastRequestMeasured: last.measured,
          ...(last.estimatedTokens === undefined
            ? {}
            : { lastRequestEstimatedTokens: last.estimatedTokens }),
        }),
  };
}

const SEGMENT_EVIDENCE_FIELDS = new Map([
  ["system", "systemTokens"],
  ["summary", "summaryTokens"],
  ["messages", "messageTokens"],
]);

function segmentEvidence(segments: ContextManagementStatus["segments"]): Evidence {
  const evidence: Evidence = {};
  for (const segment of segments ?? []) {
    const field = SEGMENT_EVIDENCE_FIELDS.get(segment.id);
    if (field !== undefined) evidence[field] = segment.tokens;
  }
  return evidence;
}
