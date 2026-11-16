import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails } from "./jira-agile-presentation";
import { jiraVersionSummaryDetails } from "./jira-project-metadata-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_AGILE_CONTEXT_METADATA_TOOLS: ReadonlySet<string> = new Set([
  "jira_board_projects",
  "jira_board_versions",
  "jira_board_refined_velocity",
  "jira_issue_estimation",
]);
export const JIRA_AGILE_CONTEXT_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_AGILE_CONTEXT_METADATA_TOOLS,
  "jira_board_epicless_issues",
  "jira_board_epic_issues",
  "jira_board_sprint_issues",
  "jira_epicless_issues",
  "jira_agile_issue",
]);
const SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  "visible-board-issues": "chat.jira.agileContext.visibleBoardIssues",
  "visible-epicless-issues": "chat.jira.agileContext.visibleEpiclessIssues",
  "visible-board-projects": "chat.jira.agileContext.visibleBoardProjects",
  "visible-board-versions": "chat.jira.agileContext.visibleBoardVersions",
};
function context(data: Source): JiraAgileDetails | undefined {
  const scope =
    typeof data.collectionScope === "string" && Object.hasOwn(SCOPES, data.collectionScope)
      ? SCOPES[data.collectionScope]
      : undefined;
  if (scope === undefined) return undefined;
  return {
    facts: [
      ...fact("chat.jira.fact.boardId", data.boardId),
      ...fact("chat.jira.agileContext.epicId", data.epicId),
      ...fact("chat.jira.fact.sprintId", data.sprintId),
    ],
    labels: [scope, "chat.jira.agileContext.visibleOnly"],
  };
}
function project(source: Source): JiraAgileDetails | undefined {
  const name = text(source.name);
  if (name === undefined || text(source.id) === undefined || text(source.key) === undefined)
    return undefined;
  const body = text(source.description);
  return {
    name,
    ...(body === undefined ? {} : { body }),
    facts: [
      ...fact("chat.jira.fact.projectId", source.id),
      ...fact("chat.jira.fact.projectKey", source.key),
    ],
    labels: [
      triStateLabel(
        source.archived,
        "chat.jira.metadata.archived",
        "chat.jira.metadata.notArchived",
        "chat.jira.metadata.archiveUnknown",
      ),
    ],
  };
}
function estimateText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : undefined;
}
function estimation(data: Source): JiraAgileDetails | undefined {
  if (text(data.fieldId) === undefined) return undefined;
  const value = estimateText(data.value);
  const labels: WidgetMessageKey[] = ["chat.jira.agileContext.estimateUnitUnknown"];
  if (value === undefined) labels.push("chat.jira.agileContext.estimateUnknown");
  else if (value.trim().length === 0) labels.push("chat.jira.agileContext.estimateBlank");
  return {
    facts: [
      ...fact("chat.jira.fact.boardId", data.boardId),
      ...fact("chat.jira.fact.issue", data.issueKey),
      ...fact("chat.jira.agileContext.issueId", data.issueId),
      ...fact("chat.jira.access.fieldId", data.fieldId),
      ...fact("chat.jira.agileContext.estimate", value),
    ],
    labels,
  };
}
function refinedVelocity(data: Source): JiraAgileDetails | undefined {
  if (text(data.boardId) === undefined) return undefined;
  return {
    facts: fact("chat.jira.fact.boardId", data.boardId),
    labels: [
      triStateLabel(
        data.value,
        "chat.jira.agileContext.refinedEnabled",
        "chat.jira.agileContext.refinedDisabled",
        "chat.jira.agileContext.refinedUnknown",
      ),
    ],
  };
}
function triStateLabel(
  value: unknown,
  yes: WidgetMessageKey,
  no: WidgetMessageKey,
  unknown: WidgetMessageKey,
): WidgetMessageKey {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}
function boardItem(tool: string, source: Source): JiraAgileDetails | undefined {
  return tool === "jira_board_projects" ? project(source) : jiraVersionSummaryDetails(source);
}
function boardItems(tool: string, data: Source): JiraAgileDetails[] {
  if (tool !== "jira_board_projects" && tool !== "jira_board_versions") return [];
  return (Array.isArray(data.items) ? data.items : [data]).flatMap((value: unknown) => {
    const source = record(value);
    const item = source === undefined ? undefined : boardItem(tool, source);
    return item === undefined ? [] : [item];
  });
}
/** Visible native populations and raw estimate values are observations, never board-wide completeness or units. */
export function jiraAgileContextDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_AGILE_CONTEXT_TOOLS.has(tool)) return [];
  if (tool === "jira_issue_estimation" || tool === "jira_board_refined_velocity") {
    const item = tool === "jira_issue_estimation" ? estimation(data) : refinedVelocity(data);
    return item === undefined ? [] : [item];
  }
  const head = context(data);
  const items = boardItems(tool, data);
  return [...(head === undefined ? [] : [head]), ...items];
}
