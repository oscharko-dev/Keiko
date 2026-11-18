import {
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  jiraTemplateGovernsWrites,
  type JiraIssueTemplate,
  type JiraTemplateFieldRole,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  collectJiraTemplateViolations,
  dedupeJiraTemplateViolations,
  matchingJiraIssueTemplates,
  resolveJiraTemplateFieldIds,
  type JiraAttributedTemplateViolation,
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
import { bindJiraTemplateParentTypes } from "./jira-template-parent-types.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

/**
 * The compliance section of the report (#4181) fed by the one template checker (#4177) and the
 * same template source as the write gate. A template activated on create or on edit defines the
 * structure an issue of its project and type has to have, so the report judges every issue against
 * it as the state its next edit would leave. Templates the product itself proposes are activated
 * on create only, and a lead who evaluates existing issues against them expects the deviations
 * of the issues that predate the template. A template activated only on a transition is a
 * definition of ready for that step, not a structure, and governs that transition alone.
 */

/** Fields the checker reads whatever the template asks for. */
const CHECKED_FIELDS = ["summary", "description", "labels", "issuelinks"] as const;

function definesStructure(template: JiraIssueTemplate): boolean {
  return jiraTemplateGovernsWrites(template);
}

/** The report judges the state an edit would leave, whatever write the template was meant for. */
function judgedOnEdit(template: JiraIssueTemplate): JiraIssueTemplate {
  return { ...template, activations: [{ kind: "edit" }] };
}

function catalogOf(
  instance: readonly JiraReportFieldCatalogEntry[] | undefined,
): readonly JiraFieldCatalogEntry[] {
  const known = new Map<string, JiraFieldCatalogEntry>();
  for (const entry of JIRA_TEMPLATE_SYSTEM_FIELDS) known.set(entry.id, entry);
  for (const entry of instance ?? []) known.set(entry.id, entry);
  return [...known.values()];
}

function references(templates: readonly JiraIssueTemplate[]): readonly {
  readonly template: JiraIssueTemplate;
  readonly reference: string;
  readonly role: JiraTemplateFieldRole;
}[] {
  return templates.flatMap((template) =>
    [
      ...template.requiredFields.map((reference) => ({ reference, role: "required" as const })),
      ...(template.parent.field === undefined
        ? []
        : [{ reference: template.parent.field, role: "parent" as const }]),
    ].map((entry) => ({ template, ...entry })),
  );
}

function unresolved(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): boolean {
  return references(templates).some(
    ({ reference, template, role }) =>
      resolveJiraTemplateFieldIds(reference, catalog, template, role).length === 0,
  );
}

function fieldIdsOf(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): readonly string[] {
  const ids = new Set<string>(CHECKED_FIELDS);
  for (const { reference, template, role } of references(templates))
    for (const id of resolveJiraTemplateFieldIds(reference, catalog, template, role)) ids.add(id);
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

/**
 * The one field a violation concerns, when that is determinable without reading a value. A clause's
 * own template and role decide which native field its written name is bound to: the parent clause
 * and a required clause can write the same name for different fields.
 */
function fieldOf(
  entry: JiraAttributedTemplateViolation,
  catalog: readonly JiraFieldCatalogEntry[],
): string | undefined {
  const { violation, role, template } = entry;
  const fixed = RULE_FIELD[violation.ruleId];
  if (fixed !== undefined) return fixed;
  if (!["field-missing", "field-unavailable", "parent-missing"].includes(violation.ruleId))
    return undefined;
  const ids =
    role === undefined
      ? resolveJiraTemplateFieldIds(violation.subject, catalog)
      : resolveJiraTemplateFieldIds(violation.subject, catalog, template, role);
  return ids.length === 1 ? ids[0] : undefined;
}

const FIELD_SUBJECT_RULES: ReadonlySet<string> = new Set([
  "field-missing",
  "field-unavailable",
  "parent-missing",
]);

/**
 * What the rule concerns, in words a person recognizes: the instance's name of a field the
 * template refers to by id, otherwise the template's own element (a section, a label).
 */
function deviationSubject(
  violation: JiraTemplateViolation,
  fieldId: string | undefined,
  catalog: readonly JiraFieldCatalogEntry[],
): string {
  if (fieldId === undefined || !FIELD_SUBJECT_RULES.has(violation.ruleId)) return violation.subject;
  return catalog.find((entry) => entry.id === fieldId)?.name ?? violation.subject;
}

function deviation(
  entry: JiraAttributedTemplateViolation,
  catalog: readonly JiraFieldCatalogEntry[],
): JiraReportDeviation {
  const { violation } = entry;
  const fieldId = fieldOf(entry, catalog);
  return {
    ruleId: violation.ruleId,
    ...(fieldId === undefined ? {} : { fieldId }),
    subject: deviationSubject(violation, fieldId, catalog),
  };
}

/**
 * An issue record without an issue type id cannot be matched to a template bound by id, and its
 * localized name proves nothing about one: it is neither covered nor uncovered, so it is judged
 * `unavailable` and the report says so instead of counting it "without template" (#4354).
 */
function needsTypeId(
  templates: readonly JiraIssueTemplate[],
  facts: Pick<JiraReportIssueFacts, "projectKey" | "issueTypeId">,
): boolean {
  return (
    facts.issueTypeId.length === 0 &&
    templates.some(
      (template) =>
        template.binding !== undefined &&
        template.project.trim().toLowerCase() === facts.projectKey.trim().toLowerCase(),
    )
  );
}

function checkerOf(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): JiraReportComplianceChecker {
  return {
    fieldIds: fieldIdsOf(templates, catalog),
    ...(templates.some((template) => template.parent.issueTypes !== undefined)
      ? { requiresNativeEvidence: true as const }
      : {}),
    covers: (facts) =>
      needsTypeId(templates, facts) ||
      matchingJiraIssueTemplates(templates, subjectOf(facts)).length > 0,
    check: (facts, request) =>
      needsTypeId(templates, facts)
        ? Promise.resolve("unavailable" as const)
        : checkSubject(templates, catalog, subjectOf(facts), request),
  };
}

async function checkSubject(
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
  subject: JiraTemplateSubject,
  request: JiraMutationRequest | undefined,
): Promise<readonly JiraReportDeviation[] | "unavailable"> {
  const matching = matchingJiraIssueTemplates(templates, subject);
  const needsParent = matching.some((template) => template.parent.issueTypes !== undefined);
  if (!parentFieldsObserved(matching, subject, catalog)) return "unavailable";
  if (needsParent && request === undefined) return "unavailable";
  const bound =
    needsParent && request !== undefined
      ? await bindJiraTemplateParentTypes(request, subject, matching, catalog)
      : subject;
  const entries = dedupeJiraTemplateViolations(
    collectJiraTemplateViolations(matching, bound, catalog),
  ).slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX);
  if (entries.some(({ violation }) => violation.ruleId === "template-unreadable"))
    return "unavailable";
  return entries.map((entry) => deviation(entry, catalog));
}

/** A withheld requested field is unknown; an observed null still proves an absent parent. */
function parentFieldsObserved(
  templates: readonly JiraIssueTemplate[],
  subject: JiraTemplateSubject,
  catalog: readonly JiraFieldCatalogEntry[],
): boolean {
  return templates.every((template) => {
    const { parent } = template;
    if (parent.field === undefined) return true;
    const ids = resolveJiraTemplateFieldIds(parent.field, catalog, template, "parent");
    return ids.length === 1 && ids.every((id) => Object.hasOwn(subject.fields, id));
  });
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
      const templates = set.templates.filter(definesStructure).map(judgedOnEdit);
      if (templates.length === 0) return "none";
      const catalog = catalogOf(instance);
      return instance === undefined && unresolved(templates, catalog)
        ? "unavailable"
        : checkerOf(templates, catalog);
    },
  };
}
