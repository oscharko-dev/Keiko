import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";

const WATCHING = new Set(["jira_watchers", "jira_watch", "jira_unwatch"]);
export const JIRA_PARTICIPATION_TOOLS: ReadonlySet<string> = new Set([
  ...WATCHING,
  "jira_votes",
  "jira_vote",
  "jira_unvote",
]);
function stateLabel(watching: boolean, state: unknown): WidgetMessageKey {
  if (watching)
    return triState(
      state,
      "chat.jira.participation.watching",
      "chat.jira.participation.notWatching",
      "chat.jira.participation.watchingUnknown",
    );
  return triState(
    state,
    "chat.jira.participation.voted",
    "chat.jira.participation.notVoted",
    "chat.jira.participation.voteUnknown",
  );
}
function countFact(label: WidgetMessageKey, value: unknown): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? [{ label, value: String(value) }]
    : [];
}
/** Native counts and the current account's observed state are separate from a visible member list. */
export function jiraParticipationDetails(
  tool: string,
  source: Readonly<Record<string, unknown>>,
): JiraAgileDetails {
  if (!JIRA_PARTICIPATION_TOOLS.has(tool) || typeof source.issueKey !== "string")
    return { facts: [], labels: [] };
  const watching = WATCHING.has(tool);
  const count = watching ? source.watchCount : source.votes;
  const observed =
    tool === "jira_watchers" || tool === "jira_votes" || source.outcome === "succeeded";
  const nativeState = watching ? source.isWatching : source.hasVoted;
  const labels = [stateLabel(watching, observed ? nativeState : undefined)];
  if (source.listComplete === false) labels.push("chat.jira.participation.membersPartial");
  return {
    facts: countFact(watching ? "chat.jira.fact.watchCount" : "chat.jira.fact.voteCount", count),
    labels,
  };
}

function triState<T extends string>(value: unknown, yes: T, no: T, unknown: T): T {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
