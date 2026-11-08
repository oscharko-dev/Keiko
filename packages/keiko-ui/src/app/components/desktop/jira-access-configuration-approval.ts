import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraDraftField, JiraDraftValue } from "./jiraDraftTree";
import { jiraPresentationRecord as record } from "./jira-presentation-values";
import { jiraReviewedMutationScalar as scalar } from "./jira-structural-mutation-approval";
import {
  JIRA_ACCESS_CONFIGURATION_TOOLS,
  JIRA_ROLE_WRITE_TOOLS,
  jiraAccessConfirmationUnavailable,
} from "./jira-access-configuration-presentation";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  expectedScheme: "chat.jira.accessWrite.reviewedScheme",
  name: "chat.jira.structural.nativeName",
  description: "chat.jira.structural.nativeDescription",
  permissions: "chat.jira.accessWrite.permissions",
  grant: "chat.jira.accessWrite.grant",
  permissionId: "chat.jira.access.grantId",
  confirmUnverifiedDeletion: "chat.jira.categoryWrite.acceptUnconfirmed",
  attributeKey: "chat.jira.accessWrite.attributeKey",
  expectedValue: "chat.jira.accessWrite.reviewedAttribute",
  enabled: "chat.jira.accessWrite.requestedAttribute",
  expectedRole: "chat.jira.accessWrite.reviewedRole",
  expectedActors: "chat.jira.accessWrite.reviewedActors",
  expectedSwapRole: "chat.jira.accessWrite.reviewedSwapRole",
  expectedSwapActors: "chat.jira.accessWrite.reviewedSwapActors",
  projectIdOrKey: "chat.jira.fact.project",
  principals: "chat.jira.accessWrite.principals",
};
const MEMBER_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  ...LABELS,
  id: "chat.jira.planning.nativeId",
  permission: "chat.jira.access.permission",
  holder: "chat.jira.accessWrite.holder",
  type: "chat.jira.accessWrite.nativeType",
  parameter: "chat.jira.access.holderParameter",
  users: "chat.jira.accessWrite.users",
  groups: "chat.jira.accessWrite.groups",
  key: "chat.jira.accessWrite.userKey",
};
const GROUP_KEYS = new Set([
  "expectedScheme",
  "expectedRole",
  "expectedSwapRole",
  "grant",
  "holder",
  "principals",
]);
const LIST_KEYS = new Set([
  "permissions",
  "expectedActors",
  "expectedSwapActors",
  "users",
  "groups",
]);
const literal = (text: string): JiraDraftValue => ({ kind: "text", text });
function selected(operation: string | undefined): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  return tool !== undefined && JIRA_ACCESS_CONFIGURATION_TOOLS.has(tool) ? tool : undefined;
}
function group(value: unknown, t: OptionalWidgetTranslate, current = false): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return scalar(value, t);
  return {
    kind: "group",
    members: Object.entries(source).map(([key, item]) => ({
      name:
        current && key === "permissions"
          ? t("chat.jira.accessWrite.reviewedGrants")
          : memberLabel(key, t),
      value: reviewed(key, item, t),
    })),
  };
}
function memberLabel(key: string, t: OptionalWidgetTranslate): string {
  const label = Object.hasOwn(MEMBER_LABELS, key) ? MEMBER_LABELS[key] : undefined;
  return label === undefined ? key : t(label);
}
function list(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (!Array.isArray(value)) return scalar(value, t);
  if (value.length === 0) return literal(t("chat.jira.accessWrite.emptySet"));
  return {
    kind: "list",
    items: value.map((entry: unknown, index) => ({
      position: index + 1,
      value: record(entry) === undefined ? scalar(entry, t) : group(entry, t),
    })),
  };
}
function reviewed(key: string, value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (GROUP_KEYS.has(key)) return group(value, t, key === "expectedScheme");
  if (LIST_KEYS.has(key)) return list(value, t);
  return scalar(value, t);
}
export function jiraAccessConfigurationFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  const label = Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
  if (selected(operation) === undefined || label === undefined) return undefined;
  return [{ id: t(label), value: reviewed(key, value, t) }];
}
function replacementLabels(tool: string, args: unknown): readonly WidgetMessageKey[] {
  if (tool === "jira_set_project_role_actors") return ["chat.jira.accessWrite.replaceActors"];
  if (tool !== "jira_update_permission_scheme") return [];
  return Object.hasOwn(record(args) ?? {}, "permissions")
    ? ["chat.jira.accessWrite.replaceGrants"]
    : ["chat.jira.accessWrite.retainGrants"];
}
function scopeLabels(tool: string): readonly WidgetMessageKey[] {
  if (tool.includes("project_role"))
    return ["chat.jira.role.membershipScope", "chat.jira.accessWrite.principalNamespaces"];
  if (tool.includes("default_actor"))
    return ["chat.jira.role.defaultsScope", "chat.jira.accessWrite.principalNamespaces"];
  return JIRA_ROLE_WRITE_TOOLS.has(tool)
    ? ["chat.jira.role.configurationScope"]
    : ["chat.jira.accessWrite.holderNamespaces"];
}
export function jiraAccessConfigurationContextFacts(
  operation: string | undefined,
  args: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  const tool = selected(operation);
  if (tool === undefined) return [];
  const labels: WidgetMessageKey[] = [
    "chat.jira.accessWrite.admin",
    "chat.jira.access.configurationOnly",
    "chat.jira.structural.noAtomicSnapshot",
    ...scopeLabels(tool),
    ...replacementLabels(tool, args),
  ];
  if (jiraAccessConfirmationUnavailable(tool)) labels.push("chat.jira.accessWrite.ackUnconfirmed");
  return labels.map((label) => ({
    id: t("chat.jira.savedConfiguration.nativeLimitation"),
    value: literal(t(label)),
  }));
}
