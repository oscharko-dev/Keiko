import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const OPERATIONS = {
  "jira.create-filter": "create", "jira.update-filter": "filter", "jira.delete-filter": "delete-filter",
  "jira.set-filter-share-scope": "scope", "jira.set-filter-columns": "columns", "jira.reset-filter-columns": "reset-columns",
  "jira.add-filter-permission": "permission", "jira.delete-filter-permission": "permission",
  "jira.set-my-preference": "preference", "jira.delete-my-preference": "delete-preference",
} as const;
type Family = (typeof OPERATIONS)[keyof typeof OPERATIONS];
const FAMILIES: ReadonlyMap<string, Family> = new Map(Object.entries(OPERATIONS).map(([operation, family]) => [operation.replace(/[.-]/gu, "_"), family] as const));
export const JIRA_SAVED_CONFIGURATION_WRITE_TOOLS: ReadonlySet<string> = new Set(FAMILIES.keys());
const NAMED_ACTOR = new Set<Family>(["scope", "preference", "delete-preference"]);
const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  PRIVATE: "chat.jira.savedConfiguration.private", AUTHENTICATED: "chat.jira.savedConfiguration.authenticated", GLOBAL: "chat.jira.savedConfiguration.global",
};
export function jiraSavedConfigurationScopeLabel(value: unknown): WidgetMessageKey | undefined {
  return typeof value === "string" && Object.hasOwn(SCOPES, value) ? SCOPES[value] : undefined;
}
function actorPresent(source: Source, named: boolean): boolean {
  return Object.hasOwn(source, "userKey") && text(source.userKey) !== undefined &&
    (!named || (Object.hasOwn(source, "username") && text(source.username) !== undefined));
}
function ownIdentity(source: Source, field: string): boolean {
  return Object.hasOwn(source, field) && identity(source[field]) !== undefined;
}
export function jiraSavedConfigurationFilterContextComplete(tool: string, source: Source): boolean {
  const family = FAMILIES.get(tool);
  return family !== undefined && !NAMED_ACTOR.has(family) && actorPresent(source, false) && ownIdentity(source, "filterId");
}
function filterReceiptComplete(family: Family, source: Source): boolean {
  if (!ownIdentity(source, "filterId")) return false;
  if (family === "permission") return ownIdentity(source, "permissionId");
  return family !== "create" || (Object.hasOwn(source, "defaultSharingAtomic") && source.defaultSharingAtomic === false &&
    Object.hasOwn(source, "observedShareScope") && jiraSavedConfigurationScopeLabel(source.observedShareScope) !== undefined);
}
function preferenceReceiptComplete(family: Family, source: Source): boolean {
  return Object.hasOwn(source, "preferenceKey") && text(source.preferenceKey) !== undefined &&
    Object.hasOwn(source, "preferencePresent") && source.preferencePresent === (family === "preference");
}
/** The saved receipt must identify its own family before a display claims confirmation. */
export function jiraSavedConfigurationIdentityComplete(tool: string, source: Source): boolean {
  const family = FAMILIES.get(tool);
  if (family === undefined || !actorPresent(source, NAMED_ACTOR.has(family))) return false;
  if (family === "scope") return Object.hasOwn(source, "observedShareScope") && jiraSavedConfigurationScopeLabel(source.observedShareScope) !== undefined;
  if (family === "preference" || family === "delete-preference") return preferenceReceiptComplete(family, source);
  return filterReceiptComplete(family, source);
}
/** These APIs cannot prove complete absence after an acknowledgement. */
export function jiraSavedConfigurationDeletionUnconfirmed(tool: string): boolean {
  const family = FAMILIES.get(tool);
  return family === "delete-filter" || family === "delete-preference";
}
function statusLabels(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraSavedConfigurationIdentityComplete(tool, source)) return ["chat.jira.savedConfiguration.identityUnknown"];
  if (jiraSavedConfigurationDeletionUnconfirmed(tool)) return ["chat.jira.savedConfiguration.deletionUnconfirmed"];
  if (source.outcome === "succeeded") return ["chat.jira.savedConfiguration.confirmed"];
  if (source.outcome === "rejected" && source.reason === "conflict" && source.unchanged === true)
    return ["chat.jira.savedConfiguration.unchanged"];
  return ["chat.jira.savedConfiguration.unconfirmed"];
}
function familyLabels(family: Family, source: Source): WidgetMessageKey[] {
  if (family === "create") return ["chat.jira.savedConfiguration.nonAtomicCreate"];
  if (family === "scope") return ["chat.jira.savedConfiguration.futureDefaults"];
  if (family === "reset-columns") return ["chat.jira.savedConfiguration.resetProof"];
  if (family === "preference" || family === "delete-preference") return ["chat.jira.savedConfiguration.currentUserOnly",
    ...(source.preferencePresent === true ? ["chat.jira.savedConfiguration.targetPresent" as const]
      : source.preferencePresent === false ? ["chat.jira.savedConfiguration.targetAbsent" as const] : [])];
  return [];
}
/** Known identity survives uncertainty; a requested target never proves that the effect occurred. */
export function jiraSavedConfigurationDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  const family = FAMILIES.get(tool);
  if (family === undefined) return [];
  const scope = jiraSavedConfigurationIdentityComplete(tool, source) ? jiraSavedConfigurationScopeLabel(source.observedShareScope) : undefined;
  return [{ facts: [
    ...fact("chat.jira.fact.filterId", identity(source.filterId)),
    ...fact("chat.jira.fact.sharePermissionId", identity(source.permissionId)),
    ...fact("chat.jira.fact.userKey", source.userKey), ...fact("chat.jira.fact.userName", source.username),
    ...fact("chat.jira.settings.key", source.preferenceKey),
  ], labels: [...statusLabels(tool, source), ...familyLabels(family, source),
    ...(scope === undefined ? [] : ["chat.jira.savedConfiguration.returnedScope" as const, scope])] }];
}
