import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
  remoteJiraPage,
} from "./jira-managed-metadata.js";

export const JIRA_SAVED_VIEW_READS = [
  "jira.dashboards",
  "jira.dashboard",
  "jira.filter-share-scope",
  "jira.filter-permissions",
  "jira.filter-permission",
] as const;
type SavedViewRead = (typeof JIRA_SAVED_VIEW_READS)[number];
const OPERATIONS: ReadonlySet<string> = new Set(JIRA_SAVED_VIEW_READS);
const SCOPES: ReadonlySet<unknown> = new Set(["GLOBAL", "AUTHENTICATED", "PRIVATE"]);
const FIELDS: Readonly<Record<SavedViewRead, readonly string[]>> = {
  "jira.dashboards": ["startAt", "maxResults"],
  "jira.dashboard": ["dashboardId"],
  "jira.filter-share-scope": [],
  "jira.filter-permissions": ["filterId", "startAt", "maxResults"],
  "jira.filter-permission": ["filterId", "permissionId"],
};
interface Selection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
  readonly filterId?: string;
  readonly identity?: string;
}
export function isJiraSavedViewRead(name: string): name is SavedViewRead {
  return OPERATIONS.has(name);
}
function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function route(
  name: SavedViewRead,
  args: CatalogJsonObject,
): Omit<Selection, "startAt" | "maxResults"> | undefined {
  switch (name) {
    case "jira.dashboards":
      return { path: "dashboard" };
    case "jira.filter-share-scope":
      return { path: "filter/defaultShareScope" };
    case "jira.dashboard":
      return jiraNativeId(args.dashboardId)
        ? { path: `dashboard/${args.dashboardId}`, identity: args.dashboardId }
        : undefined;
    case "jira.filter-permissions":
      return jiraNativeId(args.filterId)
        ? { path: `filter/${args.filterId}/permission`, filterId: args.filterId }
        : undefined;
    case "jira.filter-permission":
      return jiraNativeId(args.filterId) && jiraNativeId(args.permissionId)
        ? {
            path: `filter/${args.filterId}/permission/${args.permissionId}`,
            filterId: args.filterId,
            identity: args.permissionId,
          }
        : undefined;
  }
}
function selection(name: SavedViewRead, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(FIELDS[name]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (!boundedNumber(startAt, 0, 1_000_000) || !boundedNumber(maxResults, 1, 100)) return undefined;
  const target = route(name, args);
  return target === undefined ? undefined : { ...target, startAt, maxResults };
}
function dashboard(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw !== undefined && jiraNativeId(raw.id) && jiraNativeText(raw.name, 255)
    ? { id: raw.id, name: raw.name }
    : undefined;
}
function wireId(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return jiraNativeId(value) ? value : undefined;
}
const TARGET_FIELDS = [
  ["group", "name", "groupName"],
  ["project", "id", "projectId"],
  ["project", "key", "projectKey"],
  ["role", "id", "roleId"],
  ["role", "name", "roleName"],
  ["user", "name", "userName"],
  ["user", "displayName", "userDisplayName"],
] as const;
function targetField(field: string, value: unknown): string | undefined {
  if (field === "projectId" || field === "roleId") return wireId(value);
  return jiraNativeText(value, field === "projectKey" ? 128 : 255) ? value : undefined;
}
function permissionTargets(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const [group, key, field] of TARGET_FIELDS) {
    if (raw[group] === undefined || raw[group] === null) continue;
    const nested = asRecord(raw[group]);
    if (nested === undefined) return undefined;
    if (nested[key] === undefined) continue;
    const value = targetField(field, nested[key]);
    if (value === undefined) return undefined;
    result[field] = value;
  }
  for (const key of ["edit", "view"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") return undefined;
    result[key] = raw[key];
  }
  return result;
}
function permission(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = wireId(raw?.id);
  if (raw === undefined || id === undefined || !jiraNativeText(raw.type, 64)) return undefined;
  const fields = permissionTargets(raw);
  return fields === undefined ? undefined : { id, type: raw.type, ...fields };
}
function single(item: CatalogJsonObject | undefined, selected: Selection): ManagedMcpToolResult {
  return item === undefined || item.id !== selected.identity
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({
        data: {
          outcome: "succeeded",
          items: [item],
          ...(selected.filterId === undefined ? {} : { filterId: selected.filterId }),
        },
      });
}
function dashboardPage(
  body: Record<string, unknown> | undefined,
  selected: Selection,
): ManagedMcpToolResult {
  if (
    body === undefined ||
    !Array.isArray(body.dashboards) ||
    !boundedNumber(body.total, 0, 1_000_000)
  )
    return jiraReadFailure("malformed-payload");
  const items = projectJiraCollection(body.dashboards, selected.maxResults, dashboard, "id");
  // This native envelope uses a total, not Agile's isLast; continuation URLs are never followed.
  const isLast = selected.startAt + body.dashboards.length >= body.total;
  return boundJiraReadResult(
    remoteJiraPage(
      { startAt: body.startAt, maxResults: body.maxResults, total: body.total, isLast },
      items,
      selected.startAt,
      selected.maxResults,
    ),
  );
}
function permissionsPage(
  items: readonly unknown[] | undefined,
  selected: Selection,
): ManagedMcpToolResult {
  if (items === undefined) return jiraReadFailure("malformed-payload");
  if (items.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const projected = projectJiraCollection(
    items,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    permission,
    "id",
  );
  if (projected === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(projected, selected.startAt, selected.maxResults);
  return boundJiraReadResult({
    ...page,
    data: {
      ...page.data,
      ...(selected.filterId === undefined ? {} : { filterId: selected.filterId }),
    },
  });
}
function savedViewResult(
  name: SavedViewRead,
  response: Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>,
  selected: Selection,
): ManagedMcpToolResult {
  if (name === "jira.dashboards") return dashboardPage(response.body, selected);
  if (name === "jira.filter-permissions") return permissionsPage(response.items, selected);
  if (name === "jira.filter-share-scope") {
    const scope = response.body?.scope;
    return typeof scope === "string" && SCOPES.has(scope)
      ? { data: { outcome: "succeeded", scope } }
      : jiraReadFailure("malformed-payload");
  }
  return single(
    name === "jira.dashboard" ? dashboard(response.body) : permission(response.body),
    selected,
  );
}
/** Closed native GETs only. Custody, authority and body-free operation evidence stay with the caller. */
export async function executeJiraSavedViewRead(
  name: SavedViewRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const path =
    name === "jira.dashboards"
      ? `${selected.path}?startAt=${String(selected.startAt)}&maxResults=${String(selected.maxResults)}`
      : selected.path;
  const response = await request(
    path,
    "GET",
    undefined,
    name === "jira.filter-permissions" ? "json-array" : "json",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  return savedViewResult(name, response, selected);
}
