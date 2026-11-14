import { isMarkdownSkillRefusalReason } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { OPTIONAL_COUNT_FIELD } from "./activity-log-field-shapes.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";

const MARKDOWN_SKILL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "skills.library.operation",
  category: "setup",
  owner: "keiko-server",
  emitter: "markdown-skill-log.logMarkdownSkillOperation",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "list",
        "read",
        "import",
        "replace",
        "delete",
        "export",
        "generate",
        "selection-read",
        "selection-change",
        "jira-template-list",
        "jira-template-validate",
        "jira-template-propose",
      ],
    },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["started", "completed", "rejected", "failed"],
    },
    httpStatus: { type: "integer", dataClass: "count", required: true },
    // Why a rejected save was refused: the closed reason the browser also receives, never text.
    // Kept equal to MARKDOWN_SKILL_REFUSAL_REASONS by a route test (a registration must be literal).
    refusalReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "template-marker-misplaced",
        "template-not-a-template",
        "template-front-matter-unterminated",
        "template-malformed-line",
        "template-unknown-key",
        "template-duplicate-key",
        "template-missing-key",
        "template-invalid-value",
        "template-limit-exceeded",
        "template-unsafe-pattern",
        "template-no-rules",
        "text-empty",
        "text-control-characters",
      ],
    },
    // A Jira template proposal accounts for every issue type of the project (#4354): the number of
    // types and of proposals, and the number without one per closed reason. Counts only.
    typeCount: OPTIONAL_COUNT_FIELD,
    proposalCount: OPTIONAL_COUNT_FIELD,
    nothingToLearnCount: OPTIONAL_COUNT_FIELD,
    templateInvalidCount: OPTIONAL_COUNT_FIELD,
    jiraUnavailableCount: OPTIONAL_COUNT_FIELD,
    beyondLimitCount: OPTIONAL_COUNT_FIELD,
    // Proposals kept although one of their two Jira reads was not answered (#4354).
    partialProposalCount: OPTIONAL_COUNT_FIELD,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["markdown-skill-library"],
  proofIds: ["skills.library.operation.lifecycle"],
  releaseImpact: "minor",
});

export type MarkdownSkillAction =
  | "list"
  | "read"
  | "import"
  | "replace"
  | "delete"
  | "export"
  | "generate"
  | "selection-read"
  | "selection-change"
  | "jira-template-list"
  | "jira-template-validate"
  | "jira-template-propose";

/** What a template proposal accounted for, as counts per closed reason (#4354). */
export interface MarkdownSkillProposalAccounting {
  readonly typeCount: number;
  readonly proposalCount: number;
  readonly nothingToLearnCount: number;
  readonly templateInvalidCount: number;
  readonly jiraUnavailableCount: number;
  readonly beyondLimitCount: number;
  readonly partialProposalCount: number;
}

export function logMarkdownSkillOperation(
  correlationId: string | undefined,
  action: MarkdownSkillAction,
  phase: "started" | "completed" | "rejected" | "failed",
  status: number,
  accounting?: MarkdownSkillProposalAccounting,
  refusalReason?: string,
): void {
  processServerLogSink().write(
    activityLogEvent(
      MARKDOWN_SKILL_OPERATION,
      { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        action,
        phase,
        httpStatus: status,
        ...accounting,
        ...(isMarkdownSkillRefusalReason(refusalReason) ? { refusalReason } : {}),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

const MARKDOWN_SKILL_WORKFLOW_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "skills.workflow.attached",
  category: "gateway",
  owner: "keiko-server",
  emitter: "markdown-skill-log.logMarkdownSkillWorkflowAttachment",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    workflow: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unit-tests", "bug-investigation"],
    },
    // `attached` for a model call that carries the skill; `refused` for an attempt its check stopped.
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["attached", "refused"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["skill-unavailable", "authority-invalid"],
    },
    skillRevision: { type: "integer", dataClass: "count", required: true },
    skillDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    skillByteCount: OPTIONAL_COUNT_FIELD,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["markdown-skill-library"],
  proofIds: ["skills.workflow.attached.line"],
  releaseImpact: "minor",
});

export interface MarkdownSkillWorkflowAttachment {
  readonly runId: string;
  readonly workflow: "unit-tests" | "bug-investigation";
  readonly skill: { readonly revision: number; readonly digest: string };
  readonly outcome:
    | { readonly phase: "attached"; readonly byteCount: number }
    | { readonly phase: "refused"; readonly reason: "skill-unavailable" | "authority-invalid" };
}

/** One model call of a workflow run that carries its selected skill, or one attempt it stopped. */
export function logMarkdownSkillWorkflowAttachment(event: MarkdownSkillWorkflowAttachment): void {
  const { outcome } = event;
  processServerLogSink().write(
    activityLogEvent(
      MARKDOWN_SKILL_WORKFLOW_OPERATION,
      {
        correlationId: event.runId,
        ...(outcome.phase === "refused" ? { level: "warn" as const } : {}),
      },
      {
        runId: event.runId,
        workflow: event.workflow,
        phase: outcome.phase,
        skillRevision: event.skill.revision,
        skillDigest: event.skill.digest,
        ...(outcome.phase === "attached"
          ? { skillByteCount: outcome.byteCount }
          : { reason: outcome.reason }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
