import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraProjectMetadataDetails } from "./jira-project-metadata-presentation";

type Source = Readonly<Record<string, unknown>>;
export const JIRA_RELEASE_TOOLS: ReadonlySet<string> = new Set([
  "jira_component_related_issue_counts", "jira_version_related_issue_counts",
  "jira_version_unresolved_issue_count", "jira_project_version_page",
]);
const COUNT_FIELDS: Readonly<Record<string, Readonly<Record<string, WidgetMessageKey>>>> = {
  jira_component_related_issue_counts: { issueCount: "chat.jira.release.relatedIssues" },
  jira_version_related_issue_counts: {
    issuesAffectedCount: "chat.jira.release.affectedIssues",
    issuesFixedCount: "chat.jira.release.fixedIssues",
    issueCountWithCustomFieldsShowingVersion: "chat.jira.release.customFieldIssues",
  },
  jira_version_unresolved_issue_count: { issuesUnresolvedCount: "chat.jira.release.unresolvedIssues" },
};
function record(value: unknown): Source | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function fact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  const content = text(value);
  return content === undefined ? [] : [{ label, value: content }];
}
function countFact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? [{ label, value: String(value) }] : [];
}
function countScope(data: Source): WidgetMessageKey {
  return data.countScope === "jira-response" ? "chat.jira.release.nativeCountScope" : "chat.jira.release.countScopeUnknown";
}
function fieldUsage(value: unknown, data: Source): JiraAgileDetails | undefined {
  const source = record(value);
  const id = text(source?.customFieldId);
  const name = text(source?.fieldName);
  if (id === undefined || name === undefined || source === undefined) return undefined;
  const counts = countFact("chat.jira.release.fieldIssues", source.issueCountWithVersionInCustomField);
  return {
    name,
    facts: [
      ...fact("chat.jira.fact.versionId", data.versionId),
      { label: "chat.jira.access.fieldId", value: id }, ...counts,
    ],
    labels: [countScope(data), ...(counts.length === 0 ? ["chat.jira.release.countsUnknown"] as const : [])],
  };
}
function customFields(data: Source): readonly JiraAgileDetails[] | undefined {
  if (!Array.isArray(data.customFieldNames)) return undefined;
  const fields = data.customFieldNames.map((value: unknown) => fieldUsage(value, data));
  return fields.every((field) => field !== undefined) ? fields : undefined;
}
function counts(tool: string, data: Source): readonly JiraAgileDetails[] {
  const component = tool === "jira_component_related_issue_counts";
  const identity = fact(component ? "chat.jira.fact.componentId" : "chat.jira.fact.versionId",
    component ? data.componentId : data.versionId);
  if (identity.length === 0) return [];
  const dimensions = Object.entries(COUNT_FIELDS[tool] ?? {});
  const facts = dimensions.flatMap(([field, label]) => countFact(label, data[field]));
  const labels: WidgetMessageKey[] = [countScope(data)];
  if (facts.length < dimensions.length) labels.push("chat.jira.release.countsUnknown");
  const relatedVersion = tool === "jira_version_related_issue_counts";
  const fields = relatedVersion ? customFields(data) : undefined;
  if (relatedVersion && fields === undefined) labels.push("chat.jira.release.customUsageUnknown");
  return [{
    facts: [
      ...identity, ...facts,
      ...(fields === undefined ? [] : [{ label: "chat.jira.release.customFieldCount", value: String(fields.length) } satisfies JiraOutcomeFact]),
    ],
    labels,
  }, ...(fields ?? [])];
}
function version(source: Source): JiraAgileDetails | undefined {
  if (text(source.versionId) === undefined) return undefined;
  const details = jiraProjectMetadataDetails("jira_version", source);
  const name = text(source.name);
  const body = text(source.description);
  return {
    ...details, ...(name === undefined ? {} : { name }), ...(body === undefined ? {} : { body }),
    facts: [...details.facts, ...fact("chat.jira.fact.projectId", source.projectId)],
  };
}
function versions(data: Source): readonly JiraAgileDetails[] {
  const context = [
    ...fact("chat.jira.fact.projectId", data.projectId),
    ...fact("chat.jira.fact.projectKey", data.projectKey),
  ];
  const sources = Array.isArray(data.items) ? data.items : [data];
  return [
    ...(Array.isArray(data.items) && context.length > 0 ? [{ facts: context, labels: [] }] : []),
    ...sources.flatMap((value: unknown) => {
      const source = record(value);
      const item = source === undefined ? undefined : version(source);
      return item === undefined ? [] : [item];
    }),
  ];
}
/** Native counts retain their own populations; version metadata reuses the existing saved display. */
export function jiraReleaseDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_RELEASE_TOOLS.has(tool)) return [];
  return tool === "jira_project_version_page" ? versions(data) : counts(tool, data);
}
