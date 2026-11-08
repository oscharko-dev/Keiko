import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationStringList as stringList,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_JOB_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "jira_reindex_status", "jira_reindex_progress", "jira_reindex_request", "jira_reindex_requests",
  "jira_upgrade_result", "jira_index_snapshots", "jira_app_monitoring", "jira_ipd_monitoring", "jira_jmx_metrics",
]);
const DATES: Readonly<Record<string, WidgetMessageKey>> = {
  submittedTime: "chat.jira.jobs.submittedTime", requestTime: "chat.jira.jobs.requestTime",
  startTime: "chat.jira.jobs.startTime", finishTime: "chat.jira.jobs.finishTime",
  completionTime: "chat.jira.jobs.completionTime",
};
function integerFact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? [{ label, value: String(value) }] : [];
}
function dateFacts(source: Source): JiraOutcomeFact[] {
  return Object.entries(DATES).flatMap(([field, label]) => fact(label, source[field]));
}
function progress(source: Source): JiraAgileDetails {
  const value = integerFact("chat.jira.jobs.nativeProgress", source.currentProgress);
  const labels: WidgetMessageKey[] = ["chat.jira.jobs.observation", source.taskSelection === "selected-task"
    ? "chat.jira.jobs.selectedTask" : source.taskSelection === "active-or-latest"
      ? "chat.jira.jobs.activeOrLatest" : "chat.jira.jobs.taskSelectionUnknown"];
  if (value.length === 0) labels.push("chat.jira.jobs.progressUnknown");
  labels.push(source.success === true ? "chat.jira.jobs.successTrue" : source.success === false
    ? "chat.jira.jobs.successFalse" : "chat.jira.jobs.successUnknown");
  return {
    facts: [...fact("chat.jira.jobs.selectedTaskId", source.selectedTaskId), ...value,
      ...fact("chat.jira.jobs.subtask", source.currentSubTask), ...fact("chat.jira.jobs.type", source.type),
      ...dateFacts(source)],
    labels,
  };
}
function reindexStatus(source: Source): JiraAgileDetails {
  if (source.taskSelection === "active-or-latest" && source.taskState === "no-prior-task") {
    return { facts: [], labels: ["chat.jira.jobs.observation", "chat.jira.jobs.activeOrLatest", "chat.jira.jobs.noPriorTask"] };
  }
  return progress(source);
}
function request(source: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = ["chat.jira.jobs.observation"];
  if (text(source.status) === undefined) labels.push("chat.jira.jobs.statusUnknown");
  return {
    facts: [...fact("chat.jira.jobs.requestId", source.id), ...fact("chat.jira.jobs.status", source.status),
      ...fact("chat.jira.jobs.type", source.type), ...dateFacts(source)],
    labels,
  };
}
function listHeader(data: Source): JiraAgileDetails {
  const facts = integerFact("chat.jira.jobs.returnedTotal", data.total);
  const labels: WidgetMessageKey[] = ["chat.jira.jobs.observation"];
  if (facts.length === 0) labels.push("chat.jira.jobs.totalUnknown");
  return { facts, labels };
}
function requests(data: Source): readonly JiraAgileDetails[] {
  const header = listHeader(data);
  const selected = stringList(data.requestedRequestIds, "chat.jira.jobs.selectedIds", "chat.jira.jobs.selectedCount");
  const unreturned = stringList(data.unreturnedRequestIds, "chat.jira.jobs.unreturnedIds", "chat.jira.jobs.unreturnedCount");
  const scope: JiraAgileDetails = {
    facts: [...(selected ?? []), ...(unreturned ?? [])], labels: ["chat.jira.jobs.selectedScope", "chat.jira.jobs.unreturnedMeaning"],
  };
  const items = Array.isArray(data.items) ? data.items.flatMap((value: unknown) => {
    const source = record(value);
    return source === undefined ? [] : [request(source)];
  }) : [];
  return [header, scope, ...items];
}
function upgrade(data: Source): JiraAgileDetails {
  if (data.upgradeState === "running") return { facts: [], labels: ["chat.jira.jobs.observation", "chat.jira.jobs.upgradeRunning"] };
  if (data.upgradeState === "no-prior-result") return { facts: [], labels: ["chat.jira.jobs.observation", "chat.jira.jobs.noPriorUpgrade"] };
  const duration = integerFact("chat.jira.jobs.nativeDuration", data.duration);
  const labels: WidgetMessageKey[] = ["chat.jira.jobs.observation", "chat.jira.jobs.durationUnitsUnknown"];
  if (duration.length === 0) labels.push("chat.jira.jobs.durationUnknown");
  if (text(data.upgradeOutcome) === undefined) labels.push("chat.jira.jobs.upgradeOutcomeUnknown");
  const message = text(data.message);
  return {
    ...(message === undefined ? {} : { body: message }),
    facts: [...fact("chat.jira.jobs.upgradeOutcome", data.upgradeOutcome), ...duration, ...dateFacts(data)], labels,
  };
}
function snapshots(data: Source): readonly JiraAgileDetails[] {
  const header = listHeader(data);
  const items = Array.isArray(data.items) ? data.items.flatMap((value: unknown) => {
    const source = record(value);
    if (source === undefined || text(source.absolutePath) === undefined) return [];
    const timestamp = integerFact("chat.jira.jobs.snapshotTimestamp", source.timestamp);
    return [{
      facts: [...fact("chat.jira.jobs.remoteSnapshotPath", source.absolutePath), ...timestamp],
      labels: ["chat.jira.jobs.remotePathOnly", ...(timestamp.length === 0 ? ["chat.jira.jobs.snapshotTimeUnknown"] as const : [])],
    } satisfies JiraAgileDetails];
  }) : [];
  return [header, ...items];
}
function monitoring(tool: string, data: Source): JiraAgileDetails {
  return { facts: [], labels: ["chat.jira.jobs.observation", tool === "jira_app_monitoring"
    ? "chat.jira.jobs.appMonitoring" : "chat.jira.jobs.ipdMonitoring", data.enabled === true
      ? "chat.jira.jobs.monitoringEnabled" : data.enabled === false
        ? "chat.jira.jobs.monitoringDisabled" : "chat.jira.jobs.monitoringUnknown"] };
}
function metrics(data: Source): JiraAgileDetails {
  const body = text(data.metricsText);
  const labels: WidgetMessageKey[] = ["chat.jira.jobs.observation", "chat.jira.jobs.metricDescriptionOnly"];
  if (body === undefined) labels.push(data.metricsText === "" ? "chat.jira.jobs.metricsEmpty" : "chat.jira.jobs.metricsUnknown");
  return { ...(body === undefined ? {} : { body }), facts: [], labels };
}

/** Render observations in the existing result-card vocabulary without deriving health or job success. */
export function jiraJobObservationDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_JOB_OBSERVATION_TOOLS.has(tool) || data.outcome === "failed") return [];
  switch (tool) {
    case "jira_reindex_status": return [reindexStatus(data)];
    case "jira_reindex_progress": return [progress(data)];
    case "jira_reindex_request": return [request(data)];
    case "jira_reindex_requests": return requests(data);
    case "jira_upgrade_result": return [upgrade(data)];
    case "jira_index_snapshots": return snapshots(data);
    case "jira_app_monitoring": case "jira_ipd_monitoring": return [monitoring(tool, data)];
    case "jira_jmx_metrics": return [metrics(data)];
    default: return [];
  }
}
