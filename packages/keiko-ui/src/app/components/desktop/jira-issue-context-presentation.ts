import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import { jiraCollaborationDetails } from "./jira-collaboration-presentation";
import { jiraRemoteLinkReviewDetails } from "./jira-link-mutation-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const JIRA_ISSUE_CONTEXT_TOOLS: ReadonlySet<string> = new Set([
  "jira_issue_picker",
  "jira_pinned_comments",
  "jira_subtasks",
  "jira_subtask_move_availability",
  "jira_remote_links",
  "jira_remote_link",
]);
export const JIRA_ISSUE_CONTEXT_METADATA_TOOLS: ReadonlySet<string> = new Set([
  "jira_subtask_move_availability",
  "jira_remote_links",
  "jira_remote_link",
]);
export interface JiraIssuePickerGroup {
  readonly details: JiraAgileDetails;
  readonly issues: readonly Source[];
}
function parentFacts(source: Source): JiraOutcomeFact[] {
  return [
    ...fact("chat.jira.properties.issueId", source.issueId),
    ...fact("chat.jira.fact.issue", source.issueKey),
  ];
}
function remoteLink(source: Source): JiraAgileDetails {
  const application = record(source.application);
  const title = text(source.title);
  const summary = text(source.summary);
  const labels: WidgetMessageKey[] = [
    "chat.jira.issueContext.linkObservation",
    triState(
      source.resolved,
      "chat.jira.issueContext.resolved",
      "chat.jira.issueContext.notResolved",
      "chat.jira.issueContext.resolvedUnknown",
    ),
  ];
  return {
    ...(title === undefined ? {} : { name: title }),
    ...(summary === undefined ? {} : { body: summary }),
    facts: [
      ...fact("chat.jira.fact.linkId", source.id),
      ...fact("chat.jira.issueContext.globalId", source.globalId),
      ...fact("chat.jira.issueContext.applicationName", application?.name),
      ...fact("chat.jira.issueContext.applicationType", application?.type),
      ...fact("chat.jira.issueContext.relationship", source.relationship),
    ],
    labels,
  };
}
function remoteLinks(source: Source): readonly JiraAgileDetails[] {
  const labels: WidgetMessageKey[] = ["chat.jira.issueContext.linkObservation"];
  const header: JiraAgileDetails = { facts: parentFacts(source), labels };
  if (typeof source.id === "string")
    return [
      ...(header.facts.length === 0 ? [] : [header]),
      remoteLink(source),
      ...jiraRemoteLinkReviewDetails(source),
    ];
  if (!Array.isArray(source.items)) {
    labels.push("chat.jira.issueContext.linksUnknown");
    return [header];
  }
  if (source.items.length === 0) labels.push("chat.jira.issueContext.linksEmpty");
  return [
    header,
    ...source.items.flatMap((value: unknown) => {
      const item = record(value);
      return item === undefined ? [] : [remoteLink(item), ...jiraRemoteLinkReviewDetails(item)];
    }),
  ];
}
function collectionHeader(tool: string, source: Source): JiraAgileDetails {
  const labels: WidgetMessageKey[] = [
    tool === "jira_subtasks"
      ? "chat.jira.issueContext.subtaskObservation"
      : "chat.jira.issueContext.pinObservation",
  ];
  if (!Array.isArray(source.items)) labels.push("chat.jira.issueContext.collectionUnknown");
  else if (source.items.length === 0) labels.push("chat.jira.issueContext.collectionEmpty");
  return { facts: parentFacts(source), labels };
}
/** Remote addresses in complete review snapshots remain plain metadata, never navigation targets. */
export function jiraIssueContextDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  if (!JIRA_ISSUE_CONTEXT_TOOLS.has(tool) || source.outcome === "failed") return [];
  if (tool === "jira_subtasks" || tool === "jira_pinned_comments")
    return [collectionHeader(tool, source)];
  if (tool === "jira_issue_picker") return [];
  if (tool !== "jira_subtask_move_availability") return remoteLinks(source);
  return [
    {
      facts: parentFacts(source),
      labels: [
        "chat.jira.issueContext.reorderScope",
        triState(
          source.canReorderSubtasks,
          "chat.jira.issueContext.reorderAllowed",
          "chat.jira.issueContext.reorderUnavailable",
          "chat.jira.issueContext.reorderUnknown",
        ),
      ],
    },
  ];
}
/** Reuse the existing comment identity/body/visibility renderer for native pin observations. */
export function jiraPinnedCommentDetails(source: Source): JiraAgileDetails {
  const author = record(source.author);
  const comment = jiraCollaborationDetails("jira_get_comment", {
    ...source,
    authorName: source.authorName ?? author?.name,
    authorDisplayName: source.authorDisplayName ?? author?.displayName,
  });
  return {
    ...comment,
    facts: [
      ...comment.facts,
      ...fact("chat.jira.issueContext.pinnedBy", source.pinnedBy),
      ...fact("chat.jira.issueContext.pinnedDate", source.pinnedDate),
    ],
    labels: ["chat.jira.issueContext.pinObservation"],
  };
}
function pickerSection(source: Source): JiraIssuePickerGroup {
  const labels: WidgetMessageKey[] = ["chat.jira.issueContext.suggestionsOnly"];
  const issues = Array.isArray(source.issues)
    ? source.issues.flatMap((value: unknown) => {
        const item = record(value);
        return item === undefined ? [] : [item];
      })
    : [];
  if (!Array.isArray(source.issues)) labels.push("chat.jira.issueContext.suggestionsUnknown");
  else if (source.issues.length === 0) labels.push("chat.jira.issueContext.suggestionsEmpty");
  return {
    details: {
      facts: [
        ...fact("chat.jira.issueContext.sectionId", source.id),
        ...fact("chat.jira.issueContext.sectionLabel", source.label),
      ],
      labels,
    },
    issues,
  };
}
/** Keep section context separate; actual issue cards reuse the ordinary trusted browse-link owner. */
export function jiraIssuePickerGroups(source: Source): readonly JiraIssuePickerGroup[] {
  if (source.outcome === "failed") return [];
  const labels: WidgetMessageKey[] = [
    "chat.jira.issueContext.suggestionsOnly",
    "chat.jira.issueContext.suggestionsScope",
  ];
  if (!Array.isArray(source.sections)) labels.push("chat.jira.issueContext.sectionsUnknown");
  else if (source.sections.length === 0) labels.push("chat.jira.issueContext.sectionsEmpty");
  const sections = Array.isArray(source.sections)
    ? source.sections.flatMap((value: unknown) => {
        const section = record(value);
        return section === undefined ? [] : [pickerSection(section)];
      })
    : [];
  return [{ details: { facts: [], labels }, issues: [] }, ...sections];
}

function triState<T extends string>(value: unknown, yes: T, no: T, unknown: T): T {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
