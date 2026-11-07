import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraProjectAssociationDetails } from "./jira-project-association-presentation";

import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";
export const JIRA_ROLE_TOOLS: ReadonlySet<string> = new Set([
  "jira_roles", "jira_role", "jira_role_default_actors", "jira_project_roles", "jira_project_role",
  "jira_priority_schemes", "jira_priority_scheme",
]);
const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  "role-configuration": "chat.jira.role.configurationScope",
  "role-defaults": "chat.jira.role.defaultsScope",
  "project-membership": "chat.jira.role.membershipScope",
};
function scope(value: unknown): WidgetMessageKey {
  return typeof value === "string" && Object.hasOwn(SCOPES, value)
    ? SCOPES[value] ?? "chat.jira.role.scopeUnknown" : "chat.jira.role.scopeUnknown";
}
function actor(source: Source, roleId: unknown, actorsScope: unknown): JiraAgileDetails | undefined {
  const name = text(source.name);
  if (name === undefined) return undefined;
  return {
    name: text(source.displayName) ?? name,
    facts: [
      ...fact("chat.jira.fact.roleId", roleId),
      { label: "chat.jira.role.actorName", value: name },
      ...fact("chat.jira.role.actorId", source.id),
      ...fact("chat.jira.role.actorType", source.type),
    ],
    labels: [scope(actorsScope)],
  };
}
function actors(value: unknown, roleId: unknown, actorsScope: unknown): readonly JiraAgileDetails[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: JiraAgileDetails[] = [];
  for (const entry of value) {
    const source = record(entry);
    const item = source === undefined ? undefined : actor(source, roleId, actorsScope);
    if (item === undefined) return undefined;
    result.push(item);
  }
  return result;
}
function role(source: Source, actorsScope: unknown): readonly JiraAgileDetails[] {
  const id = text(source.id);
  const name = text(source.name);
  if (id === undefined || name === undefined) return [];
  const body = text(source.description);
  const members = actors(source.actors, id, actorsScope);
  return [{
    name, ...(body === undefined ? {} : { body }),
    facts: [
      { label: "chat.jira.fact.roleId", value: id },
      ...(members === undefined ? [] : [{ label: "chat.jira.role.actorCount", value: String(members.length) } satisfies JiraOutcomeFact]),
    ],
    labels: [scope(actorsScope), ...(members === undefined ? ["chat.jira.role.actorsUnknown"] as const : [])],
  }, ...(members ?? [])];
}
function defaultActors(data: Source): readonly JiraAgileDetails[] {
  const roleId = text(data.roleId);
  if (roleId === undefined) {
    const item = actor(data, undefined, data.actorsScope);
    return item === undefined ? [] : [item];
  }
  const members = actors(data.items, roleId, data.actorsScope);
  return [{
    facts: [{ label: "chat.jira.fact.roleId", value: roleId }],
    labels: [scope(data.actorsScope), ...(members === undefined ? ["chat.jira.role.actorsUnknown"] as const : [])],
  }, ...(members ?? [])];
}
function projectContext(data: Source): JiraOutcomeFact[] {
  return [
    ...fact("chat.jira.fact.projectId", data.projectId),
    ...fact("chat.jira.fact.projectKey", data.projectKey),
  ];
}
function projectRoles(data: Source): readonly JiraAgileDetails[] {
  const context = projectContext(data);
  const sources = Array.isArray(data.items) ? data.items : [data];
  return [
    ...(context.length === 0 ? [] : [{ facts: context, labels: ["chat.jira.role.indexScope"] satisfies WidgetMessageKey[] }]),
    ...sources.flatMap((value: unknown) => {
      const name = text(record(value)?.name);
      return name === undefined ? [] : [{ name, facts: [], labels: ["chat.jira.role.indexScope"] satisfies WidgetMessageKey[] }];
    }),
  ];
}
/** Role configuration, defaults and project membership remain distinct saved observations. */
export function jiraRoleDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_ROLE_TOOLS.has(tool)) return [];
  if (tool === "jira_role_default_actors") return defaultActors(data);
  if (tool === "jira_project_roles") return projectRoles(data);
  const sources = Array.isArray(data.items) ? data.items : [data];
  const cards = sources.flatMap((value: unknown) => {
    const source = record(value);
    if (source === undefined) return [];
    return tool === "jira_priority_schemes" || tool === "jira_priority_scheme"
      ? jiraProjectAssociationDetails("jira_project_priority_scheme", source)
      : role(source, data.actorsScope);
  });
  return cards.map((card, index) => index === 0 && tool === "jira_project_role"
    ? { ...card, facts: [...projectContext(data), ...card.facts] } : card);
}
