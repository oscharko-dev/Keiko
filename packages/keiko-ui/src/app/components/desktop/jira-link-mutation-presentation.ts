import {
  isSafeAtlassianIdentifier,
  JIRA_LINK_MUTATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  jiraPresentationMutationLabels as mutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_LINK_MUTATION_TOOLS: ReadonlySet<string> = new Set(
  JIRA_LINK_MUTATIONS.map((operation) => operation.replace(/[.-]/gu, "_")),
);
const ISSUE_LINKS = new Set(["jira_create_issue_link", "jira_delete_issue_link"]);
const DELETIONS = new Set([
  "jira_delete_issue_link",
  "jira_delete_remote_link",
  "jira_delete_remote_link_by_global_id",
]);
export const JIRA_REMOTE_SNAPSHOT_LABELS = {
  id: "chat.jira.fact.linkId",
  globalId: "chat.jira.issueContext.globalId",
  applicationType: "chat.jira.issueContext.applicationType",
  applicationName: "chat.jira.issueContext.applicationName",
  relationship: "chat.jira.issueContext.relationship",
  url: "chat.jira.linkMutation.url",
  title: "chat.jira.linkMutation.title",
  summary: "chat.jira.linkMutation.summary",
  iconUrl: "chat.jira.linkMutation.iconUrl",
  iconTitle: "chat.jira.linkMutation.iconTitle",
  resolved: "chat.jira.linkMutation.resolved",
  statusIconUrl: "chat.jira.linkMutation.statusIconUrl",
  statusIconTitle: "chat.jira.linkMutation.statusIconTitle",
  statusIconLink: "chat.jira.linkMutation.statusIconLink",
} as const satisfies Readonly<Record<string, WidgetMessageKey>>;
function linkedIssueComplete(source: Source): boolean {
  return (
    identity(source.linkedIssueId) !== undefined &&
    source.linkedIssueId !== source.issueId &&
    isSafeAtlassianIdentifier(source.linkedIssueKey) &&
    source.linkedIssueKey !== source.issueKey &&
    identity(source.linkTypeId) !== undefined
  );
}
export function jiraLinkMutationIdentityComplete(tool: string, source: Source): boolean {
  if (!JIRA_LINK_MUTATION_TOOLS.has(tool)) return false;
  return (
    identity(source.issueId) !== undefined &&
    isSafeAtlassianIdentifier(source.issueKey) &&
    text(source.userKey) !== undefined &&
    identity(source.linkId) !== undefined &&
    source.linkPresent === !DELETIONS.has(tool) &&
    (!ISSUE_LINKS.has(tool) || linkedIssueComplete(source))
  );
}
/** linkPresent is the approved target on uncertain receipts, not evidence of current membership. */
export function jiraLinkMutationDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  if (!JIRA_LINK_MUTATION_TOOLS.has(tool)) return [];
  const labels = mutationLabels(source, jiraLinkMutationIdentityComplete(tool, source));
  labels.push(
    "chat.jira.linkMutation.knownTargets",
    DELETIONS.has(tool)
      ? "chat.jira.linkMutation.requestedAbsent"
      : "chat.jira.linkMutation.requestedPresent",
  );
  return [
    {
      facts: [
        ...fact("chat.jira.properties.issueId", identity(source.issueId)),
        ...fact("chat.jira.fact.issue", source.issueKey),
        ...fact("chat.jira.fact.userKey", source.userKey),
        ...fact("chat.jira.fact.linkId", identity(source.linkId)),
        ...fact("chat.jira.fact.linkTypeId", identity(source.linkTypeId)),
        ...fact("chat.jira.linkMutation.linkedIssueId", identity(source.linkedIssueId)),
        ...fact("chat.jira.fact.outwardIssue", source.linkedIssueKey),
      ],
      labels,
    },
  ];
}
function snapshotField(field: string, value: unknown): boolean {
  if (field === "id") return identity(value) !== undefined;
  if (field === "url" || field === "title") return text(value) !== undefined;
  if (field === "resolved") return value === null || typeof value === "boolean";
  return value === null || typeof value === "string";
}
function completeSnapshot(source: Source): Source | undefined {
  const value = record(source.reviewSnapshot);
  if (source.reviewSnapshotAvailable !== true || value === undefined || value.id !== source.id)
    return undefined;
  const fields = Object.keys(JIRA_REMOTE_SNAPSHOT_LABELS);
  return Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field) && snapshotField(field, value[field]))
    ? value
    : undefined;
}
function snapshotDetail(label: WidgetMessageKey, value: unknown): JiraAgileDetails {
  if (value === null)
    return { facts: [], labels: [label, "chat.jira.structural.nativeNotProvided"] };
  if (typeof value === "boolean")
    return {
      facts: [],
      labels: [
        label,
        value ? "chat.jira.propertyMutation.true" : "chat.jira.propertyMutation.false",
      ],
    };
  if (value === "") return { facts: [], labels: [label, "chat.jira.propertyMutation.emptyText"] };
  return { facts: typeof value === "string" ? [{ label, value }] : [], labels: [] };
}
/** Show the complete server-projected replacement snapshot as text; never navigate to its URLs. */
export function jiraRemoteLinkReviewDetails(source: Source): readonly JiraAgileDetails[] {
  const snapshot = completeSnapshot(source);
  if (snapshot === undefined)
    return [{ facts: [], labels: ["chat.jira.linkMutation.snapshotUnavailable"] }];
  return [
    {
      facts: [],
      labels: ["chat.jira.linkMutation.snapshotAvailable", "chat.jira.linkMutation.urlsMetadata"],
    },
    ...Object.entries(JIRA_REMOTE_SNAPSHOT_LABELS).map(([field, label]) =>
      snapshotDetail(label, snapshot[field]),
    ),
  ];
}
