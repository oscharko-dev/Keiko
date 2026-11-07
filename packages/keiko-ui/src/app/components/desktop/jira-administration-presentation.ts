import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
const SCREEN_FIELDS = new Set(["jira_screen_tab_fields", "jira_screen_available_fields"]);
const WORKFLOW_SCHEMES = new Set(["jira_workflow_scheme", "jira_workflow_scheme_draft"]);
export const JIRA_ADMINISTRATION_TOOLS: ReadonlySet<string> = new Set([
  "jira_screen_tabs",
  ...SCREEN_FIELDS,
  "jira_issue_type_schemes",
  "jira_issue_type_scheme",
  "jira_issue_type_scheme_projects",
  ...WORKFLOW_SCHEMES,
  "jira_workflow_scheme_default",
  "jira_workflow_scheme_draft_default",
  "jira_workflow_scheme_issue_type",
  "jira_workflow_scheme_draft_issue_type",
  "jira_workflow_scheme_workflows",
  "jira_workflow_scheme_draft_workflows",
]);
const TEXT_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  screenId: "chat.jira.fact.screenId",
  tabId: "chat.jira.fact.screenTabId",
  schemeId: "chat.jira.fact.requestedSchemeId",
  projectKey: "chat.jira.fact.projectKey",
  issueTypeId: "chat.jira.fact.issueTypeId",
  workflow: "chat.jira.fact.workflow",
  originalWorkflow: "chat.jira.fact.originalWorkflow",
  defaultWorkflow: "chat.jira.fact.defaultWorkflow",
  originalDefaultWorkflow: "chat.jira.fact.originalDefaultWorkflow",
  lastModified: "chat.jira.fact.lastModified",
  type: "chat.jira.fact.screenFieldType",
};
function entityIdLabel(tool: string): WidgetMessageKey {
  if (tool === "jira_screens") return "chat.jira.fact.screenId";
  if (tool === "jira_screen_tabs") return "chat.jira.fact.screenTabId";
  if (SCREEN_FIELDS.has(tool)) return "chat.jira.fact.screenFieldId";
  return tool === "jira_issue_type_scheme_projects"
    ? "chat.jira.fact.projectId"
    : "chat.jira.fact.returnedSchemeId";
}
function namedIdentity(value: unknown): string | undefined {
  const raw = record(value);
  const id = text(raw?.id);
  const name = text(raw?.name);
  return id === undefined ? undefined : name === undefined ? id : `${name} (${id})`;
}
function issueTypeFacts(source: Source): JiraOutcomeFact[] {
  const facts = fact("chat.jira.fact.defaultIssueType", namedIdentity(source.defaultIssueType));
  if (!Array.isArray(source.issueTypes)) return facts;
  const types = source.issueTypes.flatMap((value: unknown) => {
    const name = namedIdentity(value);
    return name === undefined ? [] : [{ name, subtask: record(value)?.subtask }];
  });
  for (const [state, label] of [
    [true, "chat.jira.fact.subtaskTypes"],
    [false, "chat.jira.fact.standardTypes"],
    [undefined, "chat.jira.fact.unknownTypeKind"],
  ] as const) {
    const names = types.filter((type) => type.subtask === state).map((type) => type.name);
    if (names.length > 0) facts.push({ label, value: names.join(", ") });
  }
  facts.push({ label: "chat.jira.fact.issueTypeCount", value: String(types.length) });
  return facts;
}
function mappingFacts(source: Source): JiraOutcomeFact[] {
  if (!Array.isArray(source.issueTypeIds)) return [];
  return [
    ...fact(
      "chat.jira.fact.mappedIssueTypeIds",
      source.issueTypeIds.filter((value: unknown) => typeof value === "string").join(", "),
    ),
    { label: "chat.jira.fact.mappedIssueTypeCount", value: String(source.issueTypeIds.length) },
  ];
}
function booleanLabels(source: Source): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = [];
  if (typeof source.showWhenEmpty === "boolean")
    labels.push(
      source.showWhenEmpty
        ? "chat.jira.administration.showWhenEmpty"
        : "chat.jira.administration.hideWhenEmpty",
    );
  if (typeof source.defaultMapping === "boolean")
    labels.push(
      source.defaultMapping
        ? "chat.jira.administration.defaultMapping"
        : "chat.jira.administration.notDefaultMapping",
    );
  if (typeof source.draft === "boolean")
    labels.push(
      source.draft ? "chat.jira.administration.draft" : "chat.jira.administration.published",
    );
  if (typeof source.archived === "boolean")
    labels.push(source.archived ? "chat.jira.metadata.archived" : "chat.jira.metadata.notArchived");
  return labels;
}
function currentMappingUnknown(source: Source): boolean {
  return (
    (text(source.originalWorkflow) !== undefined && text(source.workflow) === undefined) ||
    (text(source.originalDefaultWorkflow) !== undefined &&
      text(source.defaultWorkflow) === undefined)
  );
}
function labelsFor(tool: string, source: Source): WidgetMessageKey[] {
  const labels = booleanLabels(source);
  if (currentMappingUnknown(source)) labels.push("chat.jira.administration.currentMappingUnknown");
  if (WORKFLOW_SCHEMES.has(tool) && text(source.id) !== undefined && !Array.isArray(source.items))
    labels.push("chat.jira.administration.mappingsUnknown");
  return labels;
}
/** Configuration observations are not proof of field requiredness, write permission or activation. */
export function jiraAdministrationDetails(tool: string, source: Source): JiraAgileDetails {
  const facts = Object.entries(TEXT_FACTS).flatMap(([field, label]) => fact(label, source[field]));
  facts.push(
    ...fact(entityIdLabel(tool), source.id),
    ...issueTypeFacts(source),
    ...mappingFacts(source),
  );
  if (tool === "jira_issue_type_scheme_projects")
    facts.push(...fact("chat.jira.fact.projectKey", source.key));
  const name = text(source.name);
  const body = text(source.description);
  return {
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts,
    labels: labelsFor(tool, source),
  };
}
