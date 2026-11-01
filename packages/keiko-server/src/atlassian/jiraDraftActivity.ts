import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { JiraDraftActivity, JiraDraftRefusal } from "@oscharko-dev/keiko-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";

/** Refusals of the final `jira.draft` call that names a staged draft, beside the staging ones. */
type JiraDraftSubmitRefusal = "draft-changed" | "draft-invalid";
type JiraDraftRefusalKind = JiraDraftRefusal | JiraDraftSubmitRefusal;

const JIRA_DRAFT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.jira-draft",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraDraftActivity.recordJiraDraftActivity",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["staged", "submitted", "refused"],
    },
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "invalid-input",
        "unsupported-deployment",
        "draft-not-found",
        "connection-changed",
        "duplicate-ref",
        "too-many-items",
        "too-large",
        "template-violation",
        "draft-changed",
        "draft-invalid",
      ],
    },
    newDraft: { type: "boolean", dataClass: "closed-enum", required: true },
    pageItemCount: { type: "integer", dataClass: "count", required: true },
    itemCount: { type: "integer", dataClass: "count", required: true },
    pageCount: { type: "integer", dataClass: "count", required: true },
    byteCount: { type: "integer", dataClass: "count", required: true },
    unresolvedRefCount: { type: "integer", dataClass: "count", required: true },
    violationCount: { type: "integer", dataClass: "count", required: true },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["atlassian.jira-draft.line"],
  releaseImpact: "minor",
});

export interface JiraDraftLogInput extends Omit<JiraDraftActivity, "phase" | "refusal"> {
  readonly phase: JiraDraftActivity["phase"] | "submitted";
  readonly refusal?: JiraDraftRefusalKind;
}

const REFUSAL_KIND: Readonly<Record<JiraDraftRefusalKind, ActivityLogErrorKind>> = {
  "invalid-input": "invalid-request",
  "unsupported-deployment": "unavailable",
  "draft-not-found": "invalid-request",
  "connection-changed": "conflict",
  "duplicate-ref": "invalid-request",
  "too-many-items": "invalid-request",
  "too-large": "invalid-request",
  "template-violation": "invalid-request",
  "draft-changed": "conflict",
  "draft-invalid": "invalid-request",
};

/** Counts and closed words only: no summary, field value, issue key, ref or draft id. */
export function recordJiraDraftActivity(
  log: ServerLogSink | undefined,
  correlationId: string,
  input: JiraDraftLogInput,
): void {
  const errorKind = input.refusal === undefined ? undefined : REFUSAL_KIND[input.refusal];
  (log ?? processServerLogSink()).write(
    activityLogEvent(
      JIRA_DRAFT_OPERATION,
      {
        correlationId,
        level: errorKind === undefined ? "info" : "warn",
        ...(errorKind === undefined ? {} : { errorKind }),
      },
      {
        phase: input.phase,
        ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
        newDraft: input.newDraft,
        pageItemCount: input.pageItemCount,
        itemCount: input.itemCount,
        pageCount: input.pageCount,
        byteCount: input.byteCount,
        unresolvedRefCount: input.unresolvedRefCount,
        violationCount: input.violationCount,
        durationMs: input.durationMs,
        completeness: errorKind === undefined ? "complete" : "partial",
        loss: "none",
      },
    ),
  );
}
