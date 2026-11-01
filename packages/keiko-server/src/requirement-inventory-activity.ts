// Body-free activity-log evidence for the requirement inventory tool and the source trace (#4179).
//
// `knowledge.requirements.read` records every call of the read tool: which view, how the call ended
// and the counts that decide what the model could see, so a missing requirement in an answer can be
// rebuilt from the log alone. `knowledge.requirement-trace.applied` records what the trace of a
// created or edited issue did: references resolved or refused, labels and footer applied or
// dropped. Counts and closed words only; no identifier, title, path or document text.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

export type RequirementReadView = "units" | "documents" | "change-queries";
export type RequirementReadDisposition = "served" | "refused" | "cursor-stale" | "unavailable";

export interface RequirementReadActivity {
  readonly view: RequirementReadView;
  readonly disposition: RequirementReadDisposition;
  readonly cursorUsed: boolean;
  readonly detectedCount: number;
  readonly matchedCount: number;
  readonly returnedCount: number;
  readonly documentsScanned: number;
  readonly documentsNotExtracted: number;
  readonly documentsOmitted: number;
  readonly unitsOmitted: number;
  readonly resultBytes: number;
  readonly hasNextPage: boolean;
}

const COUNT = { type: "integer", dataClass: "count", required: true } as const;

const REQUIREMENTS_READ_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "knowledge.requirements.read",
  category: "search",
  owner: "keiko-server",
  emitter: "requirement-inventory-activity.logRequirementRead",
  fields: {
    view: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["units", "documents", "change-queries"],
    },
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["served", "refused", "cursor-stale", "unavailable"],
    },
    cursorUsed: { type: "boolean", dataClass: "closed-enum", required: true },
    detectedCount: COUNT,
    matchedCount: COUNT,
    returnedCount: COUNT,
    documentsScanned: COUNT,
    documentsNotExtracted: COUNT,
    documentsOmitted: COUNT,
    unitsOmitted: COUNT,
    resultBytes: COUNT,
    hasNextPage: { type: "boolean", dataClass: "closed-enum", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [
    { field: "disposition", values: ["unavailable", "cursor-stale"] },
    { field: "unitsOmitted", positive: true },
    { field: "documentsOmitted", positive: true },
  ],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["requirement-inventory"],
  proofIds: ["knowledge.requirements.read.line"],
  releaseImpact: "patch",
});

export function logRequirementRead(
  correlationId: string | undefined,
  activity: RequirementReadActivity,
): void {
  const event = activityLogEvent(
    REQUIREMENTS_READ_OPERATION,
    { correlationId: correlationIdOrUnknown(correlationId) },
    { ...activity, completeness: "complete", loss: "none" },
  );
  const logger = getServerLogger();
  if (activity.disposition === "unavailable") logger.warn(event);
  else logger.info(event);
}

export type RequirementTraceOperation = "create" | "edit" | "draft";

export interface RequirementTraceActivity {
  readonly operation: RequirementTraceOperation;
  /** Items that carried `requirementIds` (an item without them is not traced and not counted). */
  readonly tracedItemCount: number;
  /** Items refused before any write because a reference was unknown, ambiguous or malformed. */
  readonly refusedItemCount: number;
  readonly referenceProblemCount: number;
  readonly labelsAppliedCount: number;
  readonly footerAppliedCount: number;
  readonly droppedLabelCount: number;
  /** The Pods could not be read; the write was refused. */
  readonly unavailable: boolean;
}

const REQUIREMENT_TRACE_APPLIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "knowledge.requirement-trace.applied",
  category: "search",
  owner: "keiko-server",
  emitter: "requirement-inventory-activity.logRequirementTrace",
  fields: {
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["create", "edit", "draft"],
    },
    tracedItemCount: COUNT,
    refusedItemCount: COUNT,
    referenceProblemCount: COUNT,
    labelsAppliedCount: COUNT,
    footerAppliedCount: COUNT,
    droppedLabelCount: COUNT,
    unavailable: { type: "boolean", dataClass: "closed-enum", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [
    { field: "unavailable", values: [true] },
    { field: "refusedItemCount", positive: true },
    { field: "droppedLabelCount", positive: true },
  ],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["requirement-inventory"],
  proofIds: ["knowledge.requirement-trace.applied.line"],
  releaseImpact: "patch",
});

export function logRequirementTrace(
  correlationId: string | undefined,
  activity: RequirementTraceActivity,
): void {
  const event = activityLogEvent(
    REQUIREMENT_TRACE_APPLIED_OPERATION,
    { correlationId: correlationIdOrUnknown(correlationId) },
    { ...activity, completeness: "complete", loss: "none" },
  );
  const logger = getServerLogger();
  if (activity.unavailable || activity.refusedItemCount > 0) logger.warn(event);
  else logger.info(event);
}
