import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { asArray } from "./atlassian-sync-classify.js";
import { jiraReadFailure, projectJiraCollection, remoteJiraPage } from "./jira-managed-metadata.js";
import {
  boundJiraReadResult,
  jiraIssueReadResult,
  JIRA_MANAGED_SEARCH_FIELDS,
} from "./jira-managed-issue-reads.js";
import {
  agileBoard,
  agileBoardConfiguration,
  agileEpic,
  agileIssueKey,
  agileSprint,
  agileText,
} from "./jira-agile-projection.js";
import { jiraAgileRequest } from "./jira-agile-request.js";
import { agileInputId } from "./jira-agile-inputs.js";

export const JIRA_AGILE_READ_OPERATIONS = [
  "jira.boards",
  "jira.board",
  "jira.board-configuration",
  "jira.board-backlog",
  "jira.board-issues",
  "jira.board-epics",
  "jira.epic",
  "jira.epic-issues",
  "jira.sprints",
  "jira.sprint",
  "jira.sprint-issues",
] as const;
export type JiraAgileReadOperation = (typeof JIRA_AGILE_READ_OPERATIONS)[number];
type Projection = (value: unknown) => CatalogJsonObject | undefined;
const BOARD_TYPES: ReadonlySet<unknown> = new Set(["scrum", "kanban"]);
const SPRINT_STATES: ReadonlySet<unknown> = new Set(["future", "active", "closed"]);
interface ReadRoute {
  readonly path: string;
  readonly keys: readonly string[];
  readonly project: Projection;
  readonly mode: "single" | "page" | "issues";
  readonly identity?: string;
}
function entityRoute(name: string, args: CatalogJsonObject): ReadRoute | undefined {
  if (name === "jira.boards")
    return {
      path: "board",
      keys: ["name", "type", "projectKeyOrId"],
      project: agileBoard,
      mode: "page",
    };
  const boardId = agileInputId(args.boardId);
  if (name.startsWith("jira.board") || name === "jira.sprints")
    return boardId === undefined ? undefined : boardRoute(name, boardId);
  return otherEntityRoute(name, args);
}
function otherEntityRoute(name: string, args: CatalogJsonObject): ReadRoute | undefined {
  const sprintId = agileInputId(args.sprintId);
  if (name === "jira.sprint" || name === "jira.sprint-issues")
    return sprintId === undefined
      ? undefined
      : {
          path: `sprint/${sprintId}${name.endsWith("issues") ? "/issue" : ""}`,
          keys: ["sprintId"],
          project: agileSprint,
          mode: name.endsWith("issues") ? "issues" : "single",
          identity: sprintId,
        };
  const epic =
    agileInputId(args.epicIdOrKey) ??
    (agileIssueKey(args.epicIdOrKey) ? args.epicIdOrKey : undefined);
  return epic === undefined ? undefined : epicRoute(name, epic);
}
function boardRoute(name: string, boardId: string): ReadRoute | undefined {
  const routes: Readonly<
    Record<string, readonly [string, Projection, ReadRoute["mode"], readonly string[]]>
  > = {
    "jira.board": ["", agileBoard, "single", []],
    "jira.board-configuration": ["/configuration", agileBoardConfiguration, "single", []],
    "jira.board-backlog": ["/backlog", agileBoard, "issues", []],
    "jira.board-issues": ["/issue", agileBoard, "issues", []],
    "jira.board-epics": ["/epic", agileEpic, "page", ["done"]],
    "jira.sprints": ["/sprint", agileSprint, "page", ["state"]],
  };
  const route = routes[name];
  return route === undefined
    ? undefined
    : {
        path: `board/${boardId}${route[0]}`,
        project: route[1],
        mode: route[2],
        keys: ["boardId", ...route[3]],
        identity: boardId,
      };
}
function epicRoute(name: string, epic: string): ReadRoute | undefined {
  if (name !== "jira.epic" && name !== "jira.epic-issues") return undefined;
  return {
    path: `epic/${encodeURIComponent(epic)}${name.endsWith("issues") ? "/issue" : ""}`,
    keys: ["epicIdOrKey"],
    project: agileEpic,
    mode: name.endsWith("issues") ? "issues" : "single",
    identity: epic,
  };
}
function paging(value: unknown, fallback: number, min: number, max: number): number | undefined {
  return value === undefined
    ? fallback
    : typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : undefined;
}
function textFilters(args: CatalogJsonObject, query: URLSearchParams): boolean {
  for (const key of ["name", "projectKeyOrId"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!agileText(value, 255)) return false;
    query.set(key, value);
  }
  return true;
}
function filters(args: CatalogJsonObject, query: URLSearchParams): boolean {
  if (!textFilters(args, query)) return false;
  if (args.type !== undefined) {
    if (typeof args.type !== "string" || !BOARD_TYPES.has(args.type)) return false;
    query.set("type", args.type);
  }
  if (args.state !== undefined) {
    if (typeof args.state !== "string" || !SPRINT_STATES.has(args.state)) return false;
    query.set("state", args.state);
  }
  if (args.done !== undefined) {
    if (typeof args.done !== "boolean") return false;
    query.set("done", String(args.done));
  }
  return true;
}
function selection(
  name: string,
  args: CatalogJsonObject,
): { route: ReadRoute; path: string; startAt: number; maxResults: number } | undefined {
  const route = entityRoute(name, args);
  if (route === undefined) return undefined;
  const allowed = new Set([
    ...route.keys,
    ...(route.mode === "single" ? [] : ["startAt", "maxResults"]),
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const startAt = paging(args.startAt, 0, 0, 1_000_000);
  const maxResults = paging(args.maxResults, 25, 1, 100);
  if (startAt === undefined || maxResults === undefined) return undefined;
  const query = new URLSearchParams();
  if (route.mode !== "single") {
    query.set("startAt", String(startAt));
    query.set("maxResults", String(maxResults));
  }
  if (!filters(args, query)) return undefined;
  if (route.mode === "issues") query.set("fields", JIRA_MANAGED_SEARCH_FIELDS);
  return {
    route,
    path: route.path + (query.size === 0 ? "" : `?${query.toString()}`),
    startAt,
    maxResults,
  };
}
function single(route: ReadRoute, body: Record<string, unknown>): ManagedMcpToolResult {
  const item = route.project(body);
  if (
    item === undefined ||
    (route.identity !== undefined && item.id !== route.identity && item.key !== route.identity)
  )
    return jiraReadFailure("malformed-payload");
  return { data: { outcome: "succeeded", items: [item] } };
}
/** Model arguments select only a declared operation's typed parameters, never a URL or root. */
export async function executeJiraAgileRead(
  operation: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<ManagedMcpToolResult> {
  const selected = selection(operation, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  if (connection.deployment !== "data-center") return jiraReadFailure("unsupported-deployment");
  const response = await jiraAgileRequest(connection, context)(selected.path);
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200 || response.body === undefined)
    return jiraReadFailure("malformed-payload");
  const { route, startAt, maxResults } = selected;
  if (route.mode === "single") return single(route, response.body);
  if (route.mode === "issues")
    return boundJiraReadResult(
      jiraIssueReadResult("jira.search", connection.baseUrl, response.body, startAt, maxResults),
    );
  const values = asArray(response.body.values);
  const items =
    values === undefined
      ? undefined
      : projectJiraCollection(values, maxResults, route.project, "id");
  return boundJiraReadResult(remoteJiraPage(response.body, items, startAt, maxResults));
}
