import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
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

export function logMarkdownSkillOperation(
  correlationId: string | undefined,
  action: MarkdownSkillAction,
  phase: "started" | "completed" | "rejected" | "failed",
  status: number,
): void {
  processServerLogSink().write(
    activityLogEvent(
      MARKDOWN_SKILL_OPERATION,
      { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID },
      { action, phase, httpStatus: status, completeness: "complete", loss: "none" },
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
    skillByteCount: { type: "integer", dataClass: "count", required: false },
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
