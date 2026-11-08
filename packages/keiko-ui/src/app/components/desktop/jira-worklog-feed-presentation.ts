import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationRecord as record,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_WORKLOG_FEED_TOOLS: ReadonlySet<string> = new Set([
  "jira_deleted_worklogs",
  "jira_updated_worklogs",
]);
function timestamp(value: unknown): string | undefined {
  return value === "0" ? value : identity(value);
}
function header(tool: string, data: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = [
    "chat.jira.worklogFeed.scope",
    "chat.jira.worklogFeed.latestMinute",
    "chat.jira.worklogFeed.timeUnit",
    tool === "jira_deleted_worklogs"
      ? "chat.jira.worklogFeed.deleted"
      : "chat.jira.worklogFeed.updated",
  ];
  labels.push(
    typeof data.isLastPage !== "boolean"
      ? "chat.jira.worklogFeed.pageUnknown"
      : data.isLastPage
        ? "chat.jira.worklogFeed.lastPage"
        : "chat.jira.worklogFeed.morePages",
  );
  if (data.isLastPage === false) {
    labels.push("chat.jira.worklogFeed.inclusiveCursor");
    if (timestamp(data.nextSince) === undefined) labels.push("chat.jira.worklogFeed.cursorUnknown");
  }
  if (!Array.isArray(data.items)) labels.push("chat.jira.worklogFeed.listUnknown");
  else if (data.items.length === 0) labels.push("chat.jira.worklogFeed.emptyWindow");
  return {
    facts: [
      ...fact("chat.jira.worklogFeed.since", timestamp(data.since)),
      ...fact("chat.jira.worklogFeed.until", timestamp(data.until)),
      ...(data.isLastPage === false
        ? fact("chat.jira.worklogFeed.nextSince", timestamp(data.nextSince))
        : []),
    ],
    labels,
  };
}
function change(value: unknown): JiraAgileDetails {
  const source = record(value);
  const worklogId = identity(source?.worklogId);
  const changedAt = timestamp(source?.changedAt);
  return {
    facts: [
      ...fact("chat.jira.fact.worklogId", worklogId),
      ...fact("chat.jira.worklogFeed.changedAt", changedAt),
    ],
    labels:
      worklogId === undefined || changedAt === undefined
        ? ["chat.jira.worklogFeed.changeUnknown"]
        : [],
  };
}
/** Native window observations are not issue totals, worklog contents or an all-history completion claim. */
export function jiraWorklogFeedDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_WORKLOG_FEED_TOOLS.has(tool) || data.outcome === "failed") return [];
  return [header(tool, data), ...(Array.isArray(data.items) ? data.items.map(change) : [])];
}
