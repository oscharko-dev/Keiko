import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asRecord } from "./atlassian-sync-classify.js";
import { resolveJiraTemplateFieldIds } from "./jira-issue-template-check.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";

const TIME_FIELDS: readonly JiraFieldMetadata[] = [
  {
    id: "timespent",
    name: "Time Spent",
    kind: "number",
    required: false,
    hasDefaultValue: false,
    richText: false,
    operations: [],
  },
  {
    id: "timetracking",
    name: "Time Tracking",
    kind: "unsupported",
    required: false,
    hasDefaultValue: false,
    richText: false,
    operations: [],
  },
];
function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function projectedTime(
  prior: Readonly<Record<string, unknown>>,
  delta: number,
  minimumPrior: number,
): Readonly<Record<string, unknown>> {
  const tracking = asRecord(prior.timetracking);
  const aggregate = seconds(prior.timespent) ? prior.timespent : tracking?.timeSpentSeconds;
  const consistent =
    !seconds(prior.timespent) ||
    !seconds(tracking?.timeSpentSeconds) ||
    prior.timespent === tracking.timeSpentSeconds;
  if (!seconds(aggregate) || aggregate < minimumPrior || !consistent || !seconds(aggregate + delta))
    return { timespent: undefined, timetracking: undefined };
  // Jira's formatted timeSpent string describes the old aggregate; preserve only still-valid fields.
  const nextTracking: Record<string, unknown> = {
    ...tracking,
    timeSpentSeconds: aggregate + delta,
  };
  delete nextTracking.timeSpent;
  return { timespent: aggregate + delta, timetracking: nextTracking };
}

/** Reuse saved issue-template admission with observed post-state, never assume missing time is zero. */
export async function gateJiraWorklogChange(
  request: JiraMutationRequest,
  source: JiraIssueTemplateSource | undefined,
  issueId: string,
  prior: Readonly<Record<string, unknown>>,
  delta: number,
  minimumPrior: number,
): Promise<JiraTemplateGateResult> {
  const fields = delta === 0 ? {} : projectedTime(prior, delta, minimumPrior);
  const gate = await gateJiraMutationByTemplates({
    request,
    source,
    operation: "edit",
    metadata: TIME_FIELDS,
    validated: { fields, update: {} },
    target: { issueKey: issueId },
  });
  if (gate.ok || delta === 0 || fields.timespent !== undefined) return gate;
  return {
    ...gate,
    ...(gate.violations === undefined
      ? {}
      : {
          violations: gate.violations.map((violation) =>
            resolveJiraTemplateFieldIds(violation.subject, TIME_FIELDS).length > 0
              ? {
                  ...violation,
                  ruleId: "template-unreadable" as const,
                  subject: "Read the current time-spent aggregate before changing worklogs",
                }
              : violation,
          ),
        }),
  };
}
