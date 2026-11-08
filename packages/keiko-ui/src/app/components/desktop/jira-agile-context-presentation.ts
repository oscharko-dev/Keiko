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
      source.archived === true
        ? "chat.jira.metadata.archived"
        : source.archived === false
          ? "chat.jira.metadata.notArchived"
          : "chat.jira.metadata.archiveUnknown",
    ],
  };
}
function estimation(data: Source): JiraAgileDetails | undefined {
  if (text(data.fieldId) === undefined) return undefined;
  const value =
    typeof data.value === "number" && Number.isFinite(data.value)
      ? String(data.value)
      : typeof data.value === "string"
        ? data.value
        : undefined;
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
      data.value === true
        ? "chat.jira.agileContext.refinedEnabled"
        : data.value === false
          ? "chat.jira.agileContext.refinedDisabled"
          : "chat.jira.agileContext.refinedUnknown",
    ],
  };
}
/** Visible native populations and raw estimate values are observations, never board-wide completeness or units. */
export function jiraAgileContextDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_AGILE_CONTEXT_TOOLS.has(tool)) return [];
  if (tool === "jira_issue_estimation" || tool === "jira_board_refined_velocity") {
    const item = tool === "jira_issue_estimation" ? estimation(data) : refinedVelocity(data);
    return item === undefined ? [] : [item];
  }
  const head = context(data);
  const items =
    tool === "jira_board_projects" || tool === "jira_board_versions"
      ? (Array.isArray(data.items) ? data.items : [data]).flatMap((value: unknown) => {
          const source = record(value);
          const item =
            source === undefined
              ? undefined
              : tool === "jira_board_projects"
                ? project(source)
                : jiraVersionSummaryDetails(source);
          return item === undefined ? [] : [item];
        })
      : [];
  return [...(head === undefined ? [] : [head]), ...items];
}
