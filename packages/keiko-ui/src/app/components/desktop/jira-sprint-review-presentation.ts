import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraAgileDetails, type JiraAgileDetails } from "./jira-agile-presentation";
import { JIRA_SPRINT_SNAPSHOT_LABELS } from "./jira-sprint-lifecycle-presentation";
import {
  jiraPresentationRecord as record,
  jiraPresentationIdentity as identity,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_SPRINT_REVIEW_TOOLS: ReadonlySet<string> = new Set(["jira_sprint"]);
const STATES: ReadonlySet<unknown> = new Set(["future", "active", "closed"]);
function nativeId(value: unknown): boolean {
  return identity(value) !== undefined && Number.isSafeInteger(Number(value));
}
function optionalFact(key: string, value: unknown): boolean {
  if (key === "synced" || key === "autoStartStop") return typeof value === "boolean";
  if (key === "incompleteIssuesDestinationId") return value === null || nativeId(value);
  return value === null || typeof value === "string";
}
function sameCore(snapshot: Source, source: Source): boolean {
  return (
    snapshot.id === source.id &&
    snapshot.name === source.name &&
    snapshot.state === source.state &&
    (source.originBoardId === undefined || source.originBoardId === snapshot.originBoardId)
  );
}
function validCore(snapshot: Source): boolean {
  return (
    nativeId(snapshot.id) &&
    nativeId(snapshot.originBoardId) &&
    text(snapshot.name) !== undefined &&
    STATES.has(snapshot.state)
  );
}
function reviewSnapshot(source: Source): Source | undefined {
  const snapshot = record(source.reviewSnapshot);
  if (snapshot === undefined || !sameCore(snapshot, source) || !validCore(snapshot))
    return undefined;
  const core = new Set(["id", "originBoardId", "name", "state"]);
  return Object.entries(snapshot).every(
    ([key, value]) =>
      Object.hasOwn(JIRA_SPRINT_SNAPSHOT_LABELS, key) &&
      (core.has(key) || optionalFact(key, value)),
  )
    ? snapshot
    : undefined;
}
function factDetail(label: WidgetMessageKey, value: unknown): JiraAgileDetails {
  if (value === undefined)
    return { facts: [], labels: [label, "chat.jira.sprintLifecycle.metadataOmitted"] };
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
function sprintDetails(source: Source): readonly JiraAgileDetails[] {
  const name = text(source.name);
  const base = {
    ...jiraAgileDetails("jira_sprint", source),
    ...(name === undefined ? {} : { name }),
  };
  const snapshot = reviewSnapshot(source);
  if (snapshot === undefined)
    return [base, { facts: [], labels: ["chat.jira.sprintLifecycle.snapshotUnavailable"] }];
  return [
    base,
    { facts: [], labels: ["chat.jira.sprintLifecycle.snapshotAvailable"] },
    ...Object.entries(JIRA_SPRINT_SNAPSHOT_LABELS).map(([key, label]) =>
      factDetail(label, snapshot[key]),
    ),
  ];
}
/** Retain the saved native snapshot and its missing fields; never re-fetch or infer hidden issues. */
export function jiraSprintReviewDetails(tool: string, source: Source): readonly JiraAgileDetails[] {
  if (!JIRA_SPRINT_REVIEW_TOOLS.has(tool)) return [];
  const items = sprintItems(source);
  return items.flatMap((item: unknown) => {
    const value = record(item);
    return value === undefined ? [] : sprintDetails(value);
  });
}
function sprintItems(source: Source): readonly unknown[] {
  if (Array.isArray(source.items)) return source.items;
  return source.id === undefined ? [] : [source];
}
