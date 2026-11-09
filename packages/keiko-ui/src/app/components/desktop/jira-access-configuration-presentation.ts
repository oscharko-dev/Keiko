import {
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  JIRA_ROLE_MUTATIONS,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationMutationLabels,
  jiraPresentationNativeText as nativeText,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const aliases = (names: readonly string[]): ReadonlySet<string> =>
  new Set(names.map((name) => name.replace(/[.-]/gu, "_")));
const JIRA_PERMISSION_SCHEME_WRITE_TOOLS = aliases(JIRA_PERMISSION_SCHEME_MUTATIONS);
export const JIRA_ROLE_WRITE_TOOLS = aliases(JIRA_ROLE_MUTATIONS);
export const JIRA_ACCESS_CONFIGURATION_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_PERMISSION_SCHEME_WRITE_TOOLS,
  ...JIRA_ROLE_WRITE_TOOLS,
]);
const ACTORS = {
  jira_add_role_default_actors: { scope: "role-defaults", change: "add" },
  jira_delete_role_default_actor: { scope: "role-defaults", change: "remove" },
  jira_add_project_role_actors: { scope: "project-membership", change: "add" },
  jira_set_project_role_actors: { scope: "project-membership", change: "replace" },
  jira_delete_project_role_actor: { scope: "project-membership", change: "remove" },
} as const;
function actorTool(tool: string): tool is keyof typeof ACTORS {
  return Object.hasOwn(ACTORS, tool);
}
const ROLE_FIELDS = ["roleId", "rolePresent"] as const;
const ACTOR_FIELDS = [
  ...ROLE_FIELDS,
  "roleActorsScope",
  "actorChange",
  "actorUserKeys",
  "actorGroupNames",
] as const;
const SCHEME_FIELDS = ["schemeId", "schemePresent"] as const;
const GRANT_FIELDS = ["schemeId", "permissionId", "grantPresent"] as const;
const ATTRIBUTE_FIELDS = ["schemeId", "attributeKey", "attributeEnabled"] as const;
const CONTEXT_FIELDS = new Set([
  ...ACTOR_FIELDS,
  ...SCHEME_FIELDS,
  ...GRANT_FIELDS,
  ...ATTRIBUTE_FIELDS,
  "swapRoleId",
  "projectId",
  "projectKey",
]);
function closedContext(source: Source, allowed: readonly string[]): boolean {
  return Array.from(CONTEXT_FIELDS).every(
    (key) => !Object.hasOwn(source, key) || allowed.includes(key),
  );
}
function roleContextFields(tool: string): readonly string[] {
  if (actorTool(tool))
    return ACTORS[tool].scope === "project-membership"
      ? [...ACTOR_FIELDS, "projectId", "projectKey"]
      : ACTOR_FIELDS;
  return tool === "jira_delete_role" ? [...ROLE_FIELDS, "swapRoleId"] : ROLE_FIELDS;
}
export function jiraAccessConfirmationUnavailable(tool: string): boolean {
  return actorTool(tool) || tool === "jira_delete_role" || tool === "jira_delete_permission_scheme";
}
/** Only actor operations may be unchanged before dispatch despite an unconfirmable ACK path. */
export function jiraAccessActorNoopSupported(tool: string): boolean {
  return actorTool(tool);
}
function principalList(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  return (
    value.every((item: unknown) => nativeText(item, 255)) && new Set(value).size === value.length
  );
}
function actorCardinality(
  change: string,
  users: readonly string[],
  groups: readonly string[],
  roleId: unknown,
): boolean {
  const count = users.length + groups.length;
  if (count > 50) return false;
  if (change === "replace") return Number.isSafeInteger(Number(roleId));
  if (change === "remove") return count === 1;
  return count > 0 && (users.length === 0 || groups.length === 0);
}
function actorComplete(tool: keyof typeof ACTORS, source: Source): boolean {
  const expected = ACTORS[tool];
  if (source.roleActorsScope !== expected.scope || source.actorChange !== expected.change)
    return false;
  if (!principalList(source.actorUserKeys) || !principalList(source.actorGroupNames)) return false;
  if (
    !actorCardinality(expected.change, source.actorUserKeys, source.actorGroupNames, source.roleId)
  )
    return false;
  return (
    expected.scope !== "project-membership" ||
    (identity(source.projectId) !== undefined && isSafeAtlassianIdentifier(source.projectKey))
  );
}
function roleComplete(tool: string, source: Source): boolean {
  if (!closedContext(source, roleContextFields(tool))) return false;
  if (identity(source.roleId) === undefined || source.rolePresent !== (tool !== "jira_delete_role"))
    return false;
  if (actorTool(tool)) return actorComplete(tool, source);
  if (source.swapRoleId === undefined) return true;
  return (
    tool === "jira_delete_role" &&
    identity(source.swapRoleId) !== undefined &&
    source.swapRoleId !== source.roleId
  );
}
function attributeKey(value: unknown): boolean {
  return (
    nativeText(value, 255) &&
    value !== "." &&
    value !== ".." &&
    !/[/\\%]/u.test(value) &&
    new TextEncoder().encode(value).length <= 255
  );
}
function attributeComplete(source: Source): boolean {
  return (
    closedContext(source, ATTRIBUTE_FIELDS) &&
    attributeKey(source.attributeKey) &&
    typeof source.attributeEnabled === "boolean"
  );
}
function grantComplete(tool: string, source: Source): boolean {
  return (
    closedContext(source, GRANT_FIELDS) &&
    identity(source.permissionId) !== undefined &&
    source.grantPresent === (tool === "jira_add_permission_grant")
  );
}
function schemeComplete(tool: string, source: Source): boolean {
  if (identity(source.schemeId) === undefined) return false;
  if (tool === "jira_set_permission_scheme_attribute") return attributeComplete(source);
  if (tool === "jira_add_permission_grant" || tool === "jira_delete_permission_grant")
    return grantComplete(tool, source);
  return (
    closedContext(source, SCHEME_FIELDS) &&
    source.schemePresent === (tool !== "jira_delete_permission_scheme")
  );
}
export function jiraAccessConfigurationIdentityComplete(tool: string, source: Source): boolean {
  if (JIRA_PERMISSION_SCHEME_WRITE_TOOLS.has(tool))
    return nativeText(source.userKey, 255, { multiline: true }) && schemeComplete(tool, source);
  return (
    JIRA_ROLE_WRITE_TOOLS.has(tool) && nativeText(source.userKey, 255) && roleComplete(tool, source)
  );
}
function outcome(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraAccessConfigurationIdentityComplete(tool, source))
    return ["chat.jira.savedConfiguration.identityUnknown"];
  if (jiraAccessActorNoopSupported(tool) && source.outcome === "rejected")
    return jiraPresentationMutationLabels(source, true);
  return jiraAccessConfirmationUnavailable(tool)
    ? ["chat.jira.savedConfiguration.unconfirmed"]
    : jiraPresentationMutationLabels(source, true);
}
function principalFacts(
  value: unknown,
  label: WidgetMessageKey,
  count: WidgetMessageKey,
): JiraOutcomeFact[] {
  return principalList(value)
    ? [{ label: count, value: String(value.length) }, ...value.flatMap((item) => fact(label, item))]
    : [];
}
function presenceLabels(value: unknown): WidgetMessageKey[] {
  if (value === true) return ["chat.jira.accessWrite.requestedPresent"];
  return value === false ? ["chat.jira.accessWrite.requestedAbsent"] : [];
}
const CHANGE_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  add: "chat.jira.accessWrite.addActors",
  replace: "chat.jira.accessWrite.replaceActorTarget",
  remove: "chat.jira.accessWrite.removeActor",
};
function roleDetails(tool: string, source: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = [
    ...outcome(tool, source),
    "chat.jira.access.configurationOnly",
    ...presenceLabels(source.rolePresent),
  ];
  if (actorTool(tool))
    labels.push(
      ACTORS[tool].scope === "role-defaults"
        ? "chat.jira.role.defaultsScope"
        : "chat.jira.role.membershipScope",
      "chat.jira.accessWrite.actorTargets",
      "chat.jira.accessWrite.actorUnconfirmed",
    );
  const change =
    typeof source.actorChange === "string" && Object.hasOwn(CHANGE_LABELS, source.actorChange)
      ? CHANGE_LABELS[source.actorChange]
      : undefined;
  if (change !== undefined) labels.push(change);
  if (tool === "jira_delete_role") labels.push("chat.jira.accessWrite.roleDeleteUnconfirmed");
  return {
    labels,
    facts: [
      ...fact("chat.jira.fact.roleId", identity(source.roleId)),
      ...fact("chat.jira.fact.userKey", source.userKey),
      ...fact("chat.jira.accessWrite.swapRoleId", identity(source.swapRoleId)),
      ...fact("chat.jira.fact.projectId", identity(source.projectId)),
      ...fact("chat.jira.fact.projectKey", source.projectKey),
      ...principalFacts(
        source.actorUserKeys,
        "chat.jira.accessWrite.userKey",
        "chat.jira.accessWrite.userCount",
      ),
      ...principalFacts(
        source.actorGroupNames,
        "chat.jira.accessWrite.groupName",
        "chat.jira.accessWrite.groupCount",
      ),
    ],
  };
}
function attributeFacts(tool: string, source: Source): JiraOutcomeFact[] {
  if (
    tool !== "jira_set_permission_scheme_attribute" ||
    typeof source.attributeEnabled !== "boolean"
  )
    return [];
  const confirmed =
    source.outcome === "succeeded" && jiraAccessConfigurationIdentityComplete(tool, source);
  return [
    {
      label: confirmed
        ? "chat.jira.accessWrite.observedAttribute"
        : "chat.jira.accessWrite.requestedAttribute",
      value: String(source.attributeEnabled),
    },
  ];
}
function schemeDetails(tool: string, source: Source): JiraAgileDetails {
  return {
    facts: [
      ...fact("chat.jira.access.schemeId", identity(source.schemeId)),
      ...fact("chat.jira.fact.userKey", source.userKey),
      ...fact("chat.jira.access.grantId", identity(source.permissionId)),
      ...fact("chat.jira.accessWrite.attributeKey", source.attributeKey),
      ...attributeFacts(tool, source),
    ],
    labels: [
      ...outcome(tool, source),
      "chat.jira.access.configurationOnly",
      ...presenceLabels(source.schemePresent ?? source.grantPresent),
      ...(tool === "jira_delete_permission_scheme"
        ? (["chat.jira.accessWrite.schemeDeleteUnconfirmed"] as const)
        : []),
    ],
  };
}
export function jiraAccessConfigurationDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (JIRA_ROLE_WRITE_TOOLS.has(tool)) return [roleDetails(tool, source)];
  return JIRA_PERMISSION_SCHEME_WRITE_TOOLS.has(tool) ? [schemeDetails(tool, source)] : [];
}
