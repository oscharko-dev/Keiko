import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  jiraDirectoryNumber,
  jiraDirectoryTotal,
  jiraDirectoryUsers,
} from "./jira-directory-values.js";
import { isJiraFieldId } from "./jira-field-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_SCOPED_DIRECTORY_READS = JIRA_READ_TOOL_FAMILIES.scopedDirectory;
type ScopedRead = (typeof JIRA_SCOPED_DIRECTORY_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_SCOPED_DIRECTORY_READS);
const FIELDS: Readonly<Record<ScopedRead, readonly string[]>> = {
  "jira.multi-project-assignable-users": ["projectKeys", "query", "maxResults"],
  "jira.permission-users": [
    "permissions",
    "projectKey",
    "issueKey",
    "query",
    "startAt",
    "maxResults",
  ],
  "jira.browse-permission-users": ["projectKey", "issueKey", "query", "maxResults"],
  "jira.group-user-picker": ["query", "maxResults", "fieldId", "projectId", "issueTypeId"],
  "jira.project-picker": ["query", "maxResults", "allowEmptyQuery"],
};
interface Selection {
  readonly path: string;
  readonly maxResults: number;
  readonly startAt: number;
}
function identifiers(value: unknown): readonly string[] | undefined {
  const values = asArray(value);
  return values !== undefined &&
    values.length > 0 &&
    values.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    values.every(isSafeAtlassianIdentifier) &&
    new Set(values).size === values.length
    ? values
    : undefined;
}
function selectedScope(args: CatalogJsonObject, query: URLSearchParams): boolean {
  if ((args.projectKey === undefined) === (args.issueKey === undefined)) return false;
  const key = args.projectKey === undefined ? "issueKey" : "projectKey";
  const value = args[key];
  if (!isSafeAtlassianIdentifier(value)) return false;
  query.set(key, value);
  return true;
}
function groupPicker(args: CatalogJsonObject, query: URLSearchParams): boolean {
  query.set("showAvatar", "false");
  if (args.fieldId !== undefined) {
    if (!isJiraFieldId(args.fieldId)) return false;
    query.set("fieldId", args.fieldId);
  }
  for (const key of ["projectId", "issueTypeId"] as const) {
    if (args[key] === undefined) continue;
    if (!jiraNativeId(args[key])) return false;
    query.set(key, args[key]);
  }
  return true;
}
function route(
  name: ScopedRead,
  args: CatalogJsonObject,
  query: URLSearchParams,
  startAt: number,
): string | undefined {
  if (name === "jira.multi-project-assignable-users") {
    const keys = identifiers(args.projectKeys);
    if (keys === undefined) return undefined;
    query.set("projectKeys", keys.join(","));
    return "user/assignable/multiProjectSearch";
  }
  if (name === "jira.group-user-picker")
    return groupPicker(args, query) ? "groupuserpicker" : undefined;
  if (name === "jira.project-picker") {
    if (args.allowEmptyQuery !== undefined) {
      if (typeof args.allowEmptyQuery !== "boolean") return undefined;
      query.set("allowEmptyQuery", String(args.allowEmptyQuery));
    }
    return "projects/picker";
  }
  if (!selectedScope(args, query)) return undefined;
  if (name === "jira.browse-permission-users") return "user/viewissue/search";
  const permissions = identifiers(args.permissions);
  if (permissions === undefined) return undefined;
  query.set("permissions", permissions.join(","));
  query.set("startAt", String(startAt));
  return "user/permission/search";
}
function selection(name: ScopedRead, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(FIELDS[name]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const maxResults = jiraDirectoryNumber(args.maxResults, 25, 100, 1);
  const startAt = jiraDirectoryNumber(args.startAt, 0, 99);
  if (maxResults === undefined || startAt === undefined || startAt + maxResults > 100)
    return undefined;
  if (args.query !== undefined && !jiraNativeText(args.query, 255, true)) return undefined;
  if (name === "jira.browse-permission-users" && !jiraNativeText(args.query, 255)) return undefined;
  const query = new URLSearchParams({ maxResults: String(maxResults) });
  if (typeof args.query === "string")
    query.set(
      name === "jira.project-picker" || name === "jira.group-user-picker" ? "query" : "username",
      args.query,
    );
  const path = route(name, args, query, startAt);
  return path === undefined
    ? undefined
    : { path: `${path}?${query.toString()}`, maxResults, startAt };
}
function project(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw !== undefined &&
    jiraNativeId(raw.id) &&
    isSafeAtlassianIdentifier(raw.key) &&
    jiraNativeText(raw.name, 255)
    ? { id: raw.id, key: raw.key, name: raw.name }
    : undefined;
}
function group(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw !== undefined && jiraNativeText(raw.name, 255) ? { name: raw.name } : undefined;
}
function pickerBranch(
  body: Record<string, unknown>,
  key: "users" | "groups",
  selected: Selection,
): ManagedMcpToolResult {
  if (body[key] === undefined || body[key] === null) return { data: {} };
  const branch = asRecord(body[key]);
  const values = asArray(branch?.[key]);
  if (branch === undefined || values === undefined) return jiraReadFailure("malformed-payload");
  const maximum = key === "users" ? selected.maxResults : TOOL_CATALOG_LIMITS.maxArrayItems;
  if (values.length > maximum) return jiraReadFailure("bounds-exceeded");
  const items =
    key === "users"
      ? jiraDirectoryUsers(values, maximum)
      : projectJiraCollection(values, maximum, group, "name");
  if (items === undefined || !jiraDirectoryTotal(branch.total, items.length))
    return jiraReadFailure("malformed-payload");
  return {
    data: {
      [key]: items,
      ...(typeof branch.total === "number" ? { [`${key}Total`]: branch.total } : {}),
    },
  };
}
function projectPicker(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const values = asArray(body.projects);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > selected.maxResults) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, selected.maxResults, project, "id");
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
function groupUserPicker(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (response.body === undefined) return jiraReadFailure("malformed-payload");
  const users = pickerBranch(response.body, "users", selected);
  if (users.isError) return users;
  const groups = pickerBranch(response.body, "groups", selected);
  return groups.isError
    ? groups
    : boundJiraReadResult({ data: { outcome: "succeeded", ...users.data, ...groups.data } });
}
function projectResponse(
  name: ScopedRead,
  response: JiraReadResponse,
  selected: Selection,
): ManagedMcpToolResult {
  if (name === "jira.project-picker")
    return response.body === undefined
      ? jiraReadFailure("malformed-payload")
      : projectPicker(response.body, selected);
  if (name === "jira.group-user-picker") return groupUserPicker(response, selected);
  if (response.items !== undefined && response.items.length > selected.maxResults)
    return jiraReadFailure("bounds-exceeded");
  const items = jiraDirectoryUsers(response.items, selected.maxResults);
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page: Record<string, CatalogJsonValue> = {};
  if (name === "jira.permission-users") {
    page.startAt = selected.startAt;
    const end = selected.startAt + items.length;
    if (items.length === selected.maxResults && end < 100) page.nextStartAt = end;
  }
  return boundJiraReadResult({ data: { outcome: "succeeded", items, searchLimit: 100, ...page } });
}
export function isJiraScopedDirectoryRead(name: string): name is ScopedRead {
  return READS.has(name);
}
/** Native search scope is retained; candidates do not grant Keiko authority or directory completeness. */
export function executeJiraScopedDirectoryRead(
  name: ScopedRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    selection(name, args),
    request,
    name === "jira.group-user-picker" || name === "jira.project-picker" ? "json" : "json-array",
    (response, selected) => projectResponse(name, response, selected),
  );
}
