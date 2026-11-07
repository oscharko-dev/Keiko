import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import type { JiraPresentationSource as Source } from "./jira-presentation-values";

export const JIRA_MONITORING_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "jira_set_app_monitoring", "jira_set_ipd_monitoring", "jira_start_jmx_metrics", "jira_stop_jmx_metrics",
]);
const OPERATIONS = new Set([
  "jira.set-app-monitoring", "jira.set-ipd-monitoring", "jira.start-jmx-metrics", "jira.stop-jmx-metrics",
]);
const ARGUMENTS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedEnabled: "chat.jira.monitoring.reviewedState",
  enabled: "chat.jira.monitoring.requestedState",
};
export function jiraMonitoringArgumentLabel(operation: string | undefined, key: string): WidgetMessageKey | undefined {
  return operation !== undefined && OPERATIONS.has(operation) ? ARGUMENTS[key] : undefined;
}
/** JMX's fixed target is part of the selected action, not another model-selected argument. */
export function jiraMonitoringFixedTarget(operation: string | undefined): boolean | undefined {
  if (operation === "jira.start-jmx-metrics") return true;
  return operation === "jira.stop-jmx-metrics" ? false : undefined;
}
function familyLabel(tool: string): WidgetMessageKey {
  if (tool === "jira_set_app_monitoring") return "chat.jira.jobs.appMonitoring";
  return tool === "jira_set_ipd_monitoring" ? "chat.jira.jobs.ipdMonitoring" : "chat.jira.monitoring.jmxExposure";
}
function stateLabels(source: Source, value: boolean): readonly WidgetMessageKey[] {
  const observedState: WidgetMessageKey = value ? "chat.jira.monitoring.observedEnabled" : "chat.jira.monitoring.observedDisabled";
  if (source.outcome === "succeeded") return ["chat.jira.monitoring.confirmed", observedState];
  if (source.outcome === "rejected" && source.reason === "conflict" && source.unchanged === true)
    return ["chat.jira.monitoring.observedNoop", observedState];
  return ["chat.jira.monitoring.targetUnconfirmed", value ? "chat.jira.monitoring.targetEnabled" : "chat.jira.monitoring.targetDisabled"];
}
function receiptState(tool: string, source: Source): boolean | undefined {
  const value = tool === "jira_set_app_monitoring" || tool === "jira_set_ipd_monitoring"
    ? source.monitoringEnabled : source.jmxMetricsExposed;
  if (typeof value !== "boolean") return undefined;
  if (tool === "jira_start_jmx_metrics" && !value) return undefined;
  return tool === "jira_stop_jmx_metrics" && value ? undefined : value;
}
/** An uncertain receipt retains the requested target and never asserts an observed setting. */
export function jiraMonitoringDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  if (!JIRA_MONITORING_WRITE_TOOLS.has(tool)) return [];
  const value = receiptState(tool, source);
  const labels: WidgetMessageKey[] = [familyLabel(tool), "chat.jira.monitoring.instanceScope"];
  labels.push(...(typeof value === "boolean" ? stateLabels(source, value) : ["chat.jira.monitoring.stateUnknown"] as const));
  return [{ facts: [], labels }];
}
