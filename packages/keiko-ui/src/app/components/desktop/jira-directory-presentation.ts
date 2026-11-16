import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
const ROLES = new Set(["jira_application_role", "jira_application_roles"]);
const PICKERS = new Set(["jira_user_picker", "jira_groups"]);
export const JIRA_DIRECTORY_TOOLS: ReadonlySet<string> = new Set([
  "jira_user",
  "jira_users",
  "jira_user_directory",
  "jira_user_picker",
  "jira_group_members",
  "jira_groups",
  ...ROLES,
]);
const ROLE_FLAGS: Readonly<Record<string, readonly [WidgetMessageKey, WidgetMessageKey]>> = {
  defined: ["chat.jira.directory.roleDefined", "chat.jira.directory.roleNotDefined"],
  hasUnlimitedSeats: ["chat.jira.directory.unlimitedSeats", "chat.jira.directory.limitedSeats"],
  platform: ["chat.jira.directory.platformRole", "chat.jira.directory.notPlatformRole"],
  selectedByDefault: [
    "chat.jira.directory.defaultOnCreation",
    "chat.jira.directory.notDefaultOnCreation",
  ],
};
const ROLE_METRICS: Readonly<Record<string, WidgetMessageKey>> = {
  numberOfSeats: "chat.jira.fact.roleSeats",
  remainingSeats: "chat.jira.fact.roleRemainingSeats",
  userCount: "chat.jira.fact.roleUserCount",
};
function groupFacts(source: Source): JiraOutcomeFact[] {
  const facts: JiraOutcomeFact[] = [];
  for (const [field, label, count] of [
    ["groups", "chat.jira.fact.roleGroups", "chat.jira.fact.roleGroupCount"],
    ["defaultGroups", "chat.jira.fact.roleDefaultGroups", "chat.jira.fact.roleDefaultGroupCount"],
  ] as const) {
    const values = source[field];
    if (!Array.isArray(values) || !values.every((value: unknown) => typeof value === "string"))
      continue;
    facts.push(...fact(label, values.join(", ")), { label: count, value: String(values.length) });
  }
  return facts;
}
function roleDetails(source: Source): JiraAgileDetails {
  const key = text(source.key);
  if (key === undefined) return { facts: [], labels: [] };
  const facts = [
    { label: "chat.jira.fact.applicationRoleKey", value: key } satisfies JiraOutcomeFact,
    ...groupFacts(source),
    ...Object.entries(ROLE_METRICS).flatMap(([field, label]) => {
      const value = source[field];
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= -2147483648 &&
        value <= 2147483647
        ? [{ label, value: String(value) }]
        : [];
    }),
  ];
  const labels = Object.entries(ROLE_FLAGS).flatMap(([field, [yes, no]]) =>
    typeof source[field] === "boolean" ? [source[field] ? yes : no] : [],
  );
  const name = text(source.name);
  const body = text(source.userCountDescription);
  return {
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts,
    labels,
  };
}
function triStateLabel(
  value: unknown,
  yes: WidgetMessageKey,
  no: WidgetMessageKey,
  unknown: WidgetMessageKey,
): WidgetMessageKey {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
function userLabels(source: Source): WidgetMessageKey[] {
  return [
    triStateLabel(
      source.active,
      "chat.jira.outcome.active",
      "chat.jira.outcome.inactive",
      "chat.jira.directory.activityUnknown",
    ),
    triStateLabel(
      source.deleted,
      "chat.jira.directory.userDeleted",
      "chat.jira.directory.userNotDeleted",
      "chat.jira.directory.deletionUnknown",
    ),
  ];
}
/** Directory observations are readable private facts, never links, email, HTML or effective rights. */
export function jiraDirectoryDetails(tool: string, source: Source): JiraAgileDetails {
  if (ROLES.has(tool)) return roleDetails(source);
  const group = text(source.groupName);
  if (group !== undefined)
    return {
      facts: [{ label: "chat.jira.fact.groupName", value: group }],
      labels: ["chat.jira.directory.includesSubgroups"],
    };
  const username = text(source.name);
  if (tool === "jira_groups")
    return { ...(username === undefined ? {} : { name: username }), facts: [], labels: [] };
  const key = text(source.key);
  if (username === undefined || key === undefined) return { facts: [], labels: [] };
  return {
    name: text(source.displayName) ?? username,
    facts: [
      { label: "chat.jira.fact.userKey", value: key },
      { label: "chat.jira.fact.userName", value: username },
    ],
    labels: userLabels(source),
  };
}
/** Search and cursor scopes never become a claim that all directory accounts were returned. */
export function jiraDirectoryNotice(tool: string, source: Source): WidgetMessageKey | undefined {
  if (source.outcome !== "succeeded") return undefined;
  if (tool === "jira_users") return "chat.jira.directory.searchWindow";
  if (tool === "jira_user_directory")
    return triStateLabel(
      source.isLast,
      "chat.jira.directory.lastPage",
      "chat.jira.directory.morePages",
      "chat.jira.directory.pageStateUnknown",
    );
  if (!PICKERS.has(tool) || !Array.isArray(source.items)) return undefined;
  if (typeof source.total !== "number") return "chat.jira.directory.pickerTotalUnknown";
  return source.total > source.items.length ? "chat.jira.directory.pickerPartial" : undefined;
}
