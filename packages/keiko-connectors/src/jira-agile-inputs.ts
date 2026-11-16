import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { agileDate, agileId, agileIssueKey, agileText } from "./jira-agile-projection.js";

export const JIRA_AGILE_MUTATIONS = [
  "jira.board-create",
  "jira.sprint-create",
  "jira.sprint-update",
  "jira.sprint-move-issues",
  "jira.backlog-move-issues",
  "jira.epic-update",
  "jira.epic-move-issues",
] as const;
export type JiraAgileMutation = (typeof JIRA_AGILE_MUTATIONS)[number];
export interface AgileMutationInput {
  readonly operation: JiraAgileMutation;
  readonly target?: string;
  readonly body: CatalogJsonObject;
  readonly issues?: readonly string[];
}
const FIELDS: Readonly<Record<JiraAgileMutation, readonly string[]>> = {
  "jira.board-create": ["name", "type", "filterId"],
  "jira.sprint-create": ["name", "originBoardId", "startDate", "endDate", "goal"],
  "jira.sprint-update": ["sprintId", "name", "startDate", "endDate", "goal", "state"],
  "jira.sprint-move-issues": ["sprintId", "issues"],
  "jira.backlog-move-issues": ["issues"],
  "jira.epic-update": ["epicIdOrKey", "name", "summary", "done", "color"],
  "jira.epic-move-issues": ["epicIdOrKey", "issues"],
};
const OPERATIONS: ReadonlySet<string> = new Set(JIRA_AGILE_MUTATIONS);
export function isJiraAgileMutation(value: string): value is JiraAgileMutation {
  return OPERATIONS.has(value);
}
/** Inputs are canonical decimal strings; numeric wire IDs are produced only after exact validation. */
export function agileInputId(value: unknown): string | undefined {
  return typeof value === "string" ? agileId(value) : undefined;
}
function targetId(operation: JiraAgileMutation, args: CatalogJsonObject): string | undefined {
  if (operation === "jira.sprint-update" || operation === "jira.sprint-move-issues")
    return agileInputId(args.sprintId);
  if (operation === "jira.epic-update" || operation === "jira.epic-move-issues")
    return (
      agileInputId(args.epicIdOrKey) ??
      (agileIssueKey(args.epicIdOrKey) ? args.epicIdOrKey : undefined)
    );
  return undefined;
}
function issueKeys(value: CatalogJsonValue | undefined): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return undefined;
  const keys: unknown[] = Array.from(value);
  if (!keys.every(agileIssueKey)) return undefined;
  return new Set(keys).size === keys.length ? keys : undefined;
}
function sprintValue(key: string, value: CatalogJsonValue): CatalogJsonValue | undefined {
  switch (key) {
    case "name":
      return agileText(value) && value.trim().length > 0 ? value.trim() : undefined;
    case "goal":
      return agileText(value, 2048, true) ? value : undefined;
    case "state":
      return value === "active" || value === "closed" ? value : undefined;
    default:
      return undefined;
  }
}
function sprintField(key: string, value: CatalogJsonValue): CatalogJsonValue | undefined {
  if (key === "startDate" || key === "endDate") return agileDate(value) ? value : undefined;
  if (key === "originBoardId") return agileInputId(value) === undefined ? undefined : Number(value);
  return sprintValue(key, value);
}
function epicField(key: string, value: CatalogJsonValue): CatalogJsonValue | undefined {
  switch (key) {
    case "name":
    case "summary":
      return agileText(value) && value.trim().length > 0 ? value : undefined;
    case "done":
      return typeof value === "boolean" ? value : undefined;
    case "color":
      return typeof value === "string" && /^color_[1-9]$/u.test(value) ? { key: value } : undefined;
    default:
      return undefined;
  }
}
function boardBody(args: CatalogJsonObject): CatalogJsonObject | undefined {
  if (
    !agileText(args.name, 254) ||
    args.name.trim().length === 0 ||
    (args.type !== "scrum" && args.type !== "kanban") ||
    agileInputId(args.filterId) === undefined
  )
    return undefined;
  return { name: args.name, type: args.type, filterId: Number(args.filterId) };
}
function changes(
  operation: JiraAgileMutation,
  args: CatalogJsonObject,
): CatalogJsonObject | undefined {
  if (operation === "jira.board-create") return boardBody(args);
  const body: Record<string, CatalogJsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "sprintId" || key === "epicIdOrKey") continue;
    const parsed =
      operation === "jira.epic-update" ? epicField(key, value) : sprintField(key, value);
    if (parsed === undefined) return undefined;
    body[key] = parsed;
  }
  return validChanges(operation, body) ? body : undefined;
}
export function agileDateRange(start: unknown, end: unknown): boolean {
  return (
    typeof start !== "string" || typeof end !== "string" || Date.parse(end) > Date.parse(start)
  );
}
function validChanges(operation: JiraAgileMutation, body: CatalogJsonObject): boolean {
  if (Object.keys(body).length === 0) return false;
  if (
    operation === "jira.sprint-create" &&
    (body.name === undefined || body.originBoardId === undefined)
  )
    return false;
  return agileDateRange(body.startDate, body.endDate);
}
/** This closed adapter accepts no URL, HTTP method, arbitrary fields or alternate endpoint. */
export function parseAgileMutation(
  operation: string,
  args: CatalogJsonObject,
): AgileMutationInput | undefined {
  if (!isJiraAgileMutation(operation)) return undefined;
  const allowed = new Set(FIELDS[operation]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const target = targetId(operation, args);
  const needsTarget = FIELDS[operation].some((key) => key === "sprintId" || key === "epicIdOrKey");
  if (needsTarget && target === undefined) return undefined;
  if (operation.endsWith("move-issues")) {
    const issues = issueKeys(args.issues);
    return issues === undefined
      ? undefined
      : { operation, body: { issues }, issues, ...(target === undefined ? {} : { target }) };
  }
  const body = changes(operation, args);
  return body === undefined
    ? undefined
    : { operation, body, ...(target === undefined ? {} : { target }) };
}
