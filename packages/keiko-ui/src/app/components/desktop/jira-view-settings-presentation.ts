import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_VIEW_SETTINGS_TOOLS: ReadonlySet<string> = new Set([
  "jira_accessibility_settings",
  "jira_system_columns",
  "jira_user_columns",
  "jira_filter_columns",
]);
const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  system: "chat.jira.viewSettings.systemLayout",
  "current-user": "chat.jira.viewSettings.currentUserLayout",
  "named-user": "chat.jira.viewSettings.namedUserLayout",
  filter: "chat.jira.viewSettings.filterLayout",
};
function accessibility(source: Source): JiraAgileDetails | undefined {
  const name = text(source.key);
  return name === undefined
    ? undefined
    : {
        name,
        facts: [],
        labels: [
          triState(
            source.enabled,
            "chat.jira.viewSettings.enabled",
            "chat.jira.viewSettings.disabled",
            "chat.jira.viewSettings.enabledUnknown",
          ),
        ],
      };
}
function column(source: Source): JiraAgileDetails | undefined {
  const id = text(source.value) ?? text(source.id);
  if (id === undefined) return undefined;
  const name = text(source.label) ?? id;
  return {
    name,
    facts: [
      { label: "chat.jira.access.fieldId", value: id },
      ...fact("chat.jira.viewSettings.headingKey", source.columnHeadingKey),
      ...(typeof source.position === "number" && Number.isSafeInteger(source.position)
        ? [
            {
              label: "chat.jira.viewSettings.position",
              value: String(source.position),
            } satisfies JiraOutcomeFact,
          ]
        : []),
    ],
    labels: [],
  };
}
function layoutContext(data: Source): JiraAgileDetails {
  const scope =
    typeof data.layoutScope === "string" && Object.hasOwn(SCOPES, data.layoutScope)
      ? SCOPES[data.layoutScope]
      : undefined;
  const labels: WidgetMessageKey[] = [
    scope ?? "chat.jira.viewSettings.scopeUnknown",
    "chat.jira.viewSettings.layoutObservation",
  ];
  if (data.columnsAvailable === false || !Array.isArray(data.items))
    labels.push("chat.jira.viewSettings.columnsUnknown");
  return {
    facts: [
      ...fact("chat.jira.viewSettings.requestedUser", data.selectedUsername),
      ...fact("chat.jira.viewSettings.requestedFilter", data.selectedFilterId),
      ...fact("chat.jira.viewSettings.nativeLayoutMode", data.columnConfig),
    ],
    labels,
  };
}
/** Saved native preferences are observations for their reported scope, never local setting changes. */
export function jiraViewSettingsDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_VIEW_SETTINGS_TOOLS.has(tool) || data.outcome === "failed") return [];
  const a11y = tool === "jira_accessibility_settings";
  const items = (Array.isArray(data.items) ? data.items : [data]).flatMap((value: unknown) => {
    const source = record(value);
    const item = source === undefined ? undefined : viewItem(a11y, source);
    return item === undefined ? [] : [item];
  });
  if (!a11y)
    return data.outcome === "succeeded" || data.layoutScope !== undefined
      ? [layoutContext(data), ...items]
      : items;
  return Array.isArray(data.items)
    ? [
        {
          facts: [],
          labels: [
            data.settingsScope === "connected-user"
              ? "chat.jira.viewSettings.connectedUser"
              : "chat.jira.viewSettings.scopeUnknown",
            "chat.jira.viewSettings.observation",
          ],
        },
        ...items,
      ]
    : items;
}

function triState<T extends string>(value: unknown, yes: T, no: T, unknown: T): T {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
function viewItem(a11y: boolean, source: Source): JiraAgileDetails | undefined {
  return a11y ? accessibility(source) : column(source);
}
