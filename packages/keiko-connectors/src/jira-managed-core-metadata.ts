import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray } from "./atlassian-sync-classify.js";
import {
  jiraCoreMetadataExceedsBounds,
  jiraCoreMetadataProjection,
  type JiraCoreMetadataKind,
} from "./jira-core-metadata-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeName, jiraNativeText } from "./jira-native-values.js";

export const JIRA_CORE_METADATA_READS = [
  "jira.global-issue-types", "jira.issue-type", "jira.issue-type-page", "jira.issue-type-alternatives",
  "jira.priorities", "jira.priority", "jira.priority-page",
  "jira.resolutions", "jira.resolution", "jira.resolution-page",
  "jira.statuses", "jira.status", "jira.status-page",
  "jira.status-categories", "jira.status-category",
  "jira.project-categories", "jira.project-category", "jira.project-statuses",
  "jira.project-types", "jira.project-type-definition",
] as const;
type CoreRead = (typeof JIRA_CORE_METADATA_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_CORE_METADATA_READS);
type Mode = "local" | "page" | "single" | "project";
type Argument = "issueTypeId" | "priorityId" | "resolutionId" | "statusIdOrName" |
  "statusCategoryIdOrKey" | "projectCategoryId" | "projectTypeKey" | "projectIdOrKey";
interface Definition {
  readonly path: string;
  readonly kind: JiraCoreMetadataKind;
  readonly mode: Mode;
  readonly argument?: Argument;
  readonly suffix?: string;
  readonly filters?: readonly ("projectIds" | "issueTypeIds")[];
}
const DEFINITIONS: Readonly<Record<CoreRead, Definition>> = {
  "jira.global-issue-types": { path: "issuetype", kind: "issue-type", mode: "local" },
  "jira.issue-type": { path: "issuetype", kind: "issue-type", mode: "single", argument: "issueTypeId" },
  "jira.issue-type-page": { path: "issuetype/page", kind: "issue-type", mode: "page", filters: ["projectIds"] },
  "jira.issue-type-alternatives": { path: "issuetype", kind: "issue-type", mode: "local", argument: "issueTypeId", suffix: "/alternatives" },
  "jira.priorities": { path: "priority", kind: "priority", mode: "local" },
  "jira.priority": { path: "priority", kind: "priority", mode: "single", argument: "priorityId" },
  "jira.priority-page": { path: "priority/page", kind: "priority", mode: "page", filters: ["projectIds"] },
  "jira.resolutions": { path: "resolution", kind: "resolution", mode: "local" },
  "jira.resolution": { path: "resolution", kind: "resolution", mode: "single", argument: "resolutionId" },
  "jira.resolution-page": { path: "resolution/page", kind: "resolution", mode: "page" },
  "jira.statuses": { path: "status", kind: "status", mode: "local" },
  "jira.status": { path: "status", kind: "status", mode: "single", argument: "statusIdOrName" },
  "jira.status-page": { path: "status/page", kind: "status", mode: "page", filters: ["projectIds", "issueTypeIds"] },
  "jira.status-categories": { path: "statuscategory", kind: "status-category", mode: "local" },
  "jira.status-category": { path: "statuscategory", kind: "status-category", mode: "single", argument: "statusCategoryIdOrKey" },
  "jira.project-categories": { path: "projectCategory", kind: "project-category", mode: "local" },
  "jira.project-category": { path: "projectCategory", kind: "project-category", mode: "single", argument: "projectCategoryId" },
  "jira.project-statuses": { path: "project", kind: "project-statuses", mode: "project", argument: "projectIdOrKey" },
  "jira.project-types": { path: "project/type", kind: "project-type", mode: "local" },
  "jira.project-type-definition": { path: "project/type", kind: "project-type", mode: "single", argument: "projectTypeKey" },
};
interface Selection extends Definition {
  readonly startAt: number;
  readonly maxResults: number;
  readonly target?: string;
  readonly context?: CatalogJsonObject;
}
function coordinate(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : undefined;
}
function targetValid(argument: Argument, value: unknown): value is string {
  if (argument === "statusIdOrName") return jiraNativeName(value, 255) &&
    !/[\/\\\r\n\t]/u.test(value) && value !== "." && value !== "..";
  if (argument === "statusCategoryIdOrKey" || argument === "projectTypeKey" || argument === "projectIdOrKey")
    return isSafeAtlassianIdentifier(value);
  return jiraNativeId(value);
}
function pageQuery(definition: Definition, args: CatalogJsonObject, startAt: number, maxResults: number): string | undefined {
  const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) });
  if (args.query !== undefined) {
    if (!jiraNativeText(args.query, 255, true)) return undefined;
    query.set("query", args.query);
  }
  for (const field of definition.filters ?? []) {
    const value = args[field];
    if (value === undefined) continue;
    const ids = asArray(value);
    if (ids === undefined || ids.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
      !ids.every(jiraNativeId) || new Set(ids).size !== ids.length) return undefined;
    for (const id of ids) query.append(field, id);
  }
  return query.toString();
}
function select(name: CoreRead, args: CatalogJsonObject): Selection | undefined {
  const definition = DEFINITIONS[name];
  const allowed = new Set<string>(definition.mode === "single" ? [] : ["startAt", "maxResults"]);
  if (definition.argument !== undefined) allowed.add(definition.argument);
  if (definition.mode === "page") {
    allowed.add("query");
    for (const field of definition.filters ?? []) allowed.add(field);
  }
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const startAt = coordinate(args.startAt, 0, 0, 1_000_000);
  const maxResults = coordinate(args.maxResults, 25, 1, 100);
  if (startAt === undefined || maxResults === undefined) return undefined;
  let path = definition.path;
  let target: string | undefined;
  if (definition.argument !== undefined) {
    const value = args[definition.argument];
    if (!targetValid(definition.argument, value)) return undefined;
    target = value;
    path += `/${encodeURIComponent(value)}${definition.suffix ?? ""}`;
  }
  if (definition.mode === "page") {
    const query = pageQuery(definition, args, startAt, maxResults);
    if (query === undefined) return undefined;
    path += `?${query}`;
  }
  return { ...definition, path, startAt, maxResults,
    ...(target === undefined ? {} : { target }) };
}
function identityMatches(item: CatalogJsonObject, selected: Selection): boolean {
  const target = selected.target;
  if (target === undefined) return false;
  if (selected.kind === "resolution") return item.id === undefined || item.id === target;
  if (selected.kind === "project-type") return item.key === target;
  if (selected.kind === "status" && !jiraNativeId(target)) return item.name === target;
  if (selected.kind === "status-category" && !jiraNativeId(target)) return item.key === target;
  return item.id === target;
}
function context(selected: Selection): CatalogJsonObject {
  if (selected.context !== undefined) return selected.context;
  if (selected.kind === "resolution" && selected.mode === "single") return { resolutionId: selected.target ?? "" };
  return selected.argument === "issueTypeId" && selected.mode === "local"
    ? { issueTypeId: selected.target ?? "" } : {};
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.mode === "single") {
    if (jiraCoreMetadataExceedsBounds(selected.kind, response.body)) return jiraReadFailure("bounds-exceeded");
    const item = jiraCoreMetadataProjection(selected.kind, response.body);
    return item === undefined || !identityMatches(item, selected) ? jiraReadFailure("malformed-payload")
      : boundJiraReadResult({ data: { outcome: "succeeded", ...item, ...context(selected) } });
  }
  const values = selected.mode === "page" ? asArray(response.body?.values) : response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  const maximum = selected.mode === "page" ? selected.maxResults : TOOL_CATALOG_LIMITS.maxArrayItems;
  if (values.length > maximum || values.some((value) => jiraCoreMetadataExceedsBounds(selected.kind, value)))
    return jiraReadFailure("bounds-exceeded");
  const identity = selected.kind === "project-type" ? "key" : selected.kind === "resolution" ? "name" : "id";
  const items = projectJiraCollection(values, maximum, (value) => jiraCoreMetadataProjection(selected.kind, value), identity);
  if (items === undefined) return jiraReadFailure("malformed-payload");
  if (selected.kind === "resolution") {
    const ids = items.flatMap((item) => typeof item.id === "string" ? [item.id] : []);
    if (new Set(ids).size !== ids.length) return jiraReadFailure("malformed-payload");
  }
  const result = selected.mode === "page"
    ? remoteJiraPage({ ...response.body, ...(response.body?.total === null ? { total: undefined } : {}) }, items, selected.startAt, selected.maxResults)
    : localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ ...result, data: { ...result.data, ...context(selected) } });
}
export function isJiraCoreMetadataRead(name: string): name is CoreRead {
  return READS.has(name);
}
/** The closed operation selects every route; callers never supply paths, expansions or headers. */
export async function executeJiraCoreMetadataRead(
  name: CoreRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  let selected = select(name, args);
  if (selected?.mode === "project") {
    const project = await readJiraBoundProject(request, selected.target ?? "");
    if (!project.ok) return jiraReadFailure(project.reason, project.detail);
    selected = { ...selected, path: `project/${project.project.projectId}/statuses`,
      context: { projectId: project.project.projectId, projectKey: project.project.projectKey } };
  }
  return executeJiraSelectedRead(selected, request,
    selected?.mode === "single" || selected?.mode === "page" ? "json" : "json-array", projectResponse);
}
