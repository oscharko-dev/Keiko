import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraCollaborationDetails } from "./jira-collaboration-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationStringList as stringList,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_SELECTED_WORKLOG_TOOLS: ReadonlySet<string> = new Set(["jira_worklogs_by_id"]);
function count(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? [{ label, value: String(value) }] : [];
}
function header(data: Source): JiraAgileDetails {
  const requested = count("chat.jira.selectedWorklogs.requestedCount", data.requestedCount);
  const returned = count("chat.jira.selectedWorklogs.returnedCount", data.returnedCount);
  const missing = stringList(data.unreturnedWorklogIds, "chat.jira.selectedWorklogs.unreturnedIds", "chat.jira.selectedWorklogs.unreturnedCount");
  const labels: WidgetMessageKey[] = ["chat.jira.selectedWorklogs.scope", "chat.jira.selectedWorklogs.unreturnedMeaning"];
  if (requested.length === 0) labels.push("chat.jira.selectedWorklogs.requestedUnknown");
  if (returned.length === 0) labels.push("chat.jira.selectedWorklogs.returnedUnknown");
  if (missing === undefined) labels.push("chat.jira.selectedWorklogs.unreturnedUnknown");
  if (!Array.isArray(data.items)) labels.push("chat.jira.selectedWorklogs.itemsUnknown");
  return { facts: [...requested, ...returned, ...(missing ?? [])], labels };
}
/** A selected native POST read is not a complete worklog inventory or an absence proof. */
export function jiraSelectedWorklogDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_SELECTED_WORKLOG_TOOLS.has(tool) || data.outcome === "failed") return [];
  const items = Array.isArray(data.items) ? data.items.flatMap((value: unknown) => {
    const source = record(value);
    if (source === undefined) return [];
    const details = jiraCollaborationDetails("jira_worklogs", source);
    return [{ ...details, facts: [...fact("chat.jira.fact.issue", source.issueKey), ...details.facts] }];
  }) : [];
  return [header(data), ...items];
}
