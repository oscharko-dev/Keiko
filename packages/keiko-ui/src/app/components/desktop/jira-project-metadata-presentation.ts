import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
const VERSIONS = new Set([
  "jira_versions",
  "jira_version",
  "jira_create_version",
  "jira_update_version",
]);
const COMPONENTS = new Set([
  "jira_components",
  "jira_component",
  "jira_create_component",
  "jira_update_component",
]);
export const JIRA_PROJECT_METADATA_TOOLS: ReadonlySet<string> = new Set([
  ...VERSIONS,
  ...COMPONENTS,
]);

function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
    ? value
    : undefined;
}
function state(
  value: unknown,
  yes: WidgetMessageKey,
  no: WidgetMessageKey,
  unknown: WidgetMessageKey,
): WidgetMessageKey {
  return value === true ? yes : value === false ? no : unknown;
}
const ASSIGNEES: Readonly<Record<string, WidgetMessageKey>> = {
  PROJECT_DEFAULT: "chat.jira.metadata.assigneeProjectDefault",
  COMPONENT_LEAD: "chat.jira.metadata.assigneeComponentLead",
  PROJECT_LEAD: "chat.jira.metadata.assigneeProjectLead",
  UNASSIGNED: "chat.jira.metadata.assigneeUnassigned",
};
function componentLabels(source: Source): WidgetMessageKey[] {
  const assignee =
    typeof source.assigneeType === "string" ? ASSIGNEES[source.assigneeType] : undefined;
  const labels: WidgetMessageKey[] = assignee === undefined ? [] : [assignee];
  if (source.deleted === true) labels.push("chat.jira.metadata.deleted");
  return labels;
}
/** Entity identity comes from its closed tool family, never from a project context or issue key. */
export function jiraProjectMetadataDetails(
  tool: string,
  source: Source,
): {
  readonly facts: readonly JiraOutcomeFact[];
  readonly labels: readonly WidgetMessageKey[];
} {
  if (!JIRA_PROJECT_METADATA_TOOLS.has(tool)) return { facts: [], labels: [] };
  const version = VERSIONS.has(tool);
  const id = identity(version ? source.versionId : (source.componentId ?? source.id));
  const facts = [
    ...fact(version ? "chat.jira.fact.versionId" : "chat.jira.fact.componentId", id),
    ...fact("chat.jira.fact.projectKey", source.projectKey ?? source.project),
  ];
  // A failed creation may carry only the resolved project context, not an entity acknowledgement.
  if (id === undefined) return { facts, labels: [] };
  const labels = [
    state(
      source.archived,
      "chat.jira.metadata.archived",
      "chat.jira.metadata.notArchived",
      "chat.jira.metadata.archiveUnknown",
    ),
  ];
  if (version) {
    facts.push(
      ...fact("chat.jira.fact.startDate", source.startDate),
      ...fact("chat.jira.fact.releaseDate", source.releaseDate),
    );
    labels.push(
      state(
        source.released,
        "chat.jira.metadata.released",
        "chat.jira.metadata.unreleased",
        "chat.jira.metadata.releaseUnknown",
      ),
    );
  } else {
    facts.push(...fact("chat.jira.fact.componentLead", source.leadUserName));
    labels.push(...componentLabels(source));
  }
  return { facts, labels };
}
/** Shared native version summaries retain only observed project and release metadata. */
export function jiraVersionSummaryDetails(source: Source): JiraAgileDetails | undefined {
  if (text(source.versionId) === undefined) return undefined;
  const details = jiraProjectMetadataDetails("jira_version", source);
  const name = text(source.name);
  const body = text(source.description);
  return {
    ...details, ...(name === undefined ? {} : { name }), ...(body === undefined ? {} : { body }),
    facts: [...details.facts, ...fact("chat.jira.fact.projectId", source.projectId)],
  };
}
const ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  versionId: "chat.jira.fact.versionId",
  componentId: "chat.jira.fact.componentId",
  projectId: "chat.jira.fact.projectId",
  projectIdOrKey: "chat.jira.fact.projectIdOrKey",
  startDate: "chat.jira.fact.startDate",
  releaseDate: "chat.jira.fact.releaseDate",
  released: "chat.jira.fact.released",
  archived: "chat.jira.fact.archived",
  leadUserName: "chat.jira.fact.componentLead",
  assigneeType: "chat.jira.fact.projectAssignee",
};
export function jiraProjectMetadataArgumentLabel(
  operation: string | undefined,
  field: string,
): WidgetMessageKey | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  if (tool === undefined || !JIRA_PROJECT_METADATA_TOOLS.has(tool)) return undefined;
  const version = VERSIONS.has(tool);
  if (field === "name")
    return version ? "chat.jira.fact.versionName" : "chat.jira.fact.componentName";
  if (field === "description")
    return version ? "chat.jira.fact.versionDescription" : "chat.jira.fact.componentDescription";
  return ARGUMENT_LABELS[field];
}
