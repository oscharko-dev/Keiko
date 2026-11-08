import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { executeJiraSelectedRead, selectJiraReadPage, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { jiraRoleSummary as role, jiraRoleActors as actors, jiraRoleReviewSnapshot } from "./jira-role-values.js";

export const JIRA_ROLE_READS = JIRA_READ_TOOL_FAMILIES.roles;
type RoleRead = (typeof JIRA_ROLE_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_ROLE_READS);
const FIELDS: Readonly<Record<RoleRead, readonly string[]>> = {
  "jira.roles": ["startAt", "maxResults"],
  "jira.role": ["roleId"],
  "jira.role-default-actors": ["roleId", "startAt", "maxResults"],
  "jira.project-roles": ["projectIdOrKey", "startAt", "maxResults"],
  "jira.project-role": ["projectIdOrKey", "roleId"],
};
interface Selection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
  readonly roleId?: string;
  readonly project?: string;
  readonly context?: CatalogJsonObject;
}
function roleSelection(args: CatalogJsonObject, page: Omit<Selection, "path">, defaults: boolean): Selection | undefined {
  if (!jiraNativeId(args.roleId)) return undefined;
  return { ...page, roleId: args.roleId, path: `role/${args.roleId}${defaults ? "/actors" : ""}` };
}
function projectSelection(args: CatalogJsonObject, page: Omit<Selection, "path">, single: boolean): Selection | undefined {
  if (!isSafeAtlassianIdentifier(args.projectIdOrKey)) return undefined;
  const selected = { ...page, project: args.projectIdOrKey,
    path: `project/${encodeURIComponent(args.projectIdOrKey)}/role` };
  if (!single) return selected;
  return jiraNativeId(args.roleId)
    ? { ...selected, roleId: args.roleId, path: `${selected.path}/${args.roleId}` }
    : undefined;
}
function selection(name: RoleRead, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, new Set(FIELDS[name]));
  if (page === undefined) return undefined;
  switch (name) {
    case "jira.roles": return { ...page, path: "role" };
    case "jira.role": return roleSelection(args, page, false);
    case "jira.role-default-actors": return roleSelection(args, page, true);
    case "jira.project-roles": return projectSelection(args, page, false);
    case "jira.project-role": return projectSelection(args, page, true);
  }
}
function exceedsBounds(value: unknown): boolean {
  const raw = asRecord(value);
  const description = raw?.description;
  if (typeof description === "string" && (description.length > 32768 || !jiraProjectionTextFits(description))) return true;
  const values = asArray(raw?.actors);
  return values !== undefined && values.length > TOOL_CATALOG_LIMITS.maxArrayItems;
}
function roleNames(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const raw = asRecord(response.body);
  if (raw === undefined) return jiraReadFailure("malformed-payload");
  const entries = Object.entries(raw);
  if (entries.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const [name, uri] of entries) {
    // The native map carries role detail URIs, not role IDs. Do not derive IDs or issue requests from them.
    if (!jiraNativeText(name, 255) || !jiraNativeText(uri, 2048)) return jiraReadFailure("malformed-payload");
    items.push({ name });
  }
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, ...selected.context } });
}
function defaults(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const raw = asRecord(response.body);
  if (raw === undefined) return jiraReadFailure("malformed-payload");
  const context = { roleId: selected.roleId ?? "", actorsScope: "role-defaults" };
  if (raw.actors === undefined || raw.actors === null) return { data: { outcome: "succeeded", ...context } };
  if (exceedsBounds(raw)) return jiraReadFailure("bounds-exceeded");
  const items = actors(raw.actors);
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, ...context } });
}
function roleList(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some(exceedsBounds)) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, role, "id");
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, actorsScope: "role-configuration" } });
}
function roleSingle(name: RoleRead, response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (exceedsBounds(response.body)) return jiraReadFailure("bounds-exceeded");
  if (selected.roleId === undefined) return jiraReadFailure("malformed-payload");
  const item = role(response.body);
  const reviewSnapshot = jiraRoleReviewSnapshot(response.body);
  return item?.id !== selected.roleId ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", ...item, ...selected.context,
      ...(reviewSnapshot === undefined ? {} : { reviewSnapshot: { ...reviewSnapshot } }),
      actorsScope: name === "jira.project-role" ? "project-membership" : "role-configuration" } });
}
function projectResponse(name: RoleRead, response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  switch (name) {
    case "jira.project-roles": return roleNames(response, selected);
    case "jira.role-default-actors": return defaults(response, selected);
    case "jira.roles": return roleList(response, selected);
    default: return roleSingle(name, response, selected);
  }
}
export function isJiraRoleRead(name: string): name is RoleRead { return READS.has(name); }
// Internal reuse for native role-mutation review; optional observations remain optional here.
export { jiraRoleSummary, jiraRoleActors } from "./jira-role-values.js";
/** Role definitions/defaults/project membership are observations, never effective access grants. */
export async function executeJiraRoleRead(name: RoleRead, args: CatalogJsonObject, request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  let selected = selection(name, args);
  if (selected?.project !== undefined) {
    const bound = await readJiraBoundProject(request, selected.project);
    if (!bound.ok) return jiraReadFailure(bound.reason, bound.detail);
    selected = { ...selected, path: `project/${bound.project.projectId}/role${selected.roleId === undefined ? "" : `/${selected.roleId}`}`,
      context: { projectId: bound.project.projectId, projectKey: bound.project.projectKey } };
  }
  return executeJiraSelectedRead(selected, request, name === "jira.roles" ? "json-array" : "json",
    (response, selection) => projectResponse(name, response, selection));
}
