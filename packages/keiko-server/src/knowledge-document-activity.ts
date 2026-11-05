import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";

export interface KnowledgeDocumentActivity {
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
