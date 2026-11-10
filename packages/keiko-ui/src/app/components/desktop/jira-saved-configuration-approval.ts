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
function reviewedList(
  value: unknown,
  emptyLabel: WidgetMessageKey,
  t: OptionalWidgetTranslate,
  present: (entry: unknown) => JiraDraftValue,
): JiraDraftValue {
  if (!Array.isArray(value)) return jiraDraftValueOf(value);
  if (value.length === 0) return literal(t(emptyLabel));
  return {
    kind: "list",
    items: value.map((entry: unknown, index) => ({ position: index + 1, value: present(entry) })),
  };
}
function orderedList(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  return reviewedList(value, "chat.jira.savedConfiguration.reviewedEmptyList", t, jiraDraftValueOf);
}
const KNOWN_PERMISSION_FIELDS = new Set([
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
interface RightLabels {
  readonly unknown: WidgetMessageKey;
  readonly granted: WidgetMessageKey;
  readonly notGranted: WidgetMessageKey;
}
const VIEW_RIGHT_LABELS: RightLabels = {
  unknown: "chat.jira.savedConfiguration.viewUnknown",
  granted: "chat.jira.savedView.viewGranted",
  notGranted: "chat.jira.savedView.viewNotGranted",
};
const EDIT_RIGHT_LABELS: RightLabels = {
  unknown: "chat.jira.savedConfiguration.editUnknown",
  granted: "chat.jira.savedView.editGranted",
  notGranted: "chat.jira.savedView.editNotGranted",
};
function rightLabel(value: unknown, labels: RightLabels): WidgetMessageKey {
  if (typeof value !== "boolean") return labels.unknown;
  return value ? labels.granted : labels.notGranted;
}
function permissionFieldName(field: string, t: OptionalWidgetTranslate): string {
  if (field === "userKey") return t("chat.jira.fact.userKey");
  if (field === "expectedUsername") return t("chat.jira.savedConfiguration.reviewedUsername");
  return field;
}
function permission(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return jiraDraftValueOf(value);
  const details = jiraSavedViewDetails("jira_filter_permission", source);
  const labels: WidgetMessageKey[] = [
    "chat.jira.savedView.permissionHelp",
    rightLabel(source.view, VIEW_RIGHT_LABELS),
    rightLabel(source.edit, EDIT_RIGHT_LABELS),
  ];
  return {
    kind: "group",
    members: [
      ...details.facts.map((entry) => ({ name: t(entry.label), value: literal(entry.value) })),
      {
        name: t("chat.jira.savedConfiguration.sharingRights"),
        value: literal(labels.map((label) => t(label)).join(" · ")),
      },
      ...Object.entries(source)
        .filter(([field]) => !KNOWN_PERMISSION_FIELDS.has(field))
        .map(([field, entry]) => ({
          name: permissionFieldName(field, t),
          value: jiraDraftValueOf(entry),
        })),
    ],
  };
}
function permissionList(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  return reviewedList(value, "chat.jira.savedConfiguration.reviewedEmptyPermissions", t, (entry) =>
    permission(entry, t),
  );
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
  const label = specialLabel(key, value);
  return label === undefined ? jiraDraftValueOf(value) : literal(t(label));
}
function specialLabel(key: string, value: unknown): WidgetMessageKey | undefined {
  if (value === null) return NULL_LABELS[key];
  return value === "" ? EMPTY_LABELS[key] : undefined;
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
