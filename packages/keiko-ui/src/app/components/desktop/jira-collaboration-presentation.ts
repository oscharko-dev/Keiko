import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

type Source = Readonly<Record<string, unknown>>;
const COMMENTS = new Set(["jira_get_comment", "jira_update_comment"]);
const WORKLOGS = new Set(["jira_worklogs", "jira_worklog"]);
const LINKS = new Set(["jira_link_types", "jira_issue_link"]);
export const JIRA_COLLABORATION_TOOLS: ReadonlySet<string> = new Set([
  ...COMMENTS,
  ...WORKLOGS,
  ...LINKS,
]);
const TEXT_FACTS: Readonly<Record<string, WidgetMessageKey>> = {
  created: "chat.jira.fact.created",
  updated: "chat.jira.fact.updated",
  started: "chat.jira.fact.workStarted",
  inward: "chat.jira.fact.linkInward",
  outward: "chat.jira.fact.linkOutward",
  inwardIssueKey: "chat.jira.fact.inwardIssue",
  outwardIssueKey: "chat.jira.fact.outwardIssue",
};
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function identity(tool: string, source: Source): JiraOutcomeFact[] {
  const value = text(source.commentId ?? source.id);
  if (
    value === undefined ||
    !/^[1-9]\d{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return [];
  const label = COMMENTS.has(tool)
    ? "chat.jira.fact.commentId"
    : WORKLOGS.has(tool)
      ? "chat.jira.fact.worklogId"
      : tool === "jira_link_types"
        ? "chat.jira.fact.linkTypeId"
        : "chat.jira.fact.linkId";
  return [{ label, value }];
}
function visibilityFacts(source: Source): JiraOutcomeFact[] {
  const visibility = source.visibility;
  if (visibility === null || typeof visibility !== "object" || Array.isArray(visibility)) return [];
  const raw = Object.fromEntries(Object.entries(visibility));
  const value = text(raw.value);
  if (value === undefined || (raw.type !== "group" && raw.type !== "role")) return [];
  return [
    {
      label:
        raw.type === "group" ? "chat.jira.fact.visibleToGroup" : "chat.jira.fact.visibleToRole",
      value,
    },
  ];
}
function effortFacts(tool: string, source: Source): JiraOutcomeFact[] {
  const effort = source.timeSpentSeconds;
  return WORKLOGS.has(tool) &&
    typeof effort === "number" &&
    Number.isSafeInteger(effort) &&
    effort >= 0
    ? [{ label: "chat.jira.fact.timeSpentSeconds", value: String(effort) }]
    : [];
}
/** Saved native facts only; missing effort and visibility never imply zero or public access. */
export function jiraCollaborationDetails(tool: string, source: Source): JiraAgileDetails {
  if (!JIRA_COLLABORATION_TOOLS.has(tool)) return { facts: [], labels: [] };
  const body = text(
    COMMENTS.has(tool) ? source.body : WORKLOGS.has(tool) ? source.comment : undefined,
  );
  const name = text(source.authorDisplayName) ?? text(source.authorName);
  const facts = [
    ...identity(tool, source),
    ...Object.entries(TEXT_FACTS).flatMap(([key, label]) => {
      const value = text(source[key]);
      return value === undefined ? [] : [{ label, value }];
    }),
    ...(COMMENTS.has(tool) ? visibilityFacts(source) : []),
  ];
  return {
    ...(body === undefined ? {} : { body }),
    ...(name === undefined ? {} : { name }),
    facts: [...facts, ...effortFacts(tool, source)],
    labels: [],
  };
}
