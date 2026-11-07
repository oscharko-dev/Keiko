import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  jira_application_properties: "chat.jira.settings.applicationScope",
  jira_advanced_settings: "chat.jira.settings.advancedScope",
  jira_my_preference: "chat.jira.settings.preferenceScope",
};
export const JIRA_APPLICATION_SETTINGS_TOOLS: ReadonlySet<string> = new Set(Object.keys(SCOPES));
const UNKNOWN: JiraAgileDetails = { facts: [], labels: ["chat.jira.settings.unknown"] };

function observedValue(source: Source): JiraAgileDetails {
  switch (source.valueType) {
    case "string": {
      if (typeof source.stringValue !== "string") return UNKNOWN;
      if (source.stringValue === "") return { facts: [], labels: ["chat.jira.settings.emptyText"] };
      return {
        facts: [{ label: "chat.jira.settings.stringValue", value: source.stringValue }],
        labels: source.stringValue.trim() === "" ? ["chat.jira.settings.whitespaceText"] : [],
      };
    }
    case "boolean":
      return typeof source.booleanValue === "boolean"
        ? { facts: [], labels: [source.booleanValue ? "chat.jira.settings.true" : "chat.jira.settings.false"] }
        : UNKNOWN;
    case "integer":
      return typeof source.integerValue === "number" && Number.isSafeInteger(source.integerValue)
        ? { facts: [{ label: "chat.jira.settings.integerValue", value: String(source.integerValue) }], labels: [] }
        : UNKNOWN;
    default:
      return UNKNOWN;
  }
}
function setting(value: unknown): JiraAgileDetails {
  const source = record(value);
  const key = text(source?.key);
  if (source === undefined || key === undefined)
    return { facts: [], labels: ["chat.jira.settings.keyUnknown", ...UNKNOWN.labels] };
  const projected = source.valueState === "withheld"
    ? { facts: [], labels: ["chat.jira.settings.withheld"] as const }
    : source.valueState === "observed" ? observedValue(source) : UNKNOWN;
  return { ...projected, facts: [{ label: "chat.jira.settings.key", value: key }, ...projected.facts] };
}
function header(tool: string, data: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = ["chat.jira.settings.observation"];
  const scope = SCOPES[tool];
  if (scope !== undefined) labels.push(scope);
  const facts: JiraOutcomeFact[] = [];
  if (data.permissionLevel === "ADMIN" || data.permissionLevel === "SYSADMIN") {
    facts.push({ label: "chat.jira.settings.permissionFilter", value: data.permissionLevel });
    labels.push("chat.jira.settings.filterOnly");
  }
  if (typeof data.total === "number" && Number.isSafeInteger(data.total) && data.total >= 0)
    facts.push({ label: "chat.jira.settings.collectionCount", value: String(data.total) });
  return { facts, labels };
}
/** The existing private result card displays only the producer's observed typed value. */
export function jiraApplicationSettingsDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_APPLICATION_SETTINGS_TOOLS.has(tool) || data.outcome === "failed") return [];
  const heading = header(tool, data);
  if (Array.isArray(data.items)) return [heading, ...(data.items.length === 0
    ? [{ facts: [], labels: ["chat.jira.settings.emptyList"] } satisfies JiraAgileDetails]
    : data.items.map(setting))];
  if (tool === "jira_advanced_settings" || data.permissionLevel !== undefined)
    return [heading, { facts: [], labels: ["chat.jira.settings.listUnknown"] }];
  return [heading, setting(data)];
}
