import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

export type CheckpointDisposition =
  | "none"
  | "restored"
  | "revision-mismatch"
  | "window-expanded"
  | "current-turn-protected"
  | "boundary-missing";

export interface ChatHistoryCaptureEvidence {
  readonly historyRevision: number;
  readonly checkpointDisposition: CheckpointDisposition;
  readonly unitsVisited: number;
  readonly foldedItems: number;
  readonly retainedItems: number;
  readonly contextWindowTokens: number;
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
        "restored",
        "revision-mismatch",
        "window-expanded",
        "current-turn-protected",
        "boundary-missing",
      ],
    },
    unitsVisited: { type: "integer", dataClass: "count", required: true },
    foldedItems: { type: "integer", dataClass: "count", required: true },
    retainedItems: { type: "integer", dataClass: "count", required: true },
    contextWindowTokens: { type: "integer", dataClass: "count", required: true },
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
  readonly unitsVisited: number;
  readonly scannedChars: number;
  readonly candidateCount: number;
  readonly excerptCount: number;
  readonly rehydratedTokens: number;
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
    unitsVisited: { type: "integer", dataClass: "count", required: true },
    scannedChars: { type: "integer", dataClass: "count", required: true },
    candidateCount: { type: "integer", dataClass: "count", required: true },
    excerptCount: { type: "integer", dataClass: "count", required: true },
    rehydratedTokens: { type: "integer", dataClass: "count", required: true },
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

export function logChatHistoryCapture(
  evidence: ChatHistoryCaptureEvidence,
  correlationId?: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CHAT_CONTINUITY_CAPTURE,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { ...evidence, completeness: "complete", loss: "none" },
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
