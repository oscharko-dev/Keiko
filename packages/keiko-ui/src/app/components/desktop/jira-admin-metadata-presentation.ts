import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraAdministrationDetails } from "./jira-administration-presentation";
import { jiraFieldOptionDetails } from "./jira-lookup-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  jiraPresentationStringList as arrayFacts,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_ADMIN_METADATA_TOOLS: ReadonlySet<string> = new Set([
  "jira_screens",
  "jira_workflows",
  "jira_custom_fields",
  "jira_custom_field_options",
  "jira_terminology",
  "jira_terminology_entry",
  "jira_read_only_mode",
]);
const CUSTOM_TEXT: Readonly<Record<string, WidgetMessageKey>> = {
  id: "chat.jira.access.fieldId",
  numericId: "chat.jira.lookup.schemaCustomId",
  type: "chat.jira.adminMetadata.fieldType",
  searcherKey: "chat.jira.adminMetadata.searcherKey",
  lastValueUpdate: "chat.jira.adminMetadata.lastValueUpdate",
};
const CUSTOM_COUNTS: Readonly<Record<string, WidgetMessageKey>> = {
  issuesWithValue: "chat.jira.adminMetadata.issuesWithValue",
  projectsCount: "chat.jira.adminMetadata.projectsCount",
  screensCount: "chat.jira.adminMetadata.screensCount",
};
const CUSTOM_FLAGS: Readonly<
  Record<string, readonly [WidgetMessageKey, WidgetMessageKey, WidgetMessageKey]>
> = {
  isAllProjects: [
    "chat.jira.adminMetadata.allProjects",
    "chat.jira.adminMetadata.selectedProjects",
    "chat.jira.adminMetadata.projectScopeUnknown",
  ],
  isLocked: [
    "chat.jira.adminMetadata.locked",
    "chat.jira.adminMetadata.notLocked",
    "chat.jira.adminMetadata.lockUnknown",
  ],
  isManaged: [
    "chat.jira.adminMetadata.managed",
    "chat.jira.adminMetadata.notManaged",
    "chat.jira.adminMetadata.managementUnknown",
  ],
  isTrusted: [
    "chat.jira.adminMetadata.trusted",
    "chat.jira.adminMetadata.notTrusted",
    "chat.jira.adminMetadata.trustUnknown",
  ],
};
function customField(source: Source): JiraAgileDetails | undefined {
  const name = text(source.name);
  if (name === undefined || text(source.id) === undefined) return undefined;
  const body = text(source.description);
  const projects = arrayFacts(
    source.projectIds,
    "chat.jira.adminMetadata.projectIds",
    "chat.jira.adminMetadata.projectIdsCount",
  );
  const types = arrayFacts(
    source.issueTypeIds,
    "chat.jira.fact.mappedIssueTypeIds",
    "chat.jira.fact.mappedIssueTypeCount",
  );
  const labels: WidgetMessageKey[] = [
    "chat.jira.lookup.fieldScope",
    "chat.jira.adminMetadata.configurationOnly",
    ...Object.entries(CUSTOM_FLAGS).map(([key, [yes, no, unknown]]) =>
      source[key] === true ? yes : source[key] === false ? no : unknown,
    ),
  ];
  if (projects === undefined) labels.push("chat.jira.adminMetadata.projectIdsUnknown");
  if (types === undefined) labels.push("chat.jira.adminMetadata.issueTypeIdsUnknown");
  const counts = Object.entries(CUSTOM_COUNTS).flatMap(([key, label]) => {
    const value = source[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? [{ label, value: String(value) }]
      : [];
  });
  if (counts.length !== Object.keys(CUSTOM_COUNTS).length)
    labels.push("chat.jira.adminMetadata.countsUnknown");
  return {
    name,
    ...(body === undefined ? {} : { body }),
    facts: [
      ...Object.entries(CUSTOM_TEXT).flatMap(([key, label]) => fact(label, source[key])),
      ...(projects ?? []),
      ...(types ?? []),
      ...counts,
    ],
    labels,
  };
}
function terminology(source: Source): JiraAgileDetails | undefined {
  const originalName = text(source.originalName);
  if (originalName?.toLowerCase() !== "epic" && originalName?.toLowerCase() !== "sprint")
    return undefined;
  const facts = [
    ...fact("chat.jira.adminMetadata.originalName", source.originalName),
    ...fact("chat.jira.adminMetadata.originalPlural", source.originalNamePlural),
    ...fact("chat.jira.adminMetadata.newName", source.newName),
    ...fact("chat.jira.adminMetadata.newPlural", source.newNamePlural),
  ];
  const labels: WidgetMessageKey[] = [
    source.isDefault === true
      ? "chat.jira.adminMetadata.defaultTerminology"
      : source.isDefault === false
        ? "chat.jira.adminMetadata.customTerminology"
        : "chat.jira.adminMetadata.terminologyDefaultUnknown",
  ];
  if (text(source.newName) === undefined || text(source.newNamePlural) === undefined)
    labels.push("chat.jira.adminMetadata.terminologyUnknown");
  return { facts, labels };
}
function readOnly(data: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = [
    "chat.jira.adminMetadata.readOnlyObservation",
    data.enabled === true
      ? "chat.jira.adminMetadata.readOnlyEnabled"
      : data.enabled === false
        ? "chat.jira.adminMetadata.readOnlyDisabled"
        : "chat.jira.adminMetadata.readOnlyUnknown",
  ];
  const facts: JiraOutcomeFact[] = [];
  for (const [key, label, blank] of [
    ["message", "chat.jira.adminMetadata.readOnlyMessage", "chat.jira.adminMetadata.emptyMessage"],
    ["endTime", "chat.jira.adminMetadata.readOnlyEnd", "chat.jira.adminMetadata.emptyEnd"],
    ["timeZone", "chat.jira.adminMetadata.readOnlyZone", "chat.jira.adminMetadata.emptyZone"],
  ] as const) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length === 0) labels.push(blank);
    else facts.push(...fact(label, value));
  }
  return { facts, labels };
}
function optionContext(data: Source): JiraAgileDetails {
  return {
    facts: [
      ...fact("chat.jira.access.fieldId", data.customFieldId),
      ...(typeof data.page === "number" && Number.isSafeInteger(data.page) && data.page > 0
        ? [
            {
              label: "chat.jira.adminMetadata.optionPage",
              value: String(data.page),
            } satisfies JiraOutcomeFact,
          ]
        : []),
    ],
    labels: [
      data.optionsScope === "all-field-contexts"
        ? "chat.jira.adminMetadata.allOptionContexts"
        : data.optionsScope === "native-context-options"
          ? "chat.jira.adminMetadata.nativeOptionContext"
          : "chat.jira.adminMetadata.optionScopeUnknown",
      "chat.jira.adminMetadata.optionScopeOnly",
    ],
  };
}
function workflowDetails(source: Source): JiraAgileDetails {
  const facts = fact("chat.jira.adminMetadata.workflowModified", source.lastModifiedDate);
  const labels: WidgetMessageKey[] = [];
  if (typeof source.steps === "number" && Number.isSafeInteger(source.steps) && source.steps >= 0)
    facts.push({ label: "chat.jira.adminMetadata.workflowSteps", value: String(source.steps) });
  else labels.push("chat.jira.adminMetadata.workflowStepsUnknown");
  labels.push(
    source.isDefault === true
      ? "chat.jira.adminMetadata.defaultWorkflow"
      : source.isDefault === false
        ? "chat.jira.adminMetadata.notDefaultWorkflow"
        : "chat.jira.adminMetadata.defaultWorkflowUnknown",
  );
  return { facts, labels };
}
function screenOrWorkflow(tool: string, source: Source): JiraAgileDetails | undefined {
  if (text(source.name) === undefined || (tool === "jira_screens" && text(source.id) === undefined))
    return undefined;
  const details = jiraAdministrationDetails(tool, source);
  const facts = [...details.facts];
  const labels: WidgetMessageKey[] = [
    ...details.labels,
    "chat.jira.adminMetadata.configurationOnly",
  ];
  if (tool === "jira_screens")
    labels.push(
      source.deletable === true
        ? "chat.jira.adminMetadata.deletable"
        : source.deletable === false
          ? "chat.jira.adminMetadata.notDeletable"
          : "chat.jira.adminMetadata.deletableUnknown",
    );
  else {
    const workflow = workflowDetails(source);
    facts.push(...workflow.facts);
    labels.push(...workflow.labels);
  }
  return { ...details, facts, labels };
}
/** Native configuration is readable discovery, never proof of rule enforcement or permission to edit. */
export function jiraAdminMetadataDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_ADMIN_METADATA_TOOLS.has(tool) || data.outcome === "failed") return [];
  if (tool === "jira_read_only_mode")
    return data.outcome === "succeeded" ||
      Object.hasOwn(data, "enabled") ||
      Object.hasOwn(data, "message")
      ? [readOnly(data)]
      : [];
  const sources = Array.isArray(data.items) ? data.items : [data];
  const items = sources.flatMap((value: unknown) => {
    const source = record(value);
    if (source === undefined) return [];
    const item =
      tool === "jira_custom_fields"
        ? customField(source)
        : tool === "jira_custom_field_options"
          ? jiraFieldOptionDetails(source)
          : tool === "jira_terminology" || tool === "jira_terminology_entry"
            ? terminology(source)
            : screenOrWorkflow(tool, source);
    return item === undefined ? [] : [item];
  });
  return tool === "jira_custom_field_options" && Array.isArray(data.items)
    ? [optionContext(data), ...items]
    : items;
}
export function jiraAdminMetadataNotice(tool: string, data: Source): WidgetMessageKey | undefined {
  if (tool !== "jira_custom_field_options" || data.outcome !== "succeeded") return undefined;
  return (typeof data.page === "number" && data.page > 1) ||
    (typeof data.nextPage === "number" && data.nextPage > 1)
    ? "chat.jira.partial"
    : undefined;
}
