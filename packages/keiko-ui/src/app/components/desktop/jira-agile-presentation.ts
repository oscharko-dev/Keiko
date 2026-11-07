import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";

type Source = Readonly<Record<string, unknown>>;
export interface JiraOutcomeFact {
  readonly label: WidgetMessageKey;
  readonly value: string;
}
export interface JiraAgileDetails {
  readonly key?: string;
  readonly name?: string;
  readonly body?: string;
  readonly facts: readonly JiraOutcomeFact[];
  readonly labels: readonly WidgetMessageKey[];
}

const BOARDS = new Set([
  "jira_boards",
  "jira_board",
  "jira_board_configuration",
  "jira_board_create",
]);
export const JIRA_SPRINT_TOOLS: ReadonlySet<string> = new Set([
  "jira_sprints",
  "jira_sprint",
  "jira_sprint_create",
  "jira_sprint_update",
  "jira_sprint_move_issues",
]);
const EPICS = new Set([
  "jira_board_epics",
  "jira_epic",
  "jira_epic_update",
  "jira_epic_move_issues",
]);
const FILTERS = new Set(["jira_filter", "jira_favourite_filters"]);
export const JIRA_AGILE_TOOLS: ReadonlySet<string> = new Set([
  ...BOARDS,
  ...JIRA_SPRINT_TOOLS,
  ...EPICS,
  ...FILTERS,
  "jira_board_backlog",
  "jira_board_issues",
  "jira_epic_issues",
  "jira_sprint_issues",
  "jira_backlog_move_issues",
]);
const STATES: Readonly<Record<string, WidgetMessageKey>> = {
  future: "chat.jira.agile.future",
  active: "chat.jira.agile.active",
  closed: "chat.jira.agile.closed",
};
const BOARD_TYPES: Readonly<Record<string, WidgetMessageKey>> = {
  scrum: "chat.jira.agile.scrum",
  kanban: "chat.jira.agile.kanban",
};
const ID_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  boardId: "chat.jira.fact.boardId",
  sprintId: "chat.jira.fact.sprintId",
  filterId: "chat.jira.fact.filterId",
  originBoardId: "chat.jira.fact.boardId",
};
const FILTER_SCOPES: Readonly<Record<string, WidgetMessageKey>> = {
  unknown: "chat.jira.agile.filterSharingUnknown",
  private: "chat.jira.agile.filterPrivate",
  shared: "chat.jira.agile.filterShared",
};
const DATE_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  startDate: "chat.jira.fact.startDate",
  endDate: "chat.jira.fact.endDate",
  completeDate: "chat.jira.fact.completeDate",
  activatedDate: "chat.jira.fact.activatedDate",
};
function content(source: Source, field: string): string | undefined {
  const value = source[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function idFacts(source: Source): JiraOutcomeFact[] {
  return Object.entries(ID_LABELS).flatMap(([field, label]) => {
    const value = content(source, field);
    return value !== undefined &&
      /^[1-9][0-9]{0,15}$/u.test(value) &&
      Number.isSafeInteger(Number(value))
      ? [{ label, value }]
      : [];
  });
}
function dateFacts(source: Source): JiraOutcomeFact[] {
  return Object.entries(DATE_LABELS).flatMap(([field, label]) => {
    const value = content(source, field);
    return value === undefined ? [] : [{ label, value }];
  });
}
function closedLabel(
  value: unknown,
  labels: Readonly<Record<string, WidgetMessageKey>>,
): WidgetMessageKey[] {
  const label =
    typeof value === "string" && Object.hasOwn(labels, value) ? labels[value] : undefined;
  return label === undefined ? [] : [label];
}
function identityFacts(tool: string, source: Source): JiraOutcomeFact[] {
  return idFacts({
    ...source,
    boardId: source.boardId ?? (BOARDS.has(tool) ? source.id : undefined),
    sprintId: source.sprintId ?? (JIRA_SPRINT_TOOLS.has(tool) ? source.id : undefined),
    filterId: source.filterId ?? (FILTERS.has(tool) ? source.id : undefined),
  });
}
function agileLabels(tool: string, source: Source): WidgetMessageKey[] {
  const labels = [
    ...(JIRA_SPRINT_TOOLS.has(tool) ? closedLabel(source.state, STATES) : []),
    ...(BOARDS.has(tool) ? closedLabel(source.type, BOARD_TYPES) : []),
    ...(FILTERS.has(tool) ? closedLabel(source.shareScope, FILTER_SCOPES) : []),
  ];
  if (EPICS.has(tool) && typeof source.done === "boolean")
    labels.push(source.done ? "chat.jira.agile.epicDone" : "chat.jira.agile.epicOpen");
  return labels;
}
function filterFacts(source: Source): JiraOutcomeFact[] {
  const query = content(source, "jql");
  return query === undefined ? [] : [{ label: "chat.jira.fact.filterQuery", value: query }];
}
/** Closed native facts from the saved receipt; this projection never invents board/sprint URLs. */
export function jiraAgileDetails(tool: string, source: Source): JiraAgileDetails {
  if (!JIRA_AGILE_TOOLS.has(tool)) return { facts: [], labels: [] };
  const sprint = JIRA_SPRINT_TOOLS.has(tool);
  const epic = EPICS.has(tool);
  const key = content(source, "epicKey");
  const name = epic ? content(source, "name") : undefined;
  const body = sprint ? content(source, "goal") : epic ? content(source, "summary") : undefined;
  return {
    ...(key === undefined ? {} : { key }),
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { body }),
    facts: [
      ...identityFacts(tool, source),
      ...(sprint ? dateFacts(source) : []),
      ...(FILTERS.has(tool) ? filterFacts(source) : []),
    ],
    labels: agileLabels(tool, source),
  };
}

const ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  ...ID_LABELS,
  ...DATE_LABELS,
  epicIdOrKey: "chat.jira.fact.epicIdOrKey",
  issues: "chat.jira.fact.issueKeys",
  type: "chat.jira.fact.boardType",
  goal: "chat.jira.fact.sprintGoal",
  state: "chat.jira.fact.sprintState",
  summary: "chat.jira.fact.epicSummary",
  done: "chat.jira.fact.epicDone",
  color: "chat.jira.fact.epicColor",
};
export function jiraAgileArgumentLabel(
  operation: string | undefined,
  field: string,
): WidgetMessageKey | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  if (tool === undefined || !JIRA_AGILE_TOOLS.has(tool)) return undefined;
  if (field !== "name") return ARGUMENT_LABELS[field];
  if (BOARDS.has(tool)) return "chat.jira.fact.boardName";
  return JIRA_SPRINT_TOOLS.has(tool) ? "chat.jira.fact.sprintName" : "chat.jira.fact.epicName";
}
