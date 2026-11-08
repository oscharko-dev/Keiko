import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";
import { jiraPresentationRecord as record } from "./jira-presentation-values";
import { jiraSavedViewDetails } from "./jira-saved-view-presentation";
import {
  JIRA_SAVED_CONFIGURATION_WRITE_TOOLS,
  jiraSavedConfigurationScopeLabel,
} from "./jira-saved-configuration-presentation";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  filterId: "chat.jira.fact.filterId",
  permissionId: "chat.jira.fact.sharePermissionId",
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  expectedOwnerKey: "chat.jira.savedConfiguration.reviewedOwner",
  expectedName: "chat.jira.savedConfiguration.reviewedName",
  expectedJql: "chat.jira.savedConfiguration.reviewedJql",
  expectedDescription: "chat.jira.savedConfiguration.reviewedDescription",
  name: "chat.jira.savedConfiguration.newName",
  jql: "chat.jira.savedConfiguration.newJql",
  description: "chat.jira.savedConfiguration.newDescription",
  expectedDefaultShareScope: "chat.jira.savedConfiguration.reviewedDefaultScope",
  expectedScope: "chat.jira.savedConfiguration.reviewedDefaultScope",
  scope: "chat.jira.savedConfiguration.requestedDefaultScope",
  acceptDefaultSharing: "chat.jira.savedConfiguration.acceptDefaultSharing",
  acceptGlobalReplacement: "chat.jira.savedConfiguration.acceptGlobalReplacement",
  expectedColumns: "chat.jira.savedConfiguration.reviewedColumns",
  columns: "chat.jira.savedConfiguration.requestedColumns",
  expectedColumnConfig: "chat.jira.savedConfiguration.reviewedColumnConfig",
  expectedPermissions: "chat.jira.savedConfiguration.reviewedPermissions",
  permission: "chat.jira.savedConfiguration.requestedPermission",
  key: "chat.jira.settings.key",
  expectedValue: "chat.jira.savedConfiguration.reviewedValue",
  value: "chat.jira.savedConfiguration.requestedValue",
};
function literal(value: string): JiraDraftValue {
  return { kind: "text", text: value };
}
function selected(operation: string | undefined): boolean {
  return (
    operation !== undefined &&
    JIRA_SAVED_CONFIGURATION_WRITE_TOOLS.has(operation.replace(/[.-]/gu, "_"))
  );
}
function typedValue(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (typeof value === "boolean")
    return literal(
      t(value ? "chat.jira.propertyMutation.true" : "chat.jira.propertyMutation.false"),
    );
  if (typeof value === "number")
    return literal(t("chat.jira.savedConfiguration.integerValue", { value: String(value) }));
  if (value === "") return literal(t("chat.jira.propertyMutation.emptyText"));
  return jiraDraftValueOf(value);
}
function orderedList(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  return Array.isArray(value)
    ? value.length === 0
      ? literal(t("chat.jira.savedConfiguration.reviewedEmptyList"))
      : {
          kind: "list",
          items: value.map((entry: unknown, index) => ({
            position: index + 1,
            value: jiraDraftValueOf(entry),
          })),
        }
    : jiraDraftValueOf(value);
}
function permission(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return jiraDraftValueOf(value);
  const details = jiraSavedViewDetails("jira_filter_permission", source);
  const labels: WidgetMessageKey[] = [
    "chat.jira.savedView.permissionHelp",
    typeof source.view !== "boolean"
      ? "chat.jira.savedConfiguration.viewUnknown"
      : source.view
        ? "chat.jira.savedView.viewGranted"
        : "chat.jira.savedView.viewNotGranted",
    typeof source.edit !== "boolean"
      ? "chat.jira.savedConfiguration.editUnknown"
      : source.edit
        ? "chat.jira.savedView.editGranted"
        : "chat.jira.savedView.editNotGranted",
  ];
  const known = new Set([
    "id",
    "type",
    "groupName",
    "projectId",
    "projectKey",
    "roleId",
    "roleName",
    "userName",
    "userDisplayName",
    "view",
    "edit",
  ]);
  return {
    kind: "group",
    members: [
      ...details.facts.map((entry) => ({ name: t(entry.label), value: literal(entry.value) })),
      {
        name: t("chat.jira.savedConfiguration.sharingRights"),
        value: literal(labels.map((label) => t(label)).join(" · ")),
      },
      ...Object.entries(source)
        .filter(([field]) => !known.has(field))
        .map(([field, entry]) => ({
          name:
            field === "userKey"
              ? t("chat.jira.fact.userKey")
              : field === "expectedUsername"
                ? t("chat.jira.savedConfiguration.reviewedUsername")
                : field,
          value: jiraDraftValueOf(entry),
        })),
    ],
  };
}
function permissionList(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  return Array.isArray(value)
    ? value.length === 0
      ? literal(t("chat.jira.savedConfiguration.reviewedEmptyPermissions"))
      : {
          kind: "list",
          items: value.map((entry: unknown, index) => ({
            position: index + 1,
            value: permission(entry, t),
          })),
        }
    : jiraDraftValueOf(value);
}
const VALUE_PRESENTERS: Readonly<
  Record<string, (value: unknown, t: OptionalWidgetTranslate) => JiraDraftValue>
> = {
  expectedPermissions: permissionList,
  permission,
  columns: orderedList,
  expectedColumns: orderedList,
  expectedValue: typedValue,
  value: typedValue,
};
const NULL_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedDescription: "chat.jira.savedConfiguration.descriptionNotProvided",
  expectedColumnConfig: "chat.jira.savedConfiguration.provenanceNotProvided",
};
const EMPTY_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  description: "chat.jira.savedConfiguration.clearDescription",
  expectedDescription: "chat.jira.fact.reviewedEmptyText",
};
function specialValue(key: string, value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const presenter = Object.hasOwn(VALUE_PRESENTERS, key) ? VALUE_PRESENTERS[key] : undefined;
  if (presenter !== undefined) return presenter(value, t);
  const label = value === null ? NULL_LABELS[key] : value === "" ? EMPTY_LABELS[key] : undefined;
  return label === undefined ? jiraDraftValueOf(value) : literal(t(label));
}
/** Every approved snapshot leaf remains visible, including unknown rights and repeated ordered columns. */
export function jiraSavedConfigurationFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  if (!selected(operation)) return undefined;
  const label = LABELS[key];
  if (label === undefined) return undefined;
  const scope =
    key === "scope" || key === "expectedScope" || key === "expectedDefaultShareScope"
      ? jiraSavedConfigurationScopeLabel(value)
      : undefined;
  return [
    { id: t(label), value: scope === undefined ? specialValue(key, value, t) : literal(t(scope)) },
  ];
}
export function jiraSavedConfigurationContextFacts(
  operation: string | undefined,
  args: Readonly<Record<string, unknown>>,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  if (!selected(operation)) return [];
  const messages: WidgetMessageKey[] = [];
  if (operation === "jira.create-filter")
    messages.push("chat.jira.savedConfiguration.nonAtomicCreate");
  if (operation === "jira.set-filter-share-scope")
    messages.push("chat.jira.savedConfiguration.futureDefaults");
  if (operation === "jira.add-filter-permission" && record(args.permission)?.type === "global")
    messages.push("chat.jira.savedConfiguration.globalReplacement");
  if (operation === "jira.delete-filter" || operation === "jira.delete-my-preference")
    messages.push("chat.jira.savedConfiguration.deletionUnconfirmed");
  if (operation === "jira.reset-filter-columns")
    messages.push("chat.jira.savedConfiguration.resetProof");
  return messages.map((message) => ({
    id: t("chat.jira.savedConfiguration.nativeLimitation"),
    value: literal(t(message)),
  }));
}
