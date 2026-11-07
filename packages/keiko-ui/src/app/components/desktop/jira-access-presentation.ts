import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

type Source = Readonly<Record<string, unknown>>;
const PERMISSION_SCHEMES = new Set(["jira_permission_schemes", "jira_permission_scheme"]);
const GRANTS = new Set(["jira_permission_grants", "jira_permission_grant"]);
const SECURITY_SCHEMES = new Set(["jira_issue_security_schemes", "jira_issue_security_scheme"]);
const NOTIFICATIONS = new Set([
  "jira_notification_schemes",
  "jira_notification_scheme",
  "jira_project_notification_scheme",
]);
export const JIRA_ACCESS_TOOLS: ReadonlySet<string> = new Set([
  ...PERMISSION_SCHEMES,
  ...GRANTS,
  ...SECURITY_SCHEMES,
  "jira_security_level",
  ...NOTIFICATIONS,
]);
const RECIPIENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  CurrentAssignee: "chat.jira.access.recipient.currentAssignee",
  Reporter: "chat.jira.access.recipient.reporter",
  CurrentUser: "chat.jira.access.recipient.currentUser",
  ProjectLead: "chat.jira.access.recipient.projectLead",
  ComponentLead: "chat.jira.access.recipient.componentLead",
  AllWatchers: "chat.jira.access.recipient.allWatchers",
  User: "chat.jira.access.recipient.user",
  Group: "chat.jira.access.recipient.group",
  EmailAddress: "chat.jira.access.recipient.emailAddress",
  UserCustomField: "chat.jira.access.recipient.userCustomField",
  GroupCustomField: "chat.jira.access.recipient.groupCustomField",
  ProjectRole: "chat.jira.access.recipient.projectRole",
};
function record(value: unknown): Source | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function fact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  const content = text(value);
  return content === undefined ? [] : [{ label, value: content }];
}
function named(source: Source, label: WidgetMessageKey): JiraAgileDetails {
  const name = text(source.name);
  const body = text(source.description);
  return {
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts: fact(label, source.id),
    labels: [],
  };
}
function entries(value: unknown): readonly Source[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Source[] = [];
  for (const item of value) {
    const parsed = record(item);
    if (parsed === undefined || text(parsed.id) === undefined) return undefined;
    result.push(parsed);
  }
  return result;
}
function grant(source: Source, schemeId: unknown): JiraAgileDetails {
  const holder = record(source.holder);
  return {
    ...named(source, "chat.jira.access.grantId"),
    facts: [
      ...fact("chat.jira.access.grantId", source.id),
      ...fact("chat.jira.access.schemeId", schemeId),
      ...fact("chat.jira.access.permission", source.permission),
      ...fact("chat.jira.access.holderType", holder?.type),
      ...fact("chat.jira.access.holderParameter", holder?.parameter),
    ],
    labels: ["chat.jira.access.configurationOnly"],
  };
}
function schemeChildren(
  source: Source,
  security: boolean,
): readonly JiraAgileDetails[] {
  const children = entries(security ? source.levels : source.permissions);
  const head = named(source, "chat.jira.access.schemeId");
  const labels: WidgetMessageKey[] = ["chat.jira.access.configurationOnly"];
  if (children === undefined)
    labels.push(security ? "chat.jira.access.levelsUnknown" : "chat.jira.access.grantsUnknown");
  const facts = [
    ...head.facts,
    ...(security ? fact("chat.jira.access.defaultLevelId", source.defaultSecurityLevelId) : []),
    ...(children === undefined ? [] : [{
      label: security ? "chat.jira.access.levelCount" : "chat.jira.access.grantCount",
      value: String(children.length),
    } satisfies JiraOutcomeFact]),
  ];
  return [
    { ...head, facts, labels },
    ...(children ?? []).map((child) => security
      ? {
          ...named(child, "chat.jira.access.levelId"),
          facts: [
            ...fact("chat.jira.access.levelId", child.id),
            ...fact("chat.jira.access.schemeId", source.id),
          ],
          labels: ["chat.jira.access.configurationOnly"] satisfies WidgetMessageKey[],
        }
      : grant(child, source.id)),
  ];
}
function recipientIdentity(source: Source, type: string): JiraOutcomeFact[] {
  if (type === "EmailAddress") return fact("chat.jira.access.recipientEmail", source.emailAddress);
  if (type === "Group") return fact("chat.jira.fact.groupName", record(source.group)?.name);
  if (type === "User") {
    const user = record(source.user);
    return [
      ...fact("chat.jira.fact.userKey", user?.key),
      ...fact("chat.jira.fact.userName", user?.name),
      ...fact("chat.jira.fact.userDisplayName", user?.displayName),
    ];
  }
  if (type !== "ProjectRole" && type !== "UserCustomField" && type !== "GroupCustomField")
    return [];
  const identity = record(type === "ProjectRole" ? source.projectRole : source.field);
  return [
    ...fact(type === "ProjectRole" ? "chat.jira.fact.roleId" : "chat.jira.access.fieldId", identity?.id),
    ...fact(type === "ProjectRole" ? "chat.jira.fact.roleName" : "chat.jira.access.fieldName", identity?.name),
  ];
}
function recipient(source: Source, eventId: unknown, schemeId: unknown): JiraAgileDetails {
  const type = text(source.notificationType) ?? "";
  const label = Object.hasOwn(RECIPIENT_LABELS, type) ? RECIPIENT_LABELS[type] : undefined;
  const labels: WidgetMessageKey[] = [label ?? "chat.jira.access.recipientUnknown"];
  const user = type === "User" ? record(source.user) : undefined;
  if (typeof user?.active === "boolean")
    labels.push(user.active ? "chat.jira.outcome.active" : "chat.jira.outcome.inactive");
  const expanded = type === "ProjectRole" ? record(source.projectRole)
    : type === "UserCustomField" || type === "GroupCustomField" ? record(source.field) : undefined;
  const body = text(expanded?.description);
  return {
    ...(body === undefined ? {} : { body }),
    facts: [
      ...fact("chat.jira.access.recipientId", source.id),
      ...fact("chat.jira.access.eventId", eventId),
      ...fact("chat.jira.access.schemeId", schemeId),
      ...fact("chat.jira.access.recipientParameter", source.parameter),
      ...recipientIdentity(source, type),
    ],
    labels,
  };
}
function templateEvents(source: Source, schemeId: unknown): readonly JiraAgileDetails[] {
  if (source.templateEvents === undefined) return [];
  const templates = entries(source.templateEvents);
  if (templates === undefined || templates.length > 7)
    return [{ facts: [], labels: ["chat.jira.access.templateDetailsUnavailable"] }];
  return templates.map((template, index): JiraAgileDetails => ({
    ...named(template, "chat.jira.access.eventId"),
    facts: [
      ...fact("chat.jira.access.eventId", template.id),
      ...fact("chat.jira.access.schemeId", schemeId),
      ...fact("chat.jira.access.parentEventId", index === 0 ? source.id : templates.at(index - 1)?.id),
    ],
    labels: ["chat.jira.access.templateEvent"],
  }));
}
function notificationEvent(source: Source, schemeId: unknown): readonly JiraAgileDetails[] {
  const recipients = entries(source.notifications);
  const head = named(source, "chat.jira.access.eventId");
  const labels: WidgetMessageKey[] = ["chat.jira.access.notificationEvent"];
  if (recipients === undefined) labels.push("chat.jira.access.recipientsUnknown");
  return [
    {
      ...head,
      facts: [
        ...head.facts,
        ...fact("chat.jira.access.schemeId", schemeId),
        ...(recipients === undefined ? [] : [{
          label: "chat.jira.access.recipientCount",
          value: String(recipients.length),
        } satisfies JiraOutcomeFact]),
      ],
      labels,
    },
    ...(recipients ?? []).map((value) => recipient(value, source.id, schemeId)),
    ...templateEvents(source, schemeId),
  ];
}
function notificationScheme(source: Source, context: Source): readonly JiraAgileDetails[] {
  const head = named(source, "chat.jira.access.schemeId");
  const events = context.eventsRequested === true && source.eventsAvailable === true
    ? entries(source.events) : undefined;
  const requested = context.eventsRequested;
  const labels: WidgetMessageKey[] = ["chat.jira.access.notificationsConfigurationOnly"];
  if (events === undefined)
    labels.push(requested === false
      ? "chat.jira.access.eventsNotRequested" : "chat.jira.access.eventsUnavailable");
  return [
    {
      ...head,
      facts: [
        ...head.facts,
        ...fact("chat.jira.fact.projectId", context.projectId),
        ...fact("chat.jira.fact.projectKey", context.projectKey),
        ...(events === undefined ? [] : [{
          label: "chat.jira.access.eventCount", value: String(events.length),
        } satisfies JiraOutcomeFact]),
      ],
      labels,
    },
    ...(events ?? []).flatMap((event) => notificationEvent(event, source.id)),
  ];
}
/** Flatten only documented configuration relationships into the existing named result cards. */
export function jiraAccessDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  const sources = entries(data.items) ?? [data];
  return sources.flatMap((source): readonly JiraAgileDetails[] => {
    if (text(source.id) === undefined) return [];
    if (NOTIFICATIONS.has(tool)) return notificationScheme(source, data);
    if (GRANTS.has(tool)) return [grant(source, data.schemeId)];
    if (PERMISSION_SCHEMES.has(tool)) return schemeChildren(source, false);
    if (SECURITY_SCHEMES.has(tool)) return schemeChildren(source, true);
    return tool === "jira_security_level"
      ? [{ ...named(source, "chat.jira.access.levelId"), labels: ["chat.jira.access.configurationOnly"] }]
      : [];
  });
}
