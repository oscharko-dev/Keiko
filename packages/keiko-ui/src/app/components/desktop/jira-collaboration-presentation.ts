import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

type Source = Readonly<Record<string, unknown>>;
const COMMENTS = new Set(["jira_get_comment", "jira_update_comment", "jira_delete_comment"]);
const WORKLOGS = new Set([
  "jira_worklogs",
  "jira_worklog",
  "jira_create_worklog",
  "jira_update_worklog",
  "jira_delete_worklog",
]);
const ATTACHMENTS = new Set(["jira_delete_attachment"]);
const LINKS = new Set(["jira_link_types", "jira_issue_link"]);
export const JIRA_COLLABORATION_TOOLS: ReadonlySet<string> = new Set([
  ...COMMENTS,
  ...WORKLOGS,
  ...ATTACHMENTS,
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
function identityValue(tool: string, source: Source): unknown {
  if (COMMENTS.has(tool)) return tool === "jira_get_comment" ? source.id : source.commentId;
  if (WORKLOGS.has(tool))
    return tool === "jira_worklog" || tool === "jira_worklogs" ? source.id : source.worklogId;
  return ATTACHMENTS.has(tool) ? source.attachmentId : source.id;
}
function identityLabel(tool: string): WidgetMessageKey {
  if (COMMENTS.has(tool)) return "chat.jira.fact.commentId";
  if (WORKLOGS.has(tool)) return "chat.jira.fact.worklogId";
  if (ATTACHMENTS.has(tool)) return "chat.jira.fact.attachmentId";
  return tool === "jira_link_types" ? "chat.jira.fact.linkTypeId" : "chat.jira.fact.linkId";
}
function identity(tool: string, source: Source): JiraOutcomeFact[] {
  const value = text(identityValue(tool, source));
  if (
    value === undefined ||
    !/^[1-9]\d{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return [];
  return [{ label: identityLabel(tool), value }];
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
    ...(COMMENTS.has(tool) || WORKLOGS.has(tool) ? visibilityFacts(source) : []),
  ];
  return {
    ...(body === undefined ? {} : { body }),
    ...(name === undefined ? {} : { name }),
    facts: [...facts, ...effortFacts(tool, source)],
    labels: [],
  };
}
