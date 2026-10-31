import type { JiraIssueTemplateSource } from "@oscharko-dev/keiko-connectors";
import {
  type JiraMutationAttempt,
  type JiraTemplateRuleId,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { UiHandlerDeps } from "../deps.js";

/**
 * Customer-defined issue templates (#4177): where the active templates come from and how a
 * refusal is recorded. The library is the private Markdown skill store; there is no second store.
 */
export function jiraIssueTemplateSource(
  store: Pick<UiHandlerDeps["store"], "markdownSkills">,
): JiraIssueTemplateSource {
  return () => {
    const entries = store.markdownSkills.jiraTemplates();
    const broken = entries.filter((entry) => entry.template === undefined);
    return {
      templates: entries.flatMap((entry) => (entry.template === undefined ? [] : [entry.template])),
      unreadable: broken.length,
      unreadableNames: broken.map((entry) => entry.skill.name),
    };
  };
}

const TEMPLATE_ADMISSION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.template.admission",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraTemplateLog.recordJiraTemplateRefusal",
  fields: {
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["jira.create", "jira.edit", "jira.transition"],
    },
    // `pre-approval` is the dry run before a human is asked; `dispatch` is the gate in front of
    // the Jira request, which holds in every autonomy mode.
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pre-approval", "dispatch"],
    },
    violationCount: { type: "integer", dataClass: "count", required: true },
    ruleIds: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      // Literal on purpose (the registry reads a closed literal); a test pins it to the contract.
      values: [
        "summary-too-short",
        "summary-too-long",
        "summary-pattern",
        "section-missing",
        "section-empty",
        "field-missing",
        "field-unavailable",
        "label-missing",
        "label-pattern",
        "label-count",
        "parent-missing",
        "template-unreadable",
      ],
      maxItems: 25,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["markdown-skill-library"],
  proofIds: ["jira.template.admission.line"],
  releaseImpact: "minor",
});

export type JiraTemplateOperation = "jira.create" | "jira.edit" | "jira.transition";

function templateOperation(value: string): JiraTemplateOperation | undefined {
  return value === "jira.create" || value === "jira.edit" || value === "jira.transition"
    ? value
    : undefined;
}

/** Counts and closed rule ids only: neither a field name, a section title nor a value. */
export function recordJiraTemplateRefusal(
  correlationId: string | undefined,
  input: {
    readonly operation: string;
    readonly stage: "pre-approval" | "dispatch";
    readonly violations: readonly { readonly ruleId: JiraTemplateRuleId }[];
  },
): void {
  const operation = templateOperation(input.operation);
  if (operation === undefined) return;
  processServerLogSink().write(
    activityLogEvent(
      TEMPLATE_ADMISSION,
      { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID, level: "warn" },
      {
        operation,
        stage: input.stage,
        violationCount: input.violations.length,
        ruleIds: [...new Set(input.violations.map((violation) => violation.ruleId))],
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

/** Record a dispatch-stage refusal carried by a mutation attempt; other failures are not ours. */
export function recordJiraTemplateAttempt(
  correlationId: string | undefined,
  operation: string,
  attempt: JiraMutationAttempt,
): void {
  if (attempt.ok || attempt.violations === undefined) return;
  recordJiraTemplateRefusal(correlationId, {
    operation,
    stage: "dispatch",
    violations: attempt.violations,
  });
}
