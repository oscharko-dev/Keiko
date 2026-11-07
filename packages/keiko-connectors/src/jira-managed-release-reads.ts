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
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, remoteJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraVersionSummary } from "./jira-managed-versions.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

export const JIRA_RELEASE_READS = JIRA_READ_TOOL_FAMILIES.release;
type ReleaseRead = (typeof JIRA_RELEASE_READS)[number];
type CountRead = Exclude<ReleaseRead, "jira.project-version-page">;
const READS: ReadonlySet<string> = new Set(JIRA_RELEASE_READS);
const COUNTS: Readonly<Record<CountRead, {
  readonly argument: "componentId" | "versionId";
  readonly resource: "component" | "version";
  readonly suffix: "relatedIssueCounts" | "unresolvedIssueCount";
  readonly fields: readonly string[];
}>> = {
  "jira.component-related-issue-counts": {
    argument: "componentId", resource: "component", suffix: "relatedIssueCounts", fields: ["issueCount"],
  },
  "jira.version-related-issue-counts": {
    argument: "versionId", resource: "version", suffix: "relatedIssueCounts",
    fields: ["issuesAffectedCount", "issuesFixedCount", "issueCountWithCustomFieldsShowingVersion"],
  },
  "jira.version-unresolved-issue-count": {
    argument: "versionId", resource: "version", suffix: "unresolvedIssueCount", fields: ["issuesUnresolvedCount"],
  },
};
const PAGE_ARGUMENTS: ReadonlySet<string> = new Set(["projectIdOrKey", "startAt", "maxResults", "orderBy"]);
export const JIRA_PROJECT_VERSION_ORDERS = [
  "sequence", "+sequence", "-sequence", "name", "+name", "-name",
  "startDate", "+startDate", "-startDate", "releaseDate", "+releaseDate", "-releaseDate",
] as const;
const ORDERS: ReadonlySet<string> = new Set(JIRA_PROJECT_VERSION_ORDERS);
interface CountSelection {
  readonly path: string;
  readonly resourcePath: string;
  readonly resourceId: string;
  readonly argument: "componentId" | "versionId";
  readonly fields: readonly string[];
  readonly customFields: boolean;
}
interface PageSelection extends JiraReadPageSelection {
  readonly path: string;
  readonly projectId: string;
  readonly projectKey: string;
}
function countSelection(name: CountRead, args: CatalogJsonObject): CountSelection | undefined {
  const definition = COUNTS[name];
  const resourceId = args[definition.argument];
  if (Object.keys(args).some((key) => key !== definition.argument) || !jiraNativeId(resourceId))
    return undefined;
  const resourcePath = `${definition.resource}/${resourceId}`;
  return {
    path: `${resourcePath}/${definition.suffix}`,
    resourcePath, resourceId, argument: definition.argument, fields: definition.fields,
    customFields: name === "jira.version-related-issue-counts",
  };
}
function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nativeCounts(raw: Record<string, unknown>, fields: readonly string[]): CatalogJsonObject | undefined {
  const counts: Record<string, CatalogJsonValue> = {};
  for (const field of fields) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!validCount(value)) return undefined;
    counts[field] = value;
  }
  return counts;
}
function unsafeCount(raw: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => {
    const value = raw[field];
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) &&
      value > Number.MAX_SAFE_INTEGER;
  });
}
function fieldUsage(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const customFieldId = jiraNativeNumericId(raw?.customFieldId);
  if (raw === undefined || customFieldId === undefined || !jiraNativeText(raw.fieldName, 255))
    return undefined;
  const counts = nativeCounts(raw, ["issueCountWithVersionInCustomField"]);
  return counts === undefined ? undefined : { customFieldId, fieldName: raw.fieldName, ...counts };
}
function customUsage(body: Record<string, unknown>): ManagedMcpToolResult {
  if (body.customFieldNames === undefined || body.customFieldNames === null) return { data: {} };
  const values = asArray(body.customFieldNames);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some((value) => {
    const raw = asRecord(value);
    return raw !== undefined && unsafeCount(raw, ["issueCountWithVersionInCustomField"]);
  })) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = fieldUsage(value);
    if (item === undefined || typeof item.customFieldId !== "string" || seen.has(item.customFieldId))
      return jiraReadFailure("malformed-payload");
    seen.add(item.customFieldId);
    items.push(item);
  }
  return { data: { customFieldNames: items } };
}
function countResponse(response: JiraReadResponse, selected: CountSelection): ManagedMcpToolResult {
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  // A supplied self is comparison-only: its proxy origin is not an execution destination.
  if (body.self !== undefined && body.self !== null &&
    !jiraResourceSelfMatches(body.self, selected.resourcePath)) return jiraReadFailure("conflict");
  if (unsafeCount(body, selected.fields)) return jiraReadFailure("bounds-exceeded");
  const counts = nativeCounts(body, selected.fields);
  if (counts === undefined) return jiraReadFailure("malformed-payload");
  const usage: ManagedMcpToolResult = selected.customFields ? customUsage(body) : { data: {} };
  if (usage.isError) return usage;
  return boundJiraReadResult({ data: {
    outcome: "succeeded", [selected.argument]: selected.resourceId,
    countScope: "jira-response", ...counts, ...usage.data,
  } });
}
function projectVersion(value: unknown, projectId: string): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const summary = jiraVersionSummary(value);
  if (raw === undefined || summary === undefined) return undefined;
  const nativeProjectId = raw.projectId;
  if (nativeProjectId === undefined || nativeProjectId === null) return summary;
  // VersionBean.projectId is a JSON integer, not a key, string selector or rounded number.
  return typeof nativeProjectId === "number" && Number.isSafeInteger(nativeProjectId) &&
    String(nativeProjectId) === projectId
    ? { ...summary, projectId }
    : undefined;
}
function pageResponse(response: JiraReadResponse, selected: PageSelection): ManagedMcpToolResult {
  const body = response.body;
  const values = asArray(body?.values);
  if (body === undefined || values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > selected.maxResults) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const item = projectVersion(value, selected.projectId);
    if (item === undefined || typeof item.versionId !== "string" || ids.has(item.versionId))
      return jiraReadFailure("malformed-payload");
    ids.add(item.versionId);
    items.push(item);
  }
  const page = remoteJiraPage(
    body.total === null ? { ...body, total: undefined } : body,
    items, selected.startAt, selected.maxResults,
  );
  return boundJiraReadResult({ ...page, data: {
    ...page.data, projectId: selected.projectId, projectKey: selected.projectKey,
  } });
}
async function projectVersions(args: CatalogJsonObject, request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  const page = selectJiraReadPage(args, PAGE_ARGUMENTS);
  const target = args.projectIdOrKey;
  const orderBy = args.orderBy;
  if (page === undefined || !isSafeAtlassianIdentifier(target) ||
    (orderBy !== undefined && (typeof orderBy !== "string" || !ORDERS.has(orderBy))))
    return jiraReadFailure("invalid-input");
  const current = await readJiraBoundProject(request, target);
  if (!current.ok) return jiraReadFailure(current.reason, current.detail);
  const project = current.project;
  const query = new URLSearchParams({ startAt: String(page.startAt), maxResults: String(page.maxResults) });
  if (typeof orderBy === "string") query.set("orderBy", orderBy);
  return executeJiraSelectedRead({
    ...page, projectId: project.projectId, projectKey: project.projectKey,
    path: `project/${project.projectId}/version?${query.toString()}`,
  }, request, "json", pageResponse);
}
export function isJiraReleaseRead(name: string): name is ReleaseRead {
  return READS.has(name);
}
/** Native counts retain their own scope; none is an independent JQL/report reconciliation. */
export function executeJiraReleaseRead(
  name: ReleaseRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return name === "jira.project-version-page"
    ? projectVersions(args, request)
    : executeJiraSelectedRead(countSelection(name, args), request, "json", countResponse);
}
