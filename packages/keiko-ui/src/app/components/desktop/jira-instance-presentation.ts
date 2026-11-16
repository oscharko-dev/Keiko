import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraDirectoryDetails } from "./jira-directory-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  jiraPresentationNativeText as nativeText,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
export const JIRA_INSTANCE_TOOLS: ReadonlySet<string> = new Set([
  "jira_server_info",
  "jira_instance_configuration",
  "jira_permission_definitions",
  "jira_myself",
]);
const SERVER_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  version: "chat.jira.instance.version",
  deploymentType: "chat.jira.instance.deploymentType",
  buildNumber: "chat.jira.instance.buildNumber",
  databaseBuildNumber: "chat.jira.instance.databaseBuildNumber",
  buildPartnerName: "chat.jira.instance.buildPartnerName",
};
const FEATURES: Readonly<
  Record<string, readonly [WidgetMessageKey, WidgetMessageKey, WidgetMessageKey]>
> = {
  attachmentsEnabled: [
    "chat.jira.instance.attachmentsOn",
    "chat.jira.instance.attachmentsOff",
    "chat.jira.instance.attachmentsUnknown",
  ],
  issueLinkingEnabled: [
    "chat.jira.instance.issueLinkingOn",
    "chat.jira.instance.issueLinkingOff",
    "chat.jira.instance.issueLinkingUnknown",
  ],
  subTasksEnabled: [
    "chat.jira.instance.subtasksOn",
    "chat.jira.instance.subtasksOff",
    "chat.jira.instance.subtasksUnknown",
  ],
  timeTrackingEnabled: [
    "chat.jira.instance.timeTrackingOn",
    "chat.jira.instance.timeTrackingOff",
    "chat.jira.instance.timeTrackingUnknown",
  ],
  unassignedIssuesAllowed: [
    "chat.jira.instance.unassignedOn",
    "chat.jira.instance.unassignedOff",
    "chat.jira.instance.unassignedUnknown",
  ],
  votingEnabled: [
    "chat.jira.instance.votingOn",
    "chat.jira.instance.votingOff",
    "chat.jira.instance.votingUnknown",
  ],
  watchingEnabled: [
    "chat.jira.instance.watchingOn",
    "chat.jira.instance.watchingOff",
    "chat.jira.instance.watchingUnknown",
  ],
};
const TIME_LABELS: Readonly<Record<string, Readonly<Record<string, WidgetMessageKey>>>> = {
  defaultUnit: {
    minute: "chat.jira.instance.unitMinute",
    hour: "chat.jira.instance.unitHour",
    day: "chat.jira.instance.unitDay",
    week: "chat.jira.instance.unitWeek",
  },
  timeFormat: {
    pretty: "chat.jira.instance.formatPretty",
    days: "chat.jira.instance.formatDays",
    hours: "chat.jira.instance.formatHours",
  },
};
function comparisonUrl(value: unknown): value is string {
  if (!nativeText(value, 2048) || /[\s\\@?#]/u.test(value) || !URL.canParse(value)) return false;
  const parsed = new URL(value);
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hostname.length > 0 &&
    parsed.username === "" &&
    parsed.password === ""
  );
}
function baseUrlReview(source: Source): JiraAgileDetails {
  return source.configuredBaseUrlState === "observed" && comparisonUrl(source.configuredBaseUrl)
    ? {
        facts: [
          { label: "chat.jira.instanceWrite.reviewedBaseUrl", value: source.configuredBaseUrl },
        ],
        labels: ["chat.jira.instanceWrite.noNavigation"],
      }
    : { facts: [], labels: ["chat.jira.instanceWrite.configuredBaseUrlUnavailable"] };
}
function serverInfo(source: Source): readonly JiraAgileDetails[] {
  if (text(source.version) === undefined) return [];
  const facts = Object.entries(SERVER_FACTS).flatMap(([field, label]) =>
    fact(label, source[field]),
  );
  const parts = source.versionNumbers;
  if (
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every(
      (part: unknown) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0,
    )
  )
    facts.push({ label: "chat.jira.instance.versionNumbers", value: parts.join(".") });
  const name = text(source.serverTitle);
  const review = baseUrlReview(source);
  return [
    {
      ...(name === undefined ? {} : { name }),
      facts: [...facts, ...review.facts],
      labels: ["chat.jira.instance.serverObservation", ...review.labels],
    },
  ];
}
function timeSettings(value: unknown): JiraAgileDetails {
  const source = record(value);
  if (source === undefined)
    return { facts: [], labels: ["chat.jira.instance.timeSettingsUnknown"] };
  const facts: JiraOutcomeFact[] = [];
  for (const [field, label] of [
    ["workingHoursPerDay", "chat.jira.instance.hoursPerDay"],
    ["workingDaysPerWeek", "chat.jira.instance.daysPerWeek"],
  ] as const) {
    const number = source[field];
    if (
      typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 0 &&
      number <= Number.MAX_SAFE_INTEGER
    )
      facts.push({ label, value: String(number) });
  }
  const labels = Object.entries(TIME_LABELS).flatMap(([field, options]) => {
    const value = source[field];
    const label =
      typeof value === "string" && Object.hasOwn(options, value) ? options[value] : undefined;
    return label === undefined ? [] : [label];
  });
  if (facts.length + labels.length < 4) labels.push("chat.jira.instance.timeSettingsPartial");
  return { facts, labels };
}
function configuration(source: Source): readonly JiraAgileDetails[] {
  if (
    !Object.keys(FEATURES).some((field) => typeof source[field] === "boolean") &&
    record(source.timeTrackingConfiguration) === undefined
  )
    return [];
  const time = timeSettings(source.timeTrackingConfiguration);
  const labels = Object.entries(FEATURES).map(([field, [yes, no, unknown]]) =>
    triState(source[field], yes, no, unknown),
  );
  return [{ facts: time.facts, labels: [...labels, ...time.labels] }];
}
function definition(source: Source): JiraAgileDetails | undefined {
  const key = text(source.key);
  if (key === undefined) return undefined;
  const name = text(source.name);
  const body = text(source.description);
  const labels: WidgetMessageKey[] = ["chat.jira.access.configurationOnly"];
  if (source.type === "GLOBAL") labels.push("chat.jira.instance.globalDefinition");
  if (source.type === "PROJECT") labels.push("chat.jira.instance.projectDefinition");
  return {
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts: [
      { label: "chat.jira.instance.definitionKey", value: key },
      ...fact("chat.jira.instance.nativePermissionKey", source.nativeKey),
      ...fact("chat.jira.instance.definitionId", source.id),
    ],
    labels,
  };
}
function definitions(data: Source): readonly JiraAgileDetails[] {
  const sources = Array.isArray(data.items) ? data.items : [data];
  const items = sources.flatMap((value: unknown) => {
    const source = record(value);
    const item = source === undefined ? undefined : definition(source);
    return item === undefined ? [] : [item];
  });
  if (items.length > 0) return items;
  return data.permissionsScope === "definitions" && Array.isArray(data.items)
    ? [{ facts: [], labels: ["chat.jira.access.configurationOnly"] }]
    : [];
}
/** Observations only: no verification state, effective permission or remote media is inferred. */
export function jiraInstanceDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  switch (tool) {
    case "jira_server_info":
      return serverInfo(data);
    case "jira_instance_configuration":
      return configuration(data);
    case "jira_permission_definitions":
      return definitions(data);
    case "jira_myself":
      return [jiraDirectoryDetails("jira_user", data)];
    default:
      return [];
  }
}

function triState<T extends string>(value: unknown, yes: T, no: T, unknown: T): T {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
