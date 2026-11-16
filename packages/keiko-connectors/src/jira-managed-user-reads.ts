import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  jiraDirectoryCursor,
  jiraDirectoryNumber,
  jiraDirectoryTotal,
  jiraDirectoryUser,
  jiraDirectoryUsers,
} from "./jira-directory-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeText } from "./jira-native-values.js";
import { jiraReadbackValueMatches } from "./jira-readback-values.js";

export const JIRA_USER_READS = JIRA_READ_TOOL_FAMILIES.users;
type UserRead = (typeof JIRA_USER_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_USER_READS);
const ARGUMENTS: Readonly<Record<UserRead, ReadonlySet<string>>> = {
  "jira.user": new Set(["username", "userKey", "includeDeleted"]),
  "jira.users": new Set(["query", "startAt", "maxResults", "includeActive", "includeInactive"]),
  "jira.user-directory": new Set(["cursor", "maxResults"]),
  "jira.user-picker": new Set(["query", "maxResults"]),
};
interface Selection {
  readonly path: string;
  readonly maxResults: number;
  readonly startAt: number;
  readonly username?: string;
  readonly userKey?: string;
  readonly cursor?: string;
}
function optionalBoolean(args: CatalogJsonObject, key: string, query: URLSearchParams): boolean {
  const value = args[key];
  if (value === undefined) return true;
  if (typeof value !== "boolean") return false;
  query.set(key, String(value));
  return true;
}
function identityValid(username: unknown, userKey: unknown): boolean {
  if ((username === undefined) === (userKey === undefined)) return false;
  if (username !== undefined && !jiraNativeText(username, 255)) return false;
  return userKey === undefined || jiraNativeText(userKey, 255);
}
function singleSelection(args: CatalogJsonObject): Selection | undefined {
  const username = args.username;
  const userKey = args.userKey;
  if (!identityValid(username, userKey)) return undefined;
  const query = new URLSearchParams();
  if (typeof username === "string") query.set("username", username);
  if (typeof userKey === "string") query.set("key", userKey);
  if (!optionalBoolean(args, "includeDeleted", query)) return undefined;
  return {
    path: `user?${query.toString()}`,
    startAt: 0,
    maxResults: 1,
    ...(typeof username === "string" ? { username } : {}),
    ...(typeof userKey === "string" ? { userKey } : {}),
  };
}
function selection(name: UserRead, args: CatalogJsonObject): Selection | undefined {
  if (Object.keys(args).some((key) => !ARGUMENTS[name].has(key))) return undefined;
  if (name === "jira.user") return singleSelection(args);
  const maxResults = jiraDirectoryNumber(args.maxResults, 25, 100, 1);
  if (maxResults === undefined) return undefined;
  const query = new URLSearchParams({ maxResults: String(maxResults) });
  if (name === "jira.user-directory") return directorySelection(args, query, maxResults);
  return searchSelection(name, args, query, maxResults);
}
function directorySelection(
  args: CatalogJsonObject,
  query: URLSearchParams,
  maxResults: number,
): Selection | undefined {
  if (args.cursor !== undefined && !jiraDirectoryCursor(args.cursor)) return undefined;
  if (typeof args.cursor === "string") query.set("cursor", args.cursor);
  return {
    path: `user/list?${query.toString()}`,
    maxResults,
    startAt: 0,
    ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
  };
}
function searchSelection(
  name: UserRead,
  args: CatalogJsonObject,
  query: URLSearchParams,
  maxResults: number,
): Selection | undefined {
  if (args.query !== undefined && !jiraNativeText(args.query, 255, true)) return undefined;
  if (typeof args.query === "string")
    query.set(name === "jira.users" ? "username" : "query", args.query);
  if (name === "jira.user-picker") {
    query.set("showAvatar", "false");
    return { path: `user/picker?${query.toString()}`, maxResults, startAt: 0 };
  }
  const startAt = jiraDirectoryNumber(args.startAt, 0, 99);
  if (
    startAt === undefined ||
    startAt + maxResults > 100 ||
    !optionalBoolean(args, "includeActive", query) ||
    !optionalBoolean(args, "includeInactive", query)
  )
    return undefined;
  query.set("startAt", String(startAt));
  return { path: `user/search?${query.toString()}`, maxResults, startAt };
}
function single(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const item = jiraDirectoryUser(body);
  if (
    item === undefined ||
    (selected.userKey !== undefined && item.key !== selected.userKey) ||
    (selected.username !== undefined &&
      !jiraReadbackValueMatches("user-name", item.name, selected.username))
  )
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({ data: { outcome: "succeeded", ...item } });
}
function cursorValid(cursor: unknown, isLast: boolean, selected: Selection): boolean {
  if (cursor !== undefined && cursor !== null && !jiraDirectoryCursor(cursor)) return false;
  return isLast || (jiraDirectoryCursor(cursor) && cursor !== selected.cursor);
}
function directoryIsLast(
  body: Record<string, unknown>,
  itemCount: number,
  selected: Selection,
): boolean | undefined {
  const isLast = body.isLast;
  const size = body.maxResults;
  if (
    typeof isLast !== "boolean" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < itemCount ||
    size < 1 ||
    size > selected.maxResults
  )
    return undefined;
  return cursorValid(body.nextCursor, isLast, selected) ? isLast : undefined;
}
function directory(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const items = jiraDirectoryUsers(body.values, selected.maxResults);
  const isLast = items === undefined ? undefined : directoryIsLast(body, items.length, selected);
  if (items === undefined || isLast === undefined) return jiraReadFailure("malformed-payload");
  // A cursor resumes after the entire native page. Never fit a prefix and skip its remainder.
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      items,
      isLast,
      ...(!isLast && typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}),
    },
  });
}
function picker(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const items = jiraDirectoryUsers(body.users, selected.maxResults);
  if (items === undefined || !jiraDirectoryTotal(body.total, items.length))
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      items,
      ...(typeof body.total === "number" ? { total: body.total } : {}),
    },
  });
}
function projectResponse(
  name: UserRead,
  response: JiraReadResponse,
  selected: Selection,
): ManagedMcpToolResult {
  if (name === "jira.users") {
    const items = jiraDirectoryUsers(response.items, selected.maxResults);
    if (items === undefined) return jiraReadFailure("malformed-payload");
    const end = selected.startAt + items.length;
    return boundJiraReadResult({
      data: {
        outcome: "succeeded",
        items,
        startAt: selected.startAt,
        searchLimit: 100,
        ...(items.length === selected.maxResults && end < 100 ? { nextStartAt: end } : {}),
      },
    });
  }
  if (response.body === undefined) return jiraReadFailure("malformed-payload");
  if (name === "jira.user") return single(response.body, selected);
  return name === "jira.user-directory"
    ? directory(response.body, selected)
    : picker(response.body, selected);
}
export function isJiraUserRead(name: string): name is UserRead {
  return READS.has(name);
}
/** Public Data Center directory operations; no email, HTML, avatar or remote-link projection. */
export function executeJiraUserRead(
  name: UserRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    selection(name, args),
    request,
    name === "jira.users" ? "json-array" : "json",
    (response, selected) => projectResponse(name, response, selected),
  );
}
