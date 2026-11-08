import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { JiraDraftActivity, JiraDraftRefusal } from "@oscharko-dev/keiko-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";
import { JIRA_TEMPLATE_RULE_COUNT_FIELDS, jiraTemplateRuleCountFields } from "./jiraTemplateLog.js";

/**
 * Refusals of the final `jira.draft` call beside the staging ones. `requirements-untraced` is the
 * once-per-turn advisory for a draft whose items name no requirement in a Chat that holds some.
 */
type JiraDraftSubmitRefusal = "draft-changed" | "draft-invalid" | "requirements-untraced";
type JiraDraftRefusalKind = JiraDraftRefusal | JiraDraftSubmitRefusal;

const COUNT_FIELD = { type: "integer", dataClass: "count", required: true } as const;

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
      values: ["staged", "submitted", "refused", "progress", "executed", "named"],
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
        "too-large",
        "template-violation",
        "invalid-fields",
        "draft-changed",
        "draft-invalid",
        "requirements-untraced",
      ],
    },
    newDraft: { type: "boolean", dataClass: "closed-enum", required: true },
    pageItemCount: COUNT_FIELD,
    itemCount: COUNT_FIELD,
    pageCount: COUNT_FIELD,
    byteCount: COUNT_FIELD,
    unresolvedRefCount: COUNT_FIELD,
    violationCount: COUNT_FIELD,
    ...JIRA_TEMPLATE_RULE_COUNT_FIELDS,
    settledCount: { type: "integer", dataClass: "count", required: false },
    pendingCount: { type: "integer", dataClass: "count", required: false },
    // A staging call or a create run: Jira reads sent, and reads answered from the invocation's own
    // memo (a create run shares only batch-identical create metadata; search and read-back stay live).
    readCount: { type: "integer", dataClass: "count", required: false },
    readReusedCount: { type: "integer", dataClass: "count", required: false },
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
  /**
   * `named`: a tool turn told the model which staged draft the Chat holds (#4292). Naming stages,
   * checks and waits for nothing, so its page, reference, violation and duration counts are zero.
   */
  readonly phase: JiraDraftActivity["phase"] | "submitted" | "named";
  readonly refusal?: JiraDraftRefusalKind;
}

const REFUSAL_KIND: Readonly<Record<JiraDraftRefusalKind, ActivityLogErrorKind>> = {
  "invalid-input": "invalid-request",
  "unsupported-deployment": "unavailable",
  "draft-not-found": "invalid-request",
  "connection-changed": "conflict",
  "duplicate-ref": "invalid-request",
  "too-large": "invalid-request",
  "template-violation": "invalid-request",
  "invalid-fields": "invalid-request",
  "draft-changed": "conflict",
  "draft-invalid": "invalid-request",
  "requirements-untraced": "invalid-request",
};

function readFields(input: JiraDraftLogInput): Record<string, number> {
  return {
    ...(input.readCount === undefined ? {} : { readCount: input.readCount }),
    ...(input.readReusedCount === undefined ? {} : { readReusedCount: input.readReusedCount }),
  };
}

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
        ...jiraTemplateRuleCountFields(input.violationRuleCounts),
        ...(input.settledCount === undefined ? {} : { settledCount: input.settledCount }),
        ...(input.pendingCount === undefined ? {} : { pendingCount: input.pendingCount }),
        ...readFields(input),
        durationMs: input.durationMs,
        completeness: errorKind === undefined ? "complete" : "partial",
        loss: "none",
      },
    ),
  );
}
