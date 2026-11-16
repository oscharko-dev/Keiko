import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraDirectoryDetails } from "./jira-directory-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  jiraPresentationStringList as listFacts,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
const USERS = new Set([
  "jira_multi_project_assignable_users",
  "jira_permission_users",
  "jira_browse_permission_users",
]);
export const JIRA_LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  ...USERS,
  "jira_group_user_picker",
  "jira_project_picker",
  "jira_fields",
  "jira_custom_field_option",
]);
const FLAGS: Readonly<
  Record<string, readonly [WidgetMessageKey, WidgetMessageKey, WidgetMessageKey]>
> = {
  custom: [
    "chat.jira.lookup.customField",
    "chat.jira.lookup.systemField",
    "chat.jira.lookup.fieldKindUnknown",
  ],
  orderable: [
    "chat.jira.lookup.orderable",
    "chat.jira.lookup.notOrderable",
    "chat.jira.lookup.orderableUnknown",
  ],
  navigable: [
    "chat.jira.lookup.navigable",
    "chat.jira.lookup.notNavigable",
    "chat.jira.lookup.navigableUnknown",
  ],
  searchable: [
    "chat.jira.lookup.searchable",
    "chat.jira.lookup.notSearchable",
    "chat.jira.lookup.searchableUnknown",
  ],
};
const SCHEMA: Readonly<Record<string, WidgetMessageKey>> = {
  type: "chat.jira.lookup.schemaType",
  items: "chat.jira.lookup.schemaItems",
  system: "chat.jira.lookup.schemaSystem",
  custom: "chat.jira.lookup.schemaCustom",
  customId: "chat.jira.lookup.schemaCustomId",
};
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function field(source: Source): JiraAgileDetails | undefined {
  const id = text(source.id);
  const name = text(source.name);
  if (id === undefined || name === undefined) return undefined;
  const schema = record(source.schema);
  const clauses = listFacts(
    source.clauseNames,
    "chat.jira.lookup.clauseNames",
    "chat.jira.lookup.clauseCount",
  );
  const labels = Object.entries(FLAGS).map(([key, [yes, no, unknown]]) =>
    triState(source[key], yes, no, unknown),
  );
  if (clauses === undefined) labels.push("chat.jira.lookup.clausesUnknown");
  if (schema === undefined) labels.push("chat.jira.lookup.schemaUnknown");
  return {
    name,
    facts: [
      { label: "chat.jira.access.fieldId", value: id },
      ...(clauses ?? []),
      ...Object.entries(SCHEMA).flatMap(([key, label]) => fact(label, schema?.[key])),
    ],
    labels: [...labels, "chat.jira.lookup.fieldScope"],
  };
}
export function jiraFieldOptionDetails(source: Source): JiraAgileDetails | undefined {
  const id = text(source.id);
  if (id === undefined || typeof source.value !== "string") return undefined;
  const children = listFacts(
    source.childrenIds,
    "chat.jira.lookup.childOptionIds",
    "chat.jira.lookup.childOptionCount",
  );
  const labels: WidgetMessageKey[] = [
    triState(
      source.disabled,
      "chat.jira.lookup.optionDisabled",
      "chat.jira.lookup.optionEnabled",
      "chat.jira.lookup.optionStateUnknown",
    ),
  ];
  if (children === undefined) labels.push("chat.jira.lookup.childrenUnknown");
  if (source.value.length === 0) labels.push("chat.jira.lookup.emptyOptionValue");
  return {
    ...(source.value.length === 0 ? {} : { name: source.value }),
    facts: [{ label: "chat.jira.lookup.optionId", value: id }, ...(children ?? [])],
    labels,
  };
}
function project(source: Source): JiraAgileDetails | undefined {
  const name = text(source.name);
  const id = text(source.id);
  const key = text(source.key);
  if (name === undefined || id === undefined || key === undefined) return undefined;
  return {
    name,
    facts: [
      { label: "chat.jira.fact.projectId", value: id },
      { label: "chat.jira.fact.projectKey", value: key },
    ],
    labels: [],
  };
}
function directoryItem(value: unknown, users: boolean): JiraAgileDetails | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  const item = jiraDirectoryDetails(users ? "jira_user" : "jira_groups", source);
  return item.name === undefined && item.facts.length === 0 ? undefined : item;
}
function suggestions(value: unknown, users: boolean): readonly JiraAgileDetails[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((entry: unknown) => directoryItem(entry, users));
  return items.every((item) => item !== undefined) ? items : undefined;
}
function pickerBranch(data: Source, users: boolean): readonly JiraAgileDetails[] {
  const items = suggestions(users ? data.users : data.groups, users);
  if (items === undefined)
    return [
      {
        facts: [],
        labels: [users ? "chat.jira.lookup.usersUnknown" : "chat.jira.lookup.groupsUnknown"],
      },
    ];
  const total = count(users ? data.usersTotal : data.groupsTotal);
  const facts: JiraOutcomeFact[] = [
    {
      label: users ? "chat.jira.lookup.usersReturned" : "chat.jira.lookup.groupsReturned",
      value: String(items.length),
    },
  ];
  if (total !== undefined)
    facts.push({
      label: users ? "chat.jira.lookup.usersTotal" : "chat.jira.lookup.groupsTotal",
      value: String(total),
    });
  return [
    {
      facts,
      labels:
        total === undefined
          ? [users ? "chat.jira.lookup.usersTotalUnknown" : "chat.jira.lookup.groupsTotalUnknown"]
          : [],
    },
    ...items,
  ];
}
/** Suggested people, projects and native field definitions are readable facts, not grants or write metadata. */
export function jiraLookupDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_LOOKUP_TOOLS.has(tool)) return [];
  if (tool === "jira_group_user_picker") {
    if (
      data.outcome === "failed" ||
      (data.outcome !== "succeeded" && data.users === undefined && data.groups === undefined)
    )
      return [];
    return [...pickerBranch(data, true), ...pickerBranch(data, false)];
  }
  return (Array.isArray(data.items) ? data.items : [data]).flatMap((value: unknown) => {
    const source = record(value);
    if (source === undefined) return [];
    const item = lookupItem(tool, source);
    return item === undefined ? [] : [item];
  });
}
function branchPartial(items: unknown, total: unknown): boolean {
  const observed = count(total);
  return Array.isArray(items) && observed !== undefined && observed > items.length;
}
export function jiraLookupNotice(tool: string, data: Source): WidgetMessageKey | undefined {
  if (data.outcome !== "succeeded") return undefined;
  if (USERS.has(tool)) return "chat.jira.directory.searchWindow";
  if (tool === "jira_group_user_picker")
    return branchPartial(data.users, data.usersTotal) ||
      branchPartial(data.groups, data.groupsTotal)
      ? "chat.jira.partial"
      : undefined;
  if (tool !== "jira_project_picker") return undefined;
  if (count(data.total) === undefined) return "chat.jira.directory.pickerTotalUnknown";
  return branchPartial(data.items, data.total) ? "chat.jira.partial" : undefined;
}

function triState<T extends string>(value: unknown, yes: T, no: T, unknown: T): T {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
function lookupItem(tool: string, source: Source): JiraAgileDetails | undefined {
  if (USERS.has(tool)) return directoryItem(source, true);
  if (tool === "jira_project_picker") return project(source);
  if (tool === "jira_fields") return field(source);
  return jiraFieldOptionDetails(source);
}
