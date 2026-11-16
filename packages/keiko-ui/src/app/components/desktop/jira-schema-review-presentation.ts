import type { JiraAgileDetails } from "./jira-agile-presentation";
import { jiraNullableReviewFacts } from "./jira-scheme-review-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationIdentity as id,
  jiraPresentationNativeText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

const FIELDS = new Set(["id", "name", "description", "subtask", "avatarId"]);
function consistent(source: Source, snapshot: Source): boolean {
  return ["name", "description", "subtask", "avatarId"].every(
    (key) => source[key] === undefined || source[key] === snapshot[key],
  );
}
function metadata(snapshot: Source): boolean {
  if (!text(snapshot.name, 255) || typeof snapshot.subtask !== "boolean") return false;
  if (!(
    snapshot.description === null ||
    text(snapshot.description, 32768, { empty: true, multiline: true })
  ))
    return false;
  return snapshot.avatarId === undefined || id(snapshot.avatarId) !== undefined;
}
function snapshotFor(source: Source): Source | undefined {
  const snapshot = record(source.reviewSnapshot);
  if (snapshot === undefined || id(snapshot.id) === undefined || snapshot.id !== source.id)
    return undefined;
  return metadata(snapshot) &&
    Object.keys(snapshot).every((key) => FIELDS.has(key)) &&
    consistent(source, snapshot)
    ? snapshot
    : undefined;
}
/** Missing native facts remain unavailable; an observed null or empty description stays explicit. */
export function jiraIssueTypeReviewDetails(source: Source): JiraAgileDetails {
  const snapshot = snapshotFor(source);
  if (snapshot === undefined)
    return { facts: [], labels: ["chat.jira.systemAction.reviewUnavailable"] };
  const description = jiraNullableReviewFacts(
    "chat.jira.structural.nativeDescription",
    snapshot.description,
  );
  return {
    facts: [
      ...fact("chat.jira.fact.issueTypeId", snapshot.id),
      ...fact("chat.jira.fact.avatarId", snapshot.avatarId),
      { label: "chat.jira.systemAction.subtask", value: String(snapshot.subtask) },
      ...description.facts,
    ],
    labels: ["chat.jira.systemAction.reviewAvailable", ...description.labels],
  };
}
