import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";

import type {
  KnowledgeReviewFailureStage,
  KnowledgeReviewValidationReason,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
export {
  KNOWLEDGE_REVIEW_FAILURE_STAGES,
  KNOWLEDGE_REVIEW_VALIDATION_REASONS,
  type KnowledgeReviewFailureStage,
  type KnowledgeReviewValidationReason,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";

const REVIEW_VALUE_TYPES = [
  "missing",
  "null",
  "boolean",
  "number",
  "string",
  "array",
  "object",
  "other",
] as const;
/** Closed parser facts and uint32 sizes/positions only; never a source, field value or model body. */
export interface KnowledgeReviewObservation {
  readonly reviewFailureStage?: KnowledgeReviewFailureStage;
  readonly reviewValidationReason?: KnowledgeReviewValidationReason;
  readonly reviewFinishReason?:
    "stop" | "tool_calls" | "length" | "content_filter" | "error" | "cancelled";
  readonly reviewOutputChars?: number;
  readonly reviewToolCallCount?: number;
  readonly reviewAnchorCount?: number;
  readonly reviewFindingCount?: number;
  readonly reviewFindingIndex?: number;
  readonly reviewAnchorIndex?: number;
  readonly reviewValueType?: (typeof REVIEW_VALUE_TYPES)[number];
  readonly reviewTextChars?: number;
  readonly reviewTextTrimmedChars?: number;
  readonly reviewActualCount?: number;
}

export interface KnowledgeDocumentActivity extends KnowledgeReviewObservation {
  readonly operation: "inventory" | "search" | "read" | "review" | "coverage";
  readonly disposition: "served" | "refused" | "unavailable";
  readonly documentCount: number;
  readonly returnedCount: number;
  readonly sourceChars: number;
  readonly hasNextPage: boolean;
  readonly cached: boolean;
  readonly requirementCount?: number;
  readonly readRequirementCount?: number;
  readonly reviewedDocumentCount?: number;
  readonly pendingPageCount?: number;
}
const COUNT = { type: "integer", dataClass: "count", required: true } as const;
const OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "knowledge.documents.operation",
  category: "search",
  owner: "keiko-server",
  emitter: "knowledge-document-activity.logKnowledgeDocumentOperation",
  fields: {
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["inventory", "search", "read", "review", "coverage"],
    },
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["served", "refused", "unavailable"],
    },
    documentCount: COUNT,
    returnedCount: COUNT,
    sourceChars: COUNT,
    hasNextPage: { type: "boolean", dataClass: "closed-enum", required: true },
    cached: { type: "boolean", dataClass: "closed-enum", required: true },
    requirementCount: { ...COUNT, required: false },
    readRequirementCount: { ...COUNT, required: false },
    reviewedDocumentCount: { ...COUNT, required: false },
    pendingPageCount: { ...COUNT, required: false },
    reviewFailureStage: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "model-output-invalid",
        "model-port-unavailable",
        "budget-port-unavailable",
      ] satisfies readonly KnowledgeReviewFailureStage[],
    },
    reviewValidationReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "finish-reason",
        "tool-calls",
        "output-bound",
        "json-syntax",
        "review-shape",
        "complete-type",
        "findings-type",
        "findings-bound",
        "finding-shape",
        "finding-kind",
        "anchor-shape",
        "anchor-range",
        "proposal-bound",
        "question-bound",
        "conflict-anchors",
        "clarification-question",
      ] satisfies readonly KnowledgeReviewValidationReason[],
    },
    reviewFinishReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["stop", "tool_calls", "length", "content_filter", "error", "cancelled"],
    },
    reviewOutputChars: { ...COUNT, required: false },
    reviewToolCallCount: { ...COUNT, required: false },
    reviewAnchorCount: { ...COUNT, required: false },
    reviewFindingCount: { ...COUNT, required: false },
    reviewFindingIndex: { ...COUNT, required: false },
    reviewAnchorIndex: { ...COUNT, required: false },
    reviewValueType: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...REVIEW_VALUE_TYPES],
    },
    reviewTextChars: { ...COUNT, required: false },
    reviewTextTrimmedChars: { ...COUNT, required: false },
    reviewActualCount: { ...COUNT, required: false },
    completeness: {
      type: "string",
      dataClass: "completeness-state",
      required: true,
    },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [{ field: "disposition", values: ["refused", "unavailable"] }],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["requirement-inventory"],
  proofIds: ["knowledge.documents.operation.line"],
  releaseImpact: "patch",
});

export function logKnowledgeDocumentOperation(
  correlationId: string,
  activity: KnowledgeDocumentActivity,
): void {
  const event = activityLogEvent(
    OPERATION,
    { correlationId },
    { ...activity, completeness: "complete", loss: "none" },
  );
  const logger = getServerLogger();
  if (activity.disposition === "unavailable") logger.warn(event);
  else logger.info(event);
}
