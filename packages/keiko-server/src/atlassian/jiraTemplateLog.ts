import type {
  JiraIssueTemplateSource,
  JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_LINK_MUTATIONS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_TEMPLATE_RULE_IDS,
  type JiraFieldValidationFailure,
  type JiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationOperation,
  type JiraTemplateRuleId,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { UiHandlerDeps } from "../deps.js";
import { jiraToolLogFields } from "./jiraOperationLogFields.js";
import { recordJiraOperationActivity } from "./jiraOperationActivity.js";

const RULE_COUNT = { type: "integer", dataClass: "count", required: false } as const;
/** Exact closed rule IDs projected into the existing camel-case Activity Log field grammar. */
const RULE_COUNT_NAMES = {
  "summary-too-short": "summaryTooShortCount",
  "summary-too-long": "summaryTooLongCount",
  "summary-pattern": "summaryPatternCount",
  "section-missing": "sectionMissingCount",
  "section-empty": "sectionEmptyCount",
  "field-missing": "fieldMissingCount",
  "field-unavailable": "fieldUnavailableCount",
  "label-missing": "labelMissingCount",
  "label-pattern": "labelPatternCount",
  "label-count": "labelCountCount",
  "parent-missing": "parentMissingCount",
  "parent-type-mismatch": "parentTypeMismatchCount",
  "template-unreadable": "templateUnreadableCount",
  "template-missing": "templateMissingCount",
  "template-not-activated": "templateNotActivatedCount",
} as const satisfies Readonly<Record<JiraTemplateRuleId, string>>;
type RuleCountField = (typeof RULE_COUNT_NAMES)[JiraTemplateRuleId];

export const JIRA_TEMPLATE_RULE_COUNT_FIELDS = {
  summaryTooShortCount: RULE_COUNT,
  summaryTooLongCount: RULE_COUNT,
  summaryPatternCount: RULE_COUNT,
  sectionMissingCount: RULE_COUNT,
  sectionEmptyCount: RULE_COUNT,
  fieldMissingCount: RULE_COUNT,
  fieldUnavailableCount: RULE_COUNT,
  labelMissingCount: RULE_COUNT,
  labelPatternCount: RULE_COUNT,
  labelCountCount: RULE_COUNT,
  parentMissingCount: RULE_COUNT,
  parentTypeMismatchCount: RULE_COUNT,
  templateUnreadableCount: RULE_COUNT,
  templateMissingCount: RULE_COUNT,
  templateNotActivatedCount: RULE_COUNT,
} satisfies Readonly<Record<RuleCountField, typeof RULE_COUNT>>;

export function jiraTemplateRuleCountFields(
  counts: Partial<Readonly<Record<JiraTemplateRuleId, number>>> | undefined,
): Partial<Record<RuleCountField, number>> {
  const fields: Partial<Record<RuleCountField, number>> = {};
  for (const ruleId of JIRA_TEMPLATE_RULE_IDS) {
    const count = counts?.[ruleId];
    if (count !== undefined) fields[RULE_COUNT_NAMES[ruleId]] = count;
  }
  return fields;
}

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
    // The parser cache shares equal bodies; each stored revision needs its own source binding.
    const readable = entries.flatMap(({ skill, template }) =>
      template === undefined ? [] : [{ skill, template: { ...template } }],
    );
    return {
      templates: readable.map(({ template }) => template),
      references: readable.map(({ skill, template }) => ({
        template,
        id: skill.id,
        revision: skill.revision,
        digest: skill.digest,
      })),
      unreadable: broken.length,
      unreadableNames: broken.map((entry) => entry.skill.name),
    };
  };
}

type TemplateMetadataActivity = Parameters<
  NonNullable<JiraManagedConnection["templateMetadataActivity"]>
>[0];
const METADATA_COUNT = { type: "integer", dataClass: "count", required: true } as const;
const TEMPLATE_METADATA = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.template.metadata",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraTemplateLog.recordJiraTemplateMetadata",
  fields: {
    matchedCount: METADATA_COUNT,
    returnedCount: METADATA_COUNT,
    omittedCount: METADATA_COUNT,
    unreadableCount: METADATA_COUNT,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["markdown-skill-library"],
  proofIds: ["jira.template.metadata.line"],
  releaseImpact: "patch",
});

/** Counts only: no template identifiers, names, section titles, field names or bodies. */
export function recordJiraTemplateMetadata(
  sink: UiHandlerDeps["activityLog"],
  correlationId: string | undefined,
  activity: TemplateMetadataActivity,
): void {
  (sink ?? processServerLogSink()).write(
    activityLogEvent(
      TEMPLATE_METADATA,
      {
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      },
      { ...activity, completeness: "complete", loss: "none" },
    ),
  );
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
      values: [
        "jira.delete-issue",
        "jira.delete-project",
        "jira.create-issues",
        "jira.create-reciprocal-remote-link",
        "jira.delete-custom-fields",
        "jira.delete-issue-type",
        "jira.update-issue-type",
        "jira.delete-link-type",
        "jira.update-link-type",
        "jira.epic-remove-issues",
        "jira.rank-epic",
        "jira.rank-issues",
        "jira.set-issue-estimation",
        "jira.replace-sprint",
        "jira.delete-sprint",
        "jira.create-issue-link",
        "jira.delete-issue-link",
        "jira.upsert-remote-link",
        "jira.update-remote-link",
        "jira.delete-remote-link",
        "jira.delete-remote-link-by-global-id",
        "jira.delete-component",
        "jira.merge-version",
        "jira.remove-and-swap-version",
        "jira.create",
        "jira.create-worklog",
        "jira.update-worklog",
        "jira.delete-worklog",
        "jira.edit",
        "jira.transition",
        "jira.assign",
        "jira.board-create",
        "jira.sprint-create",
        "jira.sprint-update",
        "jira.sprint-move-issues",
        "jira.backlog-move-issues",
        "jira.epic-update",
        "jira.epic-move-issues",
      ],
    },
    // `pre-approval` is the dry run before a human is asked; `dispatch` is the gate in front of
    // the Jira request, which holds in every autonomy mode.
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pre-approval", "dispatch", "notice"],
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
        "parent-type-mismatch",
        "template-unreadable",
        "template-missing",
        "template-not-activated",
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

const FIELD_ADMISSION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.field.admission",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraTemplateLog.recordJiraFieldRefusal",
  fields: {
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["jira-write"],
    },
    operationDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    refusedCount: { type: "integer", dataClass: "count", required: true },
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pre-approval", "dispatch"],
    },
    fieldClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["system", "custom", "other"],
    },
    systemFieldId: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      // Literal on purpose (the registry reads a closed literal); a test pins it to the allow-list.
      values: [
        "summary",
        "description",
        "issuetype",
        "project",
        "labels",
        "priority",
        "components",
        "fixVersions",
        "versions",
        "parent",
        "assignee",
        "reporter",
        "duedate",
        "environment",
      ],
    },
    templateViolationCount: { type: "integer", dataClass: "count", required: false },
    validations: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      // Literal on purpose (the registry reads a closed literal); a test pins it to the contract.
      values: [
        "required-field",
        "unsupported-field",
        "invalid-field",
        "invalid-operation",
        "bounds-exceeded",
      ],
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["jira.field.admission.line"],
  releaseImpact: "minor",
});

const TEMPLATE_OPERATIONS = [
  "jira.delete-issue",
  "jira.delete-project",
  "jira.create-issues",
  "jira.create-reciprocal-remote-link",
  "jira.delete-custom-fields",
  "jira.delete-issue-type",
  "jira.update-issue-type",
  "jira.delete-link-type",
  "jira.update-link-type",
  "jira.epic-remove-issues",
  "jira.rank-epic",
  "jira.rank-issues",
  "jira.set-issue-estimation",
  "jira.replace-sprint",
  "jira.delete-sprint",
  ...JIRA_LINK_MUTATIONS,
  "jira.delete-component",
  "jira.merge-version",
  "jira.remove-and-swap-version",
  "jira.create",
  "jira.create-worklog",
  "jira.update-worklog",
  "jira.delete-worklog",
  "jira.edit",
  "jira.transition",
  "jira.assign",
  "jira.board-create",
  "jira.sprint-create",
  "jira.sprint-update",
  "jira.sprint-move-issues",
  "jira.backlog-move-issues",
  "jira.epic-update",
  "jira.epic-move-issues",
] as const;
export type JiraTemplateOperation = (typeof TEMPLATE_OPERATIONS)[number];

function templateOperation(value: string): JiraTemplateOperation | undefined {
  return TEMPLATE_OPERATIONS.find((operation) => operation === value);
}

/** Counts and closed rule ids only: neither a field name, a section title nor a value. */
export function recordJiraTemplateRefusal(
  correlationId: string | undefined,
  input: {
    readonly operation: string;
    readonly stage: "pre-approval" | "dispatch" | "notice";
    readonly violations: readonly { readonly ruleId: JiraTemplateRuleId }[];
  },
): void {
  const operation = templateOperation(input.operation);
  if (operation === undefined) return;
  processServerLogSink().write(
    activityLogEvent(
      TEMPLATE_ADMISSION,
      {
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        level: input.stage === "notice" ? "info" : "warn",
      },
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

/** Jira system fields whose id is a closed word; any other id is only classed, never logged. */
export const JIRA_LOGGED_SYSTEM_FIELD_IDS = [
  "summary",
  "description",
  "issuetype",
  "project",
  "labels",
  "priority",
  "components",
  "fixVersions",
  "versions",
  "parent",
  "assignee",
  "reporter",
  "duedate",
  "environment",
] as const;
type LoggedSystemFieldId = (typeof JIRA_LOGGED_SYSTEM_FIELD_IDS)[number];
const CUSTOM_FIELD_ID = /^customfield_\d{1,16}$/u;

/** The refused field as a closed class and, for a known system field only, its closed id. */
function refusedFieldFacts(fieldId: string | undefined): {
  readonly fieldClass?: "system" | "custom" | "other";
  readonly systemFieldId?: LoggedSystemFieldId;
} {
  if (fieldId === undefined) return {};
  const system = JIRA_LOGGED_SYSTEM_FIELD_IDS.find((id) => id === fieldId);
  if (system !== undefined) return { fieldClass: "system", systemFieldId: system };
  return { fieldClass: CUSTOM_FIELD_ID.test(fieldId) ? "custom" : "other" };
}

/** A proposed write Keiko's own validation refused before a human was asked: closed words, counts. */
export function recordJiraFieldRefusal(
  correlationId: string | undefined,
  input: {
    readonly operation: JiraMutationOperation;
    readonly refusedCount: number;
    readonly validations: readonly (JiraFieldValidationFailure | undefined)[];
    readonly stage?: "pre-approval" | "dispatch";
    readonly fieldId?: string;
    readonly templateViolationCount?: number;
  },
): void {
  const operation = jiraToolLogFields(input.operation);
  if (operation.toolClass !== "jira-write")
    throw new TypeError("Field refusal requires a Jira mutation");
  const sink = processServerLogSink();
  sink.write(
    activityLogEvent(
      FIELD_ADMISSION,
      { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID, level: "info" },
      {
        operation: "jira-write",
        operationDigest: operation.toolDigest,
        refusedCount: input.refusedCount,
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...refusedFieldFacts(input.fieldId),
        ...(input.templateViolationCount === undefined
          ? {}
          : { templateViolationCount: input.templateViolationCount }),
        validations: [...new Set(input.validations.filter((value) => value !== undefined))],
        completeness: "complete",
        loss: "none",
      },
    ),
  );
  recordJiraOperationActivity(
    sink,
    { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID, level: "info" },
    input.operation,
    {
      stage: "field-admission",
      outcome: "refused",
      reason: "field-validation",
    },
  );
}

function primaryFieldId(detail: JiraMutationFailureDetail | undefined): string | undefined {
  return detail?.fieldId ?? detail?.fieldErrors?.[0]?.fieldId;
}

/** The connector's own refusal before dispatch: which validation fired, never a message or value. */
function dispatchRefusalFacts(
  attempt: Extract<JiraMutationAttempt, { ok: false }>,
): Omit<Parameters<typeof recordJiraFieldRefusal>[1], "operation"> {
  const fieldId = primaryFieldId(attempt.detail);
  const violations = attempt.violations;
  return {
    refusedCount: Math.max(1, attempt.detail?.fieldErrors?.length ?? 0),
    validations: [attempt.detail?.validation],
    stage: "dispatch",
    ...(fieldId === undefined ? {} : { fieldId }),
    ...(violations === undefined ? {} : { templateViolationCount: violations.length }),
  };
}

function recordDispatchFieldRefusal(
  correlationId: string | undefined,
  operation: string,
  attempt: Extract<JiraMutationAttempt, { ok: false }>,
): void {
  const mutation = JIRA_MUTATION_OPERATIONS.find((candidate) => candidate === operation);
  if (mutation === undefined) return;
  recordJiraFieldRefusal(correlationId, { operation: mutation, ...dispatchRefusalFacts(attempt) });
}

/** Record a dispatch-stage refusal carried by a mutation attempt; other failures are not ours. */
export function recordJiraTemplateAttempt(
  correlationId: string | undefined,
  operation: string,
  attempt: JiraMutationAttempt,
): void {
  if (attempt.ok) {
    if (attempt.templateNotices !== undefined && attempt.templateNotices.length > 0)
      recordJiraTemplateRefusal(correlationId, {
        operation,
        stage: "notice",
        violations: attempt.templateNotices,
      });
    return;
  }
  if (attempt.reason === "field-validation")
    recordDispatchFieldRefusal(correlationId, operation, attempt);
  if (attempt.violations === undefined) return;
  recordJiraTemplateRefusal(correlationId, {
    operation,
    stage: "dispatch",
    violations: attempt.violations,
  });
}
