import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  ACTIVITY_FAILURE_DIAGNOSTIC_FIELDS,
  definedActivityFields,
} from "../activity-line-fields.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { JiraTemplateRuleId } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JIRA_TEMPLATE_RULE_COUNT_FIELDS, jiraTemplateRuleCountFields } from "./jiraTemplateLog.js";

// Body-free evidence of a Keiko-driven draft batch (#4173): how many requirements it read, how the
// grouping and each drafted page ended, and how the batch finished. Counts and closed words only;
// never a requirement, a summary, a path, a draft id or model text.

export const JIRA_DRAFT_BATCH_PHASES = [
  "started",
  "outline",
  "page",
  "completed",
  "failed",
  "refused",
] as const;
export type JiraDraftBatchPhase = (typeof JIRA_DRAFT_BATCH_PHASES)[number];

/** The engine's closed observation words plus the result words of the whole batch. */
export const JIRA_DRAFT_BATCH_OUTCOMES = [
  "grouped",
  "unassigned",
  "exhausted",
  "staged",
  "corrected",
  "refused",
  "split",
  "failed",
  "too-large",
  "succeeded",
  "partial",
] as const;
export type JiraDraftBatchOutcome = (typeof JIRA_DRAFT_BATCH_OUTCOMES)[number];

export const JIRA_DRAFT_BATCH_REFUSALS = [
  "invalid-input",
  "unsupported-deployment",
  "no-knowledge-pod",
  "scope-unavailable",
  "requirements-cut",
  "requirements-ambiguous",
  "no-requirements",
  "model-unavailable",
  "budget-unavailable",
  "template-unavailable",
  "draft-unavailable",
  "project-not-found",
  "issue-type-not-found",
  "no-usable-issue-type",
  "draft-mismatch",
] as const;
export type JiraDraftBatchRefusal = (typeof JIRA_DRAFT_BATCH_REFUSALS)[number];

/**
 * Why a batch that started stopped before every planned issue was drafted: the draft could not
 * continue, the call allowance ended, the model failed, or the person cancelled.
 */
export const JIRA_DRAFT_BATCH_STOP_REASONS = [
  "stage-failed",
  "stage-rejection-unchanged",
  "call-limit",
  "model-failed",
  "deadline",
  "cancelled",
] as const;
export type JiraDraftBatchStopReason = (typeof JIRA_DRAFT_BATCH_STOP_REASONS)[number];

export interface JiraDraftBatchActivity {
  readonly phase: JiraDraftBatchPhase;
  readonly granularity?: "per-requirement" | "grouped";
  readonly outcome?: JiraDraftBatchOutcome;
  readonly refusal?: JiraDraftBatchRefusal;
  readonly stopReason?: JiraDraftBatchStopReason;
  readonly requirementCount?: number;
  readonly plannedCount?: number;
  readonly draftedCount?: number;
  readonly failedCount?: number;
  readonly itemCount?: number;
  readonly pageItemCount?: number;
  readonly groupCount?: number;
  readonly plannedItemTokens?: number;
  readonly completionTokens?: number;
  readonly parseAttemptCount?: number;
  readonly stageAttemptCount?: number;
  readonly guidanceDigest?: string;
  readonly violationRuleCounts?: Partial<Readonly<Record<JiraTemplateRuleId, number>>>;
  readonly durationMs?: number;
  readonly createRequested?: boolean;
  /** A corrected page: the answer held no readable items object. */
  readonly unreadableAnswer?: boolean;
  readonly missingItemCount?: number;
  readonly missingSectionItemCount?: number;
  readonly missingFieldItemCount?: number;
  /** The thrown or stopping error, reduced to Keiko frames and a cause chain. */
  readonly error?: unknown;
}

const COUNT = { type: "integer", dataClass: "count", required: false } as const;

const JIRA_DRAFT_BATCH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.jira-draft-batch",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraDraftBatchActivity.recordJiraDraftBatchActivity",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...JIRA_DRAFT_BATCH_PHASES],
    },
    granularity: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["per-requirement", "grouped"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...JIRA_DRAFT_BATCH_OUTCOMES],
    },
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...JIRA_DRAFT_BATCH_REFUSALS],
    },
    stopReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...JIRA_DRAFT_BATCH_STOP_REASONS],
    },
    requirementCount: COUNT,
    plannedCount: COUNT,
    draftedCount: COUNT,
    failedCount: COUNT,
    itemCount: COUNT,
    pageItemCount: COUNT,
    groupCount: COUNT,
    plannedItemTokens: COUNT,
    completionTokens: COUNT,
    parseAttemptCount: COUNT,
    stageAttemptCount: COUNT,
    guidanceDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    ...JIRA_TEMPLATE_RULE_COUNT_FIELDS,
    createRequested: { type: "boolean", dataClass: "closed-enum", required: false },
    unreadableAnswer: { type: "boolean", dataClass: "closed-enum", required: false },
    missingItemCount: COUNT,
    missingSectionItemCount: COUNT,
    missingFieldItemCount: COUNT,
    durationMs: { type: "integer", dataClass: "duration", required: false },
    ...ACTIVITY_FAILURE_DIAGNOSTIC_FIELDS,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["atlassian.jira-draft-batch.line"],
  releaseImpact: "minor",
});

const REFUSAL_KIND: Readonly<Record<JiraDraftBatchRefusal, ActivityLogErrorKind>> = {
  "invalid-input": "invalid-request",
  "unsupported-deployment": "unavailable",
  "no-knowledge-pod": "invalid-request",
  "scope-unavailable": "unavailable",
  "requirements-cut": "validation-failed",
  "requirements-ambiguous": "invalid-request",
  "no-requirements": "invalid-request",
  "model-unavailable": "unavailable",
  "budget-unavailable": "unavailable",
  "template-unavailable": "unavailable",
  "draft-unavailable": "conflict",
  "project-not-found": "invalid-request",
  "issue-type-not-found": "invalid-request",
  "no-usable-issue-type": "invalid-request",
  "draft-mismatch": "conflict",
};

const STOP_KIND: Readonly<Record<JiraDraftBatchStopReason, ActivityLogErrorKind>> = {
  "stage-failed": "conflict",
  "stage-rejection-unchanged": "validation-failed",
  "call-limit": "validation-failed",
  "model-failed": "unavailable",
  deadline: "timeout",
  cancelled: "cancelled",
};

function errorKindOf(input: JiraDraftBatchActivity): ActivityLogErrorKind | undefined {
  if (input.stopReason !== undefined) return STOP_KIND[input.stopReason];
  if (input.phase === "failed") return "internal";
  return input.refusal === undefined ? undefined : REFUSAL_KIND[input.refusal];
}

const LINE_FIELDS = [
  "phase",
  "granularity",
  "outcome",
  "refusal",
  "stopReason",
  "requirementCount",
  "plannedCount",
  "draftedCount",
  "failedCount",
  "itemCount",
  "pageItemCount",
  "groupCount",
  "plannedItemTokens",
  "completionTokens",
  "parseAttemptCount",
  "stageAttemptCount",
  "guidanceDigest",
  "missingItemCount",
  "missingSectionItemCount",
  "missingFieldItemCount",
  "durationMs",
] as const;

/** Counts and closed words only, under the batch call's correlation. */
export function recordJiraDraftBatchActivity(
  log: ServerLogSink | undefined,
  correlationId: string,
  input: JiraDraftBatchActivity,
): void {
  const errorKind = errorKindOf(input);
  const fields = {
    ...jiraTemplateRuleCountFields(input.violationRuleCounts),
    ...(definedActivityFields(input, LINE_FIELDS) as Pick<
      JiraDraftBatchActivity,
      (typeof LINE_FIELDS)[number]
    >),
    ...(input.createRequested === undefined ? {} : { createRequested: input.createRequested }),
    ...(input.unreadableAnswer === undefined ? {} : { unreadableAnswer: input.unreadableAnswer }),
    ...(input.error === undefined
      ? {}
      : { frames: keikoStackFrames(input.error), causeChain: causeChain(input.error) }),
    completeness: errorKind === undefined ? ("complete" as const) : ("partial" as const),
    loss: "none" as const,
  };
  (log ?? processServerLogSink()).write(
    activityLogEvent(
      JIRA_DRAFT_BATCH_OPERATION,
      {
        correlationId,
        level: errorKind === undefined ? "info" : "warn",
        ...(errorKind === undefined ? {} : { errorKind }),
      },
      fields,
    ),
  );
}
