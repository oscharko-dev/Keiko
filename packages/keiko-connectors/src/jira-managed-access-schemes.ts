import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_ACCESS_SCHEME_READS = [
  "jira.permission-schemes",
  "jira.permission-scheme",
  "jira.permission-grants",
  "jira.permission-grant",
  "jira.issue-security-schemes",
  "jira.issue-security-scheme",
  "jira.security-level",
] as const;
type AccessRead = (typeof JIRA_ACCESS_SCHEME_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_ACCESS_SCHEME_READS);
const FIELDS: Readonly<Record<AccessRead, readonly string[]>> = {
  "jira.permission-schemes": ["startAt", "maxResults", "includePermissions"],
  "jira.permission-scheme": ["schemeId", "includePermissions"],
  "jira.permission-grants": ["schemeId", "startAt", "maxResults"],
  "jira.permission-grant": ["schemeId", "permissionId"],
  "jira.issue-security-schemes": ["startAt", "maxResults"],
  "jira.issue-security-scheme": ["schemeId"],
  "jira.security-level": ["levelId"],
};
interface Selection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
  readonly schemeId?: string;
  readonly targetId?: string;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function route(
  name: AccessRead,
  args: CatalogJsonObject,
): Pick<Selection, "path" | "schemeId" | "targetId"> | undefined {
  const expand = args.includePermissions === true ? "?expand=permissions" : "";
  if (name === "jira.permission-schemes") return { path: `permissionscheme${expand}` };
  if (name === "jira.issue-security-schemes") return { path: "issuesecurityschemes" };
  if (name === "jira.security-level")
    return jiraNativeId(args.levelId)
      ? { path: `securitylevel/${args.levelId}`, targetId: args.levelId }
      : undefined;
  if (!jiraNativeId(args.schemeId)) return undefined;
  const schemeId = args.schemeId;
  if (name === "jira.issue-security-scheme")
    return { path: `issuesecurityschemes/${schemeId}`, targetId: schemeId };
  const root = `permissionscheme/${schemeId}`;
  if (name === "jira.permission-scheme") return { path: `${root}${expand}`, targetId: schemeId };
  if (name === "jira.permission-grants") return { path: `${root}/permission`, schemeId };
  return jiraNativeId(args.permissionId)
    ? { path: `${root}/permission/${args.permissionId}`, schemeId, targetId: args.permissionId }
    : undefined;
}
function selection(name: AccessRead, args: CatalogJsonObject): Selection | undefined {
  const fields = new Set(FIELDS[name]);
  if (Object.keys(args).some((key) => !fields.has(key))) return undefined;
  if (args.includePermissions !== undefined && typeof args.includePermissions !== "boolean")
    return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (!integer(startAt, 0, 1_000_000) || !integer(maxResults, 1, 100)) return undefined;
  const selected = route(name, args);
  return selected === undefined ? undefined : { ...selected, startAt, maxResults };
}
function namedResource(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  if (raw.description !== undefined && raw.description !== null) {
    if (!jiraNativeText(raw.description, 32768, true)) return undefined;
    return { id, name: raw.name, description: raw.description };
  }
  return { id, name: raw.name };
}
function grant(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  const holder = asRecord(raw?.holder);
  if (
    raw === undefined ||
    id === undefined ||
    !jiraNativeText(raw.permission, 255) ||
    holder === undefined ||
    !jiraNativeText(holder.type, 128)
  )
    return undefined;
  const parameter = holder.parameter;
  if (parameter !== undefined && parameter !== null && !jiraNativeText(parameter, 255, true))
    return undefined;
  return {
    id,
    permission: raw.permission,
    holder: {
      type: holder.type,
      ...(typeof parameter === "string" ? { parameter } : {}),
    },
  };
}
function nestedItems(
  value: unknown,
  key: "permissions" | "levels",
  project: (value: unknown) => CatalogJsonObject | undefined,
): CatalogJsonObject | undefined {
  if (value === undefined || value === null) return {};
  const values = asArray(value);
  const items =
    values === undefined
      ? undefined
      : projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, project, "id");
  return items === undefined ? undefined : { [key]: items };
}
function permissionScheme(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const metadata = namedResource(value);
  if (raw === undefined || metadata === undefined) return undefined;
  const permissions = nestedItems(raw.permissions, "permissions", grant);
  return permissions === undefined ? undefined : { ...metadata, ...permissions };
}
function securityScheme(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const metadata = namedResource(value);
  if (raw === undefined || metadata === undefined) return undefined;
  const levels = nestedItems(raw.levels, "levels", namedResource);
  if (levels === undefined) return undefined;
  if (raw.defaultSecurityLevelId === undefined || raw.defaultSecurityLevelId === null)
    return { ...metadata, ...levels };
  const defaultSecurityLevelId = jiraNativeNumericId(raw.defaultSecurityLevelId);
  return defaultSecurityLevelId === undefined
    ? undefined
    : { ...metadata, ...levels, defaultSecurityLevelId };
}
function projector(name: AccessRead): (value: unknown) => CatalogJsonObject | undefined {
  if (name === "jira.permission-grant" || name === "jira.permission-grants") return grant;
  if (name === "jira.permission-scheme" || name === "jira.permission-schemes")
    return permissionScheme;
  return name === "jira.security-level" ? namedResource : securityScheme;
}
function collectionKey(
  name: AccessRead,
): "permissions" | "permissionSchemes" | "issueSecuritySchemes" | undefined {
  if (name === "jira.permission-grants") return "permissions";
  if (name === "jira.permission-schemes") return "permissionSchemes";
  return name === "jira.issue-security-schemes" ? "issueSecuritySchemes" : undefined;
}
function descriptionExceedsBounds(value: unknown): boolean {
  const description = asRecord(value)?.description;
  return typeof description === "string" &&
    (description.length > 32768 || !jiraProjectionTextFits(description));
}
function resourceExceedsBounds(value: unknown): boolean {
  const raw = asRecord(value);
  if (descriptionExceedsBounds(raw)) return true;
  for (const key of ["permissions", "levels"] as const) {
    const entries = asArray(raw?.[key]);
    if (entries === undefined) continue;
    if (entries.length > TOOL_CATALOG_LIMITS.maxArrayItems) return true;
    if (key === "levels" && entries.some(descriptionExceedsBounds)) return true;
  }
  return false;
}
export {
  permissionScheme as jiraPermissionSchemeProjection,
  securityScheme as jiraSecuritySchemeProjection,
  namedResource as jiraSecurityLevelProjection,
  resourceExceedsBounds as jiraAccessSchemeBoundsExceeded,
};
export function isJiraAccessSchemeRead(name: string): name is AccessRead {
  return READS.has(name);
}
/** Scheme/grant facts are configuration observations, never effective permission or authority grants. */
export async function executeJiraAccessSchemeRead(
  name: AccessRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const response = await request(selected.path, "GET", undefined, "json");
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200 || response.body === undefined)
    return jiraReadFailure("malformed-payload");
  const project = projector(name);
  const context = selected.schemeId === undefined ? {} : { schemeId: selected.schemeId };
  const key = collectionKey(name);
  if (key === undefined) {
    if (resourceExceedsBounds(response.body)) return jiraReadFailure("bounds-exceeded");
    const item = project(response.body);
    return item === undefined || item.id !== selected.targetId
      ? jiraReadFailure("malformed-payload")
      : boundJiraReadResult({ data: { outcome: "succeeded", ...context, ...item } });
  }
  const values = asArray(response.body[key]);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  if (values.some(resourceExceedsBounds)) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, project, "id");
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, ...context } });
}
