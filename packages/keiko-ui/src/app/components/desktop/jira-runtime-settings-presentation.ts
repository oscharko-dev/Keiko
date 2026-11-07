import type { JiraAgileDetails } from "./jira-agile-presentation";
import type { JiraPresentationSource as Source } from "./jira-presentation-values";

export const JIRA_RUNTIME_SETTINGS_TOOLS: ReadonlySet<string> = new Set([
  "jira_jmx_metrics_exposed", "jira_search_max_aggregation_buckets", "jira_search_max_result_window",
]);
/** Signed native settings remain observations; sentinel meanings and authority are not inferred. */
export function jiraRuntimeSettingsDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_RUNTIME_SETTINGS_TOOLS.has(tool) || data.outcome === "failed") return [];
  const exposure = tool === "jira_jmx_metrics_exposed";
  if (data.outcome !== "succeeded" && !Object.hasOwn(data, exposure ? "exposed" : "limit")) return [];
  if (exposure) return [{ facts: [], labels: ["chat.jira.runtimeSettings.exposureObservation",
    data.exposed === true ? "chat.jira.runtimeSettings.exposed"
      : data.exposed === false ? "chat.jira.runtimeSettings.notExposed" : "chat.jira.runtimeSettings.exposureUnknown"] }];
  if (typeof data.limit !== "number" || !Number.isSafeInteger(data.limit)) return [{
    facts: [], labels: ["chat.jira.runtimeSettings.limitObservation", "chat.jira.runtimeSettings.limitUnknown"],
  }];
  return [{ facts: [{ label: tool === "jira_search_max_aggregation_buckets"
    ? "chat.jira.runtimeSettings.aggregationLimit" : "chat.jira.runtimeSettings.resultWindowLimit", value: String(data.limit) }],
    labels: ["chat.jira.runtimeSettings.limitObservation"],
  }];
}
