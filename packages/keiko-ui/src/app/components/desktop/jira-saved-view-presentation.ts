import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

type Source = Readonly<Record<string, unknown>>;
export const JIRA_SAVED_VIEW_TOOLS: ReadonlySet<string> = new Set([
  "jira_dashboards",
  "jira_dashboard",
  "jira_filter_share_scope",
  "jira_filter_permissions",
  "jira_filter_permission",
]);
const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  GLOBAL: "chat.jira.savedView.scopeGlobal",
  AUTHENTICATED: "chat.jira.savedView.scopeAuthenticated",
  PRIVATE: "chat.jira.savedView.scopePrivate",
};
const ID_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  filterId: "chat.jira.fact.filterId",
  projectId: "chat.jira.fact.projectId",
  roleId: "chat.jira.fact.roleId",
};
const TEXT_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  type: "chat.jira.fact.shareType",
  groupName: "chat.jira.fact.groupName",
  projectKey: "chat.jira.fact.projectKey",
  roleName: "chat.jira.fact.roleName",
  userName: "chat.jira.fact.userName",
  userDisplayName: "chat.jira.fact.userDisplayName",
};
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function scopeLabels(source: Source): WidgetMessageKey[] {
  const scope = source.scope;
  const label =
    typeof scope === "string" && Object.hasOwn(SCOPES, scope) ? SCOPES[scope] : undefined;
  return label === undefined ? [] : [label, "chat.jira.savedView.defaultScopeHelp"];
}
function permissionLabels(source: Source): WidgetMessageKey[] {
  const labels: WidgetMessageKey[] = ["chat.jira.savedView.permissionHelp"];
  if (typeof source.edit === "boolean")
    labels.push(
      source.edit ? "chat.jira.savedView.editGranted" : "chat.jira.savedView.editNotGranted",
    );
  if (typeof source.view === "boolean")
    labels.push(
      source.view ? "chat.jira.savedView.viewGranted" : "chat.jira.savedView.viewNotGranted",
    );
  return labels;
}
function labelsFor(tool: string, source: Source): WidgetMessageKey[] {
  if (tool === "jira_filter_share_scope") return scopeLabels(source);
  if (tool === "jira_filter_permissions" || tool === "jira_filter_permission")
    return id(source.id) ? permissionLabels(source) : [];
  return [];
}
/** Configured share entries are not effective permissions; no URL is inferred from an entity ID. */
export function jiraSavedViewDetails(tool: string, source: Source): JiraAgileDetails {
  const dashboard = tool === "jira_dashboard" || tool === "jira_dashboards";
  const facts: JiraOutcomeFact[] = Object.entries(ID_FACTS).flatMap(([key, label]) =>
    id(source[key]) ? [{ label, value: source[key] }] : [],
  );
  if (id(source.id))
    facts.push({
      label: dashboard ? "chat.jira.fact.dashboardId" : "chat.jira.fact.sharePermissionId",
      value: source.id,
    });
  for (const [key, label] of Object.entries(TEXT_FACTS)) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) facts.push({ label, value });
  }
  const name = dashboard && typeof source.name === "string" ? source.name : undefined;
  return {
    ...(name === undefined ? {} : { name }),
    facts,
    labels: labelsFor(tool, source),
  };
}
