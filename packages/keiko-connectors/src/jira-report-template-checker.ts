import type {
  JiraIssueTemplate,
  JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  checkJiraIssueTemplates,
  resolveJiraTemplateFieldIds,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
import {
  JIRA_TEMPLATE_SYSTEM_FIELDS,
  jiraIssueLinkTypeNames,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import type {
  JiraReportCheckerBinder,
  JiraReportComplianceChecker,
  JiraReportDeviation,
  JiraReportFieldCatalogEntry,
  JiraReportIssueFacts,
} from "./jira-report-types.js";

/**
 * The compliance section of the report (#4181) fed by the one template checker (#4177) and the
 * same template source as the write gate. The report judges an issue as the state its next edit
 * would leave, so exactly the templates the edit gate enforces apply and the two can never
 * disagree: an issue the report lists under a rule is refused on edit for that rule, and the
 * other way round. Templates activated only on create or on a transition govern those writes.
 */

/** Fields the checker reads whatever the template asks for. */
const CHECKED_FIELDS = ["summary", "description", "labels", "issuelinks"] as const;

function governsEdit(template: JiraIssueTemplate): boolean {
  return template.activations.some((activation) => activation.kind === "edit");
}

function catalogOf(
  instance: readonly JiraReportFieldCatalogEntry[] | undefined,
): readonly JiraFieldCatalogEntry[] {
  const known = new Map<string, JiraFieldCatalogEntry>();
  for (const entry of JIRA_TEMPLATE_SYSTEM_FIELDS) known.set(entry.id, entry);
  for (const entry of instance ?? []) known.set(entry.id, entry);
  return [...known.values()];
}

function references(templates: readonly JiraIssueTemplate[]): readonly string[] {
  return templates.flatMap((template) => [
    ...template.requiredFields,
    ...(template.parent.field === undefined ? [] : [template.parent.field]),
  ]);
}

function unresolved(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): boolean {
  return references(templates).some(
    (reference) => resolveJiraTemplateFieldIds(reference, catalog).length === 0,
  );
}

function fieldIdsOf(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): readonly string[] {
  const ids = new Set<string>(CHECKED_FIELDS);
  for (const reference of references(templates))
    for (const id of resolveJiraTemplateFieldIds(reference, catalog)) ids.add(id);
  return [...ids];
}

function subjectOf(facts: JiraReportIssueFacts): JiraTemplateSubject {
  return {
    operation: "edit",
    projectKey: facts.projectKey,
    issueType: {
      ...(facts.issueTypeId.length === 0 ? {} : { id: facts.issueTypeId }),
      name: facts.typeName,
    },
    fields: facts.fields,
    linkTypes: jiraIssueLinkTypeNames(facts.fields),
  };
}

const RULE_FIELD: Readonly<Record<string, string>> = {
  "summary-too-short": "summary",
  "summary-too-long": "summary",
  "summary-pattern": "summary",
  "section-missing": "description",
  "section-empty": "description",
  "label-missing": "labels",
  "label-pattern": "labels",
  "label-count": "labels",
};

/** The one field a violation concerns, when that is determinable without reading a value. */
function fieldOf(
  violation: JiraTemplateViolation,
  catalog: readonly JiraFieldCatalogEntry[],
): string | undefined {
  const fixed = RULE_FIELD[violation.ruleId];
  if (fixed !== undefined) return fixed;
  if (!["field-missing", "field-unavailable", "parent-missing"].includes(violation.ruleId))
    return undefined;
  const ids = resolveJiraTemplateFieldIds(violation.subject, catalog);
  return ids.length === 1 ? ids[0] : undefined;
}

function deviation(
  violation: JiraTemplateViolation,
  catalog: readonly JiraFieldCatalogEntry[],
): JiraReportDeviation {
  const fieldId = fieldOf(violation, catalog);
  return fieldId === undefined
    ? { ruleId: violation.ruleId }
    : { ruleId: violation.ruleId, fieldId };
}

function checkerOf(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): JiraReportComplianceChecker {
  return {
    fieldIds: fieldIdsOf(templates, catalog),
    check: (facts) =>
      checkJiraIssueTemplates(templates, subjectOf(facts), catalog).map((violation) =>
        deviation(violation, catalog),
      ),
  };
}

/**
 * Binds the shared template source to one report. The source is read once per report, so every
 * issue is judged by the same templates. An unreadable library, or a template naming a field the
 * instance does not list while the instance's field list could not be read, is `unavailable`:
 * the report states that instead of passing every issue. A source that throws propagates to the
 * caller's correlated diagnostic, like the write gate.
 */
export function createJiraReportTemplateChecker(
  source: JiraIssueTemplateSource,
): JiraReportCheckerBinder {
  return {
    bind: (instance): ReturnType<JiraReportCheckerBinder["bind"]> => {
      const set = source();
      if (set.unreadable > 0) return "unavailable";
      const templates = set.templates.filter(governsEdit);
      if (templates.length === 0) return "none";
      const catalog = catalogOf(instance);
      return instance === undefined && unresolved(templates, catalog)
        ? "unavailable"
        : checkerOf(templates, catalog);
    },
  };
}
