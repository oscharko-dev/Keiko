import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { agileInputId } from "./jira-agile-inputs.js";
import { agileText } from "./jira-agile-projection.js";
import { jiraAgileRequests } from "./jira-agile-request.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";

export const JIRA_FILTER_READ_OPERATIONS = ["jira.filter", "jira.favourite-filters"] as const;
function ownerProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const owner: Record<string, string> = {};
  for (const key of ["key", "name", "displayName"] as const) {
    if (raw[key] === undefined) continue;
    if (!agileText(raw[key], 255)) return undefined;
    owner[key] = raw[key];
  }
  return Object.keys(owner).length === 0 ? undefined : owner;
}
function shareScope(permissions: readonly unknown[] | undefined): string {
  if (permissions === undefined) return "unknown";
  return permissions.length === 0 ? "private" : "shared";
}
function filterProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = agileInputId(raw?.id);
  if (
    raw === undefined ||
    id === undefined ||
    !agileText(raw.name) ||
    !agileText(raw.jql, TOOL_CATALOG_LIMITS.maxStringBytes)
  )
    return undefined;
  const description = raw.description ?? null;
  if (description !== null && (typeof description !== "string" || description.length > 32768 || /\p{Surrogate}/u.test(description))) return undefined;
  const permissions = asArray(raw.sharePermissions);
  const result: Record<string, CatalogJsonValue> = {
    id,
    name: raw.name,
    jql: raw.jql,
    description,
    shareScope: shareScope(permissions),
  };
  const owner = ownerProjection(raw.owner);
  if (owner !== undefined) result.owner = owner;
  if (typeof raw.favourite === "boolean") result.favourite = raw.favourite;
  if (permissions !== undefined) result.sharePermissionCount = permissions.length;
  return result;
}
function pageNumber(value: unknown, fallback: number, max: number, min = 0): number | undefined {
  return value === undefined
    ? fallback
    : typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : undefined;
}
interface FilterSelection {
  readonly path: string;
  readonly filterId?: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function selection(operation: string, args: CatalogJsonObject): FilterSelection | undefined {
  if (operation === "jira.filter") {
    const filterId = agileInputId(args.filterId);
    return filterId === undefined || Object.keys(args).some((key) => key !== "filterId")
      ? undefined
      : { path: `filter/${filterId}`, filterId, startAt: 0, maxResults: 1 };
  }
  if (
    operation !== "jira.favourite-filters" ||
    Object.keys(args).some((key) => key !== "startAt" && key !== "maxResults")
  )
    return undefined;
  const startAt = pageNumber(args.startAt, 0, 1000);
  const maxResults = pageNumber(args.maxResults, 25, 100, 1);
  return startAt === undefined || maxResults === undefined
    ? undefined
    : { path: "filter/favourite", startAt, maxResults };
}
function singleFilter(value: unknown, filterId: string): ManagedMcpToolResult {
  const item = filterProjection(value);
  return item?.id !== filterId
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", items: [item] } });
}
/** The native favourites endpoint is unpaged; Keiko bounds the whole reply before paging it locally. */
export async function executeJiraFilterRead(
  operation: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<ManagedMcpToolResult> {
  const selected = selection(operation, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  if (connection.deployment !== "data-center") return jiraReadFailure("unsupported-deployment");
  const response = await jiraAgileRequests(connection, context).issue(
    selected.path,
    "GET",
    undefined,
    selected.filterId === undefined ? "json-array" : "json",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  if (selected.filterId !== undefined) return singleFilter(response.body, selected.filterId);
  const items =
    response.items === undefined
      ? undefined
      : projectJiraCollection(response.items, 1000, filterProjection, "id");
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
