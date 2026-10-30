import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

const CHAT_CONTINUITY_CHECKPOINT = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.continuity.checkpoint",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-continuity-log.logChatContinuityCheckpoint",
  fields: {
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["read", "write"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "available",
        "missing",
        "invalid",
        "persisted",
        "retained",
        "stale",
        "rejected",
        "failed",
      ],
    },
    generation: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.continuity.checkpoint.line"],
  releaseImpact: "patch",
});

export function logChatContinuityCheckpoint(
  evidence: {
    readonly operation: "read" | "write";
    readonly outcome:
      | "available"
      | "missing"
      | "invalid"
      | "persisted"
      | "retained"
      | "stale"
      | "rejected"
      | "failed";
    readonly generation?: number;
  },
  correlationId?: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_CONTINUITY_CHECKPOINT,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { ...evidence, completeness: "complete", loss: "none" },
    ),
  );
}

export type CheckpointDisposition =
  | "none"
  | "read-failed"
  | "restored"
  | "revision-mismatch"
  | "window-expanded"
  | "input-budget-expanded"
  | "current-turn-protected"
  | "boundary-missing";

export interface ChatHistoryCaptureEvidence {
  readonly historyRevision: number;
  readonly checkpointDisposition: CheckpointDisposition;
  readonly unitsVisited: number;
  readonly foldedItems: number;
  readonly retainedItems: number;
  readonly contextWindowTokens: number;
  readonly effectiveInputBudgetTokens?: number;
  readonly checkpointInputBudgetTokens?: number;
}

const CHAT_CONTINUITY_CAPTURE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.continuity.capture",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-continuity-log.logChatHistoryCapture",
  fields: {
    historyRevision: { type: "integer", dataClass: "count", required: true },
    checkpointDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "read-failed",
        "restored",
        "revision-mismatch",
        "window-expanded",
        "input-budget-expanded",
        "current-turn-protected",
        "boundary-missing",
      ],
    },
    unitsVisited: { type: "integer", dataClass: "count", required: true },
    foldedItems: { type: "integer", dataClass: "count", required: true },
    retainedItems: { type: "integer", dataClass: "count", required: true },
    contextWindowTokens: { type: "integer", dataClass: "count", required: true },
    effectiveInputBudgetTokens: { type: "integer", dataClass: "count", required: false },
    checkpointInputBudgetTokens: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.continuity.capture.line"],
  releaseImpact: "patch",
});

export interface ChatRehydrationEvidence {
  readonly queryTermCount?: number;
  readonly identifierTermCount?: number;
  readonly matchingPolicy?: "word-prefix-and-identifiers-v1" | "word-prefix-and-identifiers-v2";
  readonly unitsVisited: number;
  readonly scannedChars: number;
  readonly candidateCount: number;
  readonly excerptCount: number;
  readonly rehydratedTokens: number;
  readonly tokenBudget?: number;
  readonly tokenCounterSource?: "local-estimate";
  readonly budgetDroppedExcerpts?: number;
  readonly scanDisposition:
    "complete" | "unit-limit" | "character-limit" | "best-matches" | "no-query-terms";
}

const CHAT_CONTINUITY_REHYDRATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.continuity.rehydration",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-continuity-log.logChatRehydration",
  fields: {
    queryTermCount: { type: "integer", dataClass: "count", required: false },
    identifierTermCount: { type: "integer", dataClass: "count", required: false },
    matchingPolicy: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["word-prefix-and-identifiers-v1", "word-prefix-and-identifiers-v2"],
    },
    unitsVisited: { type: "integer", dataClass: "count", required: true },
    scannedChars: { type: "integer", dataClass: "count", required: true },
    candidateCount: { type: "integer", dataClass: "count", required: true },
    excerptCount: { type: "integer", dataClass: "count", required: true },
    rehydratedTokens: { type: "integer", dataClass: "count", required: true },
    tokenBudget: { type: "integer", dataClass: "count", required: false },
    tokenCounterSource: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["local-estimate"],
    },
    budgetDroppedExcerpts: { type: "integer", dataClass: "count", required: false },
    scanDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "unit-limit", "character-limit", "best-matches", "no-query-terms"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.continuity.rehydration.line"],
  releaseImpact: "patch",
});

const CHAT_CONTINUITY_DEGRADED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.continuity.degraded",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-continuity-log.logGroundedContinuityDegradation",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["budget-exceeded", "summary-trimmed"],
    },
    inputBudget: { type: "integer", dataClass: "count", required: true },
    omittedSummaryCategories: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.continuity.degraded.line"],
  releaseImpact: "patch",
});

interface SummaryWorkEvidence {
  readonly outcome:
    "accepted" | "invalid" | "timed-out" | "unavailable" | "coalesced" | "cancelled";
  readonly modelPortCalled: boolean;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly promptCodeUnitsPlanned: number;
}

const CHAT_COMPACTION_SUMMARY_WORK = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.compaction.summary.work",
  owner: "keiko-server",
  category: "gateway",
  emitter: "chat-continuity-log.logChatCompactionSummaryWork",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["accepted", "invalid", "timed-out", "unavailable", "coalesced", "cancelled"],
    },
    modelPortCalled: { type: "boolean", dataClass: "closed-enum", required: true },
    timeoutMs: { type: "integer", dataClass: "count", required: true },
    elapsedMs: { type: "integer", dataClass: "count", required: true },
    promptCodeUnitsPlanned: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-context-management"],
  proofIds: ["chat.compaction.summary.work.line"],
  releaseImpact: "patch",
});

export function logChatCompactionSummaryWork(
  evidence: SummaryWorkEvidence,
  correlationId?: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_COMPACTION_SUMMARY_WORK,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { ...evidence, completeness: "complete", loss: "none" },
    ),
  );
}

export function logChatHistoryCapture(
  evidence: ChatHistoryCaptureEvidence,
  correlationId?: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_CONTINUITY_CAPTURE,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        ...evidence,
        completeness: evidence.checkpointDisposition === "read-failed" ? "partial" : "complete",
        loss: "none",
      },
    ),
  );
}

export function logChatRehydration(
  evidence: ChatRehydrationEvidence,
  correlationId?: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_CONTINUITY_REHYDRATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        ...evidence,
        completeness:
          evidence.scanDisposition === "unit-limit" ||
          evidence.scanDisposition === "character-limit"
            ? "partial"
            : "complete",
        loss: "none",
      },
    ),
  );
}

export function logGroundedContinuityDegradation(
  inputBudget: number,
  correlationId?: string,
  omittedSummaryCategories = 0,
): void {
  getServerLogger().warn(
    activityLogEvent(
      CHAT_CONTINUITY_DEGRADED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        reason: omittedSummaryCategories > 0 ? "summary-trimmed" : "budget-exceeded",
        inputBudget,
        omittedSummaryCategories,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
