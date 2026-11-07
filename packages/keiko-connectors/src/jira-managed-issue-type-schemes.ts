import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_ISSUE_TYPE_SCHEME_READS = JIRA_READ_TOOL_FAMILIES.issueTypeSchemes;
type Read = (typeof JIRA_ISSUE_TYPE_SCHEME_READS)[number];
interface Selection {
  readonly path: string;
  readonly schemeId?: string;
  readonly startAt: number;
  readonly maxResults: number;
}
const FIELDS: Readonly<Record<Read, readonly string[]>> = {
  "jira.issue-type-schemes": [
    "startAt",
    "maxResults",
    "includeIssueTypes",
    "includeDefaultIssueType",
  ],
  "jira.issue-type-scheme": ["schemeId"],
  "jira.issue-type-scheme-projects": ["schemeId", "startAt", "maxResults"],
};
export function isJiraIssueTypeSchemeRead(name: string): name is Read {
  return JIRA_ISSUE_TYPE_SCHEME_READS.some((value) => value === name);
}
function expansion(args: CatalogJsonObject): string | undefined {
  const tokens: string[] = [];
  for (const [key, value] of [
    ["includeIssueTypes", "schemes.issueTypes"],
    ["includeDefaultIssueType", "schemes.defaultIssueType"],
  ] as const) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") return undefined;
    if (args[key] === true) tokens.push(value);
  }
  return tokens.length === 0
    ? ""
    : `?${new URLSearchParams({ expand: tokens.join(",") }).toString()}`;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function selection(name: Read, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(FIELDS[name]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (!integer(startAt, 0, 1_000_000) || !integer(maxResults, 1, 100)) return undefined;
  if (name === "jira.issue-type-schemes") {
    const query = expansion(args);
    return query === undefined
      ? undefined
      : { path: `issuetypescheme${query}`, startAt, maxResults };
  }
  return jiraNativeId(args.schemeId)
    ? {
        path: `issuetypescheme/${args.schemeId}${name === "jira.issue-type-scheme-projects" ? "/associations" : ""}`,
        schemeId: args.schemeId,
        startAt,
        maxResults,
      }
    : undefined;
}
function details(
  raw: Record<string, unknown>,
  booleanField?: "subtask" | "archived",
): CatalogJsonObject | undefined {
  const result: Record<string, string | boolean> = {};
  if (raw.description !== undefined && raw.description !== null) {
    if (!jiraNativeText(raw.description, 32768, true)) return undefined;
    result.description = raw.description;
  }
  const flag = booleanField === undefined ? undefined : raw[booleanField];
  if (flag !== undefined && flag !== null) {
    if (typeof flag !== "boolean" || booleanField === undefined) return undefined;
    result[booleanField] = flag;
  }
  return result;
}
function issueType(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (!jiraNativeId(raw?.id) || !jiraNativeText(raw.name, 255)) return undefined;
  const optional = details(raw, "subtask");
  return optional === undefined ? undefined : { id: raw.id, name: raw.name, ...optional };
}
function schemeMetadata(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, readonly CatalogJsonObject[] | CatalogJsonObject> = {};
  if (raw.issueTypes !== undefined && raw.issueTypes !== null) {
    if (!Array.isArray(raw.issueTypes)) return undefined;
    const items = projectJiraCollection(
      raw.issueTypes,
      TOOL_CATALOG_LIMITS.maxArrayItems,
      issueType,
      "id",
    );
    if (items === undefined) return undefined;
    result.issueTypes = items;
  }
  if (raw.defaultIssueType !== undefined && raw.defaultIssueType !== null) {
    const selected = issueType(raw.defaultIssueType);
    if (selected === undefined) return undefined;
    result.defaultIssueType = selected;
  }
  return result;
}
function scheme(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (!jiraNativeId(raw?.id) || !jiraNativeText(raw.name, 255)) return undefined;
  const optional = details(raw);
  const metadata = schemeMetadata(raw);
  return optional === undefined || metadata === undefined
    ? undefined
    : { id: raw.id, name: raw.name, ...optional, ...metadata };
}
function project(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    !jiraNativeId(raw?.id) ||
    !isSafeAtlassianIdentifier(raw.key) ||
    !jiraNativeText(raw.name, 255)
  )
    return undefined;
  const optional = details(raw, "archived");
  return optional === undefined
    ? undefined
    : { id: raw.id, key: raw.key, name: raw.name, ...optional };
}
function collection(
  values: unknown,
  selected: Selection,
  projector: (value: unknown) => CatalogJsonObject | undefined,
): ManagedMcpToolResult {
  if (!Array.isArray(values)) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, projector, "id");
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({
    data: {
      ...page.data,
      ...(selected.schemeId === undefined ? {} : { schemeId: selected.schemeId }),
    },
  });
}
/** Native administration reads only; upstream permissions remain authoritative and no associations change. */
export async function executeJiraIssueTypeSchemeRead(
  name: Read,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const projects = name === "jira.issue-type-scheme-projects";
  const response = projects
    ? await request(selected.path, "GET", undefined, "json-array")
    : await request(selected.path);
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  if (projects) return collection(response.items, selected, project);
  if (name === "jira.issue-type-schemes")
    return collection(response.body?.schemes, selected, scheme);
  if (response.body?.id !== selected.schemeId) return jiraReadFailure("conflict");
  return collection([response.body], selected, scheme);
}
