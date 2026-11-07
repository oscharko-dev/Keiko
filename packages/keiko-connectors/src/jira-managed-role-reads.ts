import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraSecurityLevelProjection } from "./jira-managed-access-schemes.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { executeJiraSelectedRead, selectJiraReadPage, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_ROLE_READS = ["jira.roles", "jira.role", "jira.role-default-actors", "jira.project-roles", "jira.project-role"] as const;
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
function selection(name: RoleRead, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, new Set(FIELDS[name]));
  if (page === undefined) return undefined;
  const needsRole = name === "jira.role" || name === "jira.role-default-actors" || name === "jira.project-role";
  const needsProject = name === "jira.project-roles" || name === "jira.project-role";
  if (needsRole && !jiraNativeId(args.roleId)) return undefined;
  if (needsProject && !isSafeAtlassianIdentifier(args.projectIdOrKey)) return undefined;
  const roleId = typeof args.roleId === "string" ? args.roleId : undefined;
  const project = typeof args.projectIdOrKey === "string" ? args.projectIdOrKey : undefined;
  const root = project === undefined ? "role" : `project/${encodeURIComponent(project)}/role`;
  return { ...page, path: `${root}${roleId === undefined ? "" : `/${roleId}`}${name === "jira.role-default-actors" ? "/actors" : ""}`,
    ...(roleId === undefined ? {} : { roleId }), ...(project === undefined ? {} : { project }) };
}
function actor(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  const result: Record<string, CatalogJsonValue> = { name: raw.name };
  if (raw.id !== undefined && raw.id !== null) {
    const id = jiraNativeNumericId(raw.id);
    if (id === undefined) return undefined;
    result.id = id;
  }
  for (const key of ["type", "displayName"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!jiraNativeText(raw[key], key === "type" ? 128 : 255)) return undefined;
    result[key] = raw[key];
  }
  return result;
}
function actors(value: unknown): readonly CatalogJsonObject[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const items: CatalogJsonObject[] = [];
  const observedIds = new Set<string>();
  for (const value of values) {
    const item = actor(value);
    if (item === undefined) return undefined;
    // A user and group can share a name. Only an actual actor ID establishes identity uniqueness.
    if (typeof item.id === "string") {
      if (observedIds.has(item.id)) return undefined;
      observedIds.add(item.id);
    }
    items.push(item);
  }
  return items;
}
function role(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const metadata = jiraSecurityLevelProjection(value);
  if (raw === undefined || metadata === undefined) return undefined;
  if (raw.actors === undefined || raw.actors === null) return metadata;
  const items = actors(raw.actors);
  return items === undefined ? undefined : { ...metadata, actors: items };
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
function projectResponse(name: RoleRead, response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (name === "jira.project-roles") return roleNames(response, selected);
  if (name === "jira.role-default-actors") return defaults(response, selected);
  if (name === "jira.roles") {
    const values = response.items;
    if (values === undefined) return jiraReadFailure("malformed-payload");
    if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some(exceedsBounds)) return jiraReadFailure("bounds-exceeded");
    const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, role, "id");
    if (items === undefined) return jiraReadFailure("malformed-payload");
    const page = localJiraPage(items, selected.startAt, selected.maxResults);
    return boundJiraReadResult({ data: { ...page.data, actorsScope: "role-configuration" } });
  }
  if (exceedsBounds(response.body)) return jiraReadFailure("bounds-exceeded");
  const item = role(response.body);
  return item === undefined || item.id !== selected.roleId ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", ...item, ...selected.context,
      actorsScope: name === "jira.project-role" ? "project-membership" : "role-configuration" } });
}
export function isJiraRoleRead(name: string): name is RoleRead { return READS.has(name); }
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
