import { JIRA_SPRINT_LIFECYCLE_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationIdentity as identity,
  jiraPresentationText as text,
  jiraPresentationMutationLabels as mutationLabels,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_SPRINT_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set(
  JIRA_SPRINT_LIFECYCLE_MUTATIONS.map((name) => name.replace(/[.-]/gu, "_")),
);
export const JIRA_SPRINT_SNAPSHOT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  id: "chat.jira.fact.sprintId",
  originBoardId: "chat.jira.sprintLifecycle.originBoard",
  name: "chat.jira.fact.sprintName",
  state: "chat.jira.fact.sprintState",
  startDate: "chat.jira.fact.startDate",
  endDate: "chat.jira.fact.endDate",
  goal: "chat.jira.fact.sprintGoal",
  autoStartStop: "chat.jira.sprintLifecycle.autoStartStop",
  incompleteIssuesDestinationId: "chat.jira.sprintLifecycle.incompleteDestination",
  synced: "chat.jira.sprintLifecycle.synced",
  activatedDate: "chat.jira.fact.activatedDate",
  completeDate: "chat.jira.fact.completeDate",
};
export function jiraSprintLifecycleConfirmationUnavailable(tool: string): boolean {
  return (
    tool === "jira_delete_sprint" ||
    tool === "jira_swap_sprints" ||
    tool === "jira_unmap_all_sprints"
  );
}
function nativeId(value: unknown): string | undefined {
  const id = identity(value);
  return id !== undefined && Number.isSafeInteger(Number(id)) ? id : undefined;
}
function selectedIds(source: Source): readonly string[] | undefined {
  const ids = source.sprintIds;
  return Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 50 &&
    ids.every((id: unknown): id is string => nativeId(id) !== undefined) &&
    new Set(ids).size === ids.length
    ? ids
    : undefined;
}
function unmappedIdentity(tool: string, source: Source): boolean {
  return (
    selectedIds(source) !== undefined &&
    source.sprintSynced === false &&
    (tool === "jira_unmap_all_sprints"
      ? source.allSprints === true
      : !Object.hasOwn(source, "allSprints"))
  );
}
export function jiraSprintLifecycleIdentityComplete(tool: string, source: Source): boolean {
  if (!JIRA_SPRINT_LIFECYCLE_TOOLS.has(tool) || text(source.userKey) === undefined) return false;
  if (tool === "jira_unmap_sprints" || tool === "jira_unmap_all_sprints")
    return unmappedIdentity(tool, source);
  if (nativeId(source.sprintId) === undefined || nativeId(source.originBoardId) === undefined)
    return false;
  if (tool === "jira_swap_sprints")
    return nativeId(source.swapSprintId) !== undefined && source.swapSprintId !== source.sprintId;
  return source.sprintPresent === (tool === "jira_replace_sprint");
}
function labelsOf(tool: string, source: Source): WidgetMessageKey[] {
  if (!jiraSprintLifecycleIdentityComplete(tool, source))
    return ["chat.jira.savedConfiguration.identityUnknown"];
  return jiraSprintLifecycleConfirmationUnavailable(tool)
    ? ["chat.jira.savedConfiguration.unconfirmed"]
    : mutationLabels(source, true);
}
const LIMITS: Readonly<Record<string, WidgetMessageKey>> = {
  jira_replace_sprint: "chat.jira.sprintLifecycle.replacementLimit",
  jira_delete_sprint: "chat.jira.sprintLifecycle.deleteUnconfirmed",
  jira_swap_sprints: "chat.jira.sprintLifecycle.swapUnconfirmed",
  jira_unmap_sprints: "chat.jira.sprintLifecycle.selectedOnly",
  jira_unmap_all_sprints: "chat.jira.sprintLifecycle.instanceWide",
};
export function jiraSprintLifecycleDetails(
  tool: string,
  source: Source,
): readonly JiraAgileDetails[] {
  if (!JIRA_SPRINT_LIFECYCLE_TOOLS.has(tool)) return [];
  const ids = selectedIds(source);
  const sample = tool === "jira_unmap_all_sprints";
  const labels = labelsOf(tool, source);
  const limit = LIMITS[tool];
  if (limit !== undefined) labels.push(limit);
  if (typeof source.sprintSynced === "boolean")
    labels.push("chat.jira.sprintLifecycle.requestedUnsynced");
  return [
    {
      facts: [
        ...fact("chat.jira.fact.userKey", source.userKey),
        ...fact("chat.jira.fact.sprintId", nativeId(source.sprintId)),
        ...fact("chat.jira.sprintLifecycle.originBoard", nativeId(source.originBoardId)),
        ...fact("chat.jira.sprintLifecycle.swapSprint", nativeId(source.swapSprintId)),
        ...fact(
          sample ? "chat.jira.sprintLifecycle.sampleIds" : "chat.jira.sprintLifecycle.selectedIds",
          ids?.join(", "),
        ),
      ],
      labels,
    },
  ];
}
