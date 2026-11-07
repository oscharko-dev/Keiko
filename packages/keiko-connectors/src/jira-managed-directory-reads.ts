import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraNativeText } from "./jira-native-values.js";

export const JIRA_DIRECTORY_READS = [
  "jira.group-members",
  "jira.groups",
  "jira.application-roles",
  "jira.application-role",
] as const;
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
  if (name === "jira.application-role")
    return isSafeAtlassianIdentifier(args.applicationRoleKey)
      ? {
          path: `applicationrole/${encodeURIComponent(args.applicationRoleKey)}`,
          applicationRoleKey: args.applicationRoleKey,
          startAt,
          maxResults,
        }
      : undefined;
  const query = new URLSearchParams({ maxResults: String(maxResults) });
  if (name === "jira.groups") {
    if (args.query !== undefined && !jiraNativeText(args.query, 255, true)) return undefined;
    if (typeof args.query === "string") query.set("query", args.query);
    return { path: `groups/picker?${query.toString()}`, startAt, maxResults };
  }
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
function group(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw !== undefined && jiraNativeText(raw.name, 255) ? { name: raw.name } : undefined;
}
function role(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !isSafeAtlassianIdentifier(raw.key)) return undefined;
  const result: Record<string, CatalogJsonValue> = { key: raw.key };
  for (const key of ["name", "userCountDescription"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!jiraNativeText(raw[key], key === "name" ? 255 : 1024)) return undefined;
    result[key] = raw[key];
  }
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
  for (const key of ["defined", "hasUnlimitedSeats", "platform", "selectedByDefault"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== "boolean") return undefined;
    result[key] = raw[key];
  }
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
    const item = role(value);
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
      : projectJiraCollection(values, selected.maxResults, group, "name");
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
export function isJiraDirectoryRead(name: string): name is DirectoryRead {
  return READS.has(name);
}
/** Group visibility and application-role facts do not grant authority or imply available seats. */
export async function executeJiraDirectoryRead(
  name: DirectoryRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const response = await request(
    selected.path,
    "GET",
    undefined,
    name === "jira.application-roles" ? "json-array" : "json",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  if (name === "jira.application-roles") {
    const values = response.items;
    if (values === undefined) return jiraReadFailure("malformed-payload");
    if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
    const items = roles(values);
    return items === undefined
      ? jiraReadFailure("malformed-payload")
      : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
  }
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  if (name === "jira.application-role") {
    const item = role(body);
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
  return page.isError
    ? page
    : boundJiraReadResult({
        data: {
          ...page.data,
          ...(selected.groupName === undefined ? {} : { groupName: selected.groupName }),
        },
      });
}
