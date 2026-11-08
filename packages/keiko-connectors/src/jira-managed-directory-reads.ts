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
  jiraDirectoryGroup,
  jiraDirectoryNumber,
  jiraDirectoryTotal,
  jiraDirectoryUsers,
} from "./jira-directory-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeText } from "./jira-native-values.js";

export const JIRA_DIRECTORY_READS = JIRA_READ_TOOL_FAMILIES.directory;
type DirectoryRead = (typeof JIRA_DIRECTORY_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_DIRECTORY_READS);
const ARGUMENTS: Readonly<Record<DirectoryRead, ReadonlySet<string>>> = {
  "jira.group-members": new Set(["groupName", "startAt", "maxResults", "includeInactiveUsers"]),
  "jira.groups": new Set(["query", "maxResults"]),
  "jira.application-roles": new Set(["startAt", "maxResults"]),
  "jira.application-role": new Set(["applicationRoleKey"]),
};
interface Selection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
  readonly groupName?: string;
  readonly applicationRoleKey?: string;
}
function applicationRoleSelection(
  args: CatalogJsonObject,
  startAt: number,
  maxResults: number,
): Selection | undefined {
  return isSafeAtlassianIdentifier(args.applicationRoleKey)
    ? {
        path: `applicationrole/${encodeURIComponent(args.applicationRoleKey)}`,
        applicationRoleKey: args.applicationRoleKey,
        startAt,
        maxResults,
      }
    : undefined;
}
function groupsSelection(
  args: CatalogJsonObject,
  query: URLSearchParams,
  startAt: number,
  maxResults: number,
): Selection | undefined {
  if (args.query !== undefined && !jiraNativeText(args.query, 255, true)) return undefined;
  if (typeof args.query === "string") query.set("query", args.query);
  return { path: `groups/picker?${query.toString()}`, startAt, maxResults };
}
function selection(name: DirectoryRead, args: CatalogJsonObject): Selection | undefined {
  if (Object.keys(args).some((key) => !ARGUMENTS[name].has(key))) return undefined;
  const startAt = jiraDirectoryNumber(args.startAt, 0, 1_000_000);
  const maxResults = jiraDirectoryNumber(
    args.maxResults,
    25,
    name === "jira.group-members" ? 50 : 100,
    1,
  );
  if (startAt === undefined || maxResults === undefined) return undefined;
  if (name === "jira.application-roles") return { path: "applicationrole", startAt, maxResults };
  if (name === "jira.application-role") return applicationRoleSelection(args, startAt, maxResults);
  const query = new URLSearchParams({ maxResults: String(maxResults) });
  if (name === "jira.groups") return groupsSelection(args, query, startAt, maxResults);
  return groupMemberSelection(args, query, startAt, maxResults);
}
function groupMemberSelection(
  args: CatalogJsonObject,
  query: URLSearchParams,
  startAt: number,
  maxResults: number,
): Selection | undefined {
  if (!jiraNativeText(args.groupName, 255)) return undefined;
  query.set("groupname", args.groupName);
  query.set("startAt", String(startAt));
  if (args.includeInactiveUsers !== undefined) {
    if (typeof args.includeInactiveUsers !== "boolean") return undefined;
    query.set("includeInactiveUsers", String(args.includeInactiveUsers));
  }
  return {
    path: `group/member?${query.toString()}`,
    groupName: args.groupName,
    startAt,
    maxResults,
  };
}
export function projectJiraApplicationRole(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !isSafeAtlassianIdentifier(raw.key)) return undefined;
  const result: Record<string, CatalogJsonValue> = { key: raw.key };
  const texts = applicationRoleTexts(raw);
  const groups = applicationRoleGroups(raw);
  const flags = applicationRoleFlags(raw);
  const seats = applicationRoleSeats(raw);
  if (texts === undefined || groups === undefined || flags === undefined || seats === undefined)
    return undefined;
  Object.assign(result, texts, groups, flags, seats);
  return result;
}
function applicationRoleTexts(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["name", "userCountDescription"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!jiraNativeText(raw[key], key === "name" ? 255 : 1024)) return undefined;
    result[key] = raw[key];
  }
  return result;
}
function applicationRoleGroups(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["groups", "defaultGroups"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const values = asArray(raw[key]);
    if (
      values === undefined ||
      values.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
      !values.every((entry): entry is string => jiraNativeText(entry, 255)) ||
      new Set(values).size !== values.length
    )
      return undefined;
    result[key] = values;
  }
  return result;
}
function applicationRoleFlags(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["defined", "hasUnlimitedSeats", "platform", "selectedByDefault"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== "boolean") return undefined;
    result[key] = raw[key];
  }
  return result;
}
function applicationRoleSeats(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["numberOfSeats", "remainingSeats", "userCount"] as const) {
    const number = raw[key];
    if (number === undefined || number === null) continue;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < -2147483648 ||
      number > 2147483647
    )
      return undefined;
    result[key] = number;
  }
  return result;
}
function roles(values: readonly unknown[]): readonly CatalogJsonObject[] | undefined {
  const items: CatalogJsonObject[] = [];
  const keys = new Set<string>();
  for (const value of values) {
    const item = projectJiraApplicationRole(value);
    if (item === undefined || typeof item.key !== "string" || keys.has(item.key)) return undefined;
    keys.add(item.key);
    items.push(item);
  }
  return items;
}
function groups(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const values = asArray(body.groups);
  const items =
    values === undefined
      ? undefined
      : projectJiraCollection(values, selected.maxResults, jiraDirectoryGroup, "name");
  if (items === undefined || !jiraDirectoryTotal(body.total, items.length))
    return jiraReadFailure("malformed-payload");
  // The native picker has no offset. Do not emit a locally invented continuation.
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      items,
      ...(typeof body.total === "number" ? { total: body.total } : {}),
    },
  });
}
function rolesResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items = roles(values);
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
function projectResponse(
  name: DirectoryRead,
  response: JiraReadResponse,
  selected: Selection,
): ManagedMcpToolResult {
  if (name === "jira.application-roles") return rolesResponse(response, selected);
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  if (name === "jira.application-role") {
    const item = projectJiraApplicationRole(body);
    return item === undefined || item.key !== selected.applicationRoleKey
      ? jiraReadFailure("malformed-payload")
      : boundJiraReadResult({ data: { outcome: "succeeded", ...item } });
  }
  if (name === "jira.groups") return groups(body, selected);
  const page = remoteJiraPage(
    body,
    jiraDirectoryUsers(body.values, selected.maxResults),
    selected.startAt,
    selected.maxResults,
  );
  if (page.isError) {
    return page;
  }
  return boundJiraReadResult({
    data: {
      ...page.data,
      ...(selected.groupName === undefined ? {} : { groupName: selected.groupName }),
    },
  });
}
export function isJiraDirectoryRead(name: string): name is DirectoryRead {
  return READS.has(name);
}
/** Group visibility and application-role facts do not grant authority or imply available seats. */
export function executeJiraDirectoryRead(
  name: DirectoryRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    selection(name, args),
    request,
    name === "jira.application-roles" ? "json-array" : "json",
    (response, selected) => projectResponse(name, response, selected),
  );
}
