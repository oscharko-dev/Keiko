import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraComponentSummary } from "./jira-managed-components.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { jiraIssueLinkTypeProjection } from "./jira-managed-issue-details.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraOptionalFields,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraVersionSummary } from "./jira-managed-versions.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_RESOURCE_LOOKUP_READS = JIRA_READ_TOOL_FAMILIES.resourceLookups;
type LookupRead = (typeof JIRA_RESOURCE_LOOKUP_READS)[number];
interface Definition {
  readonly path: string;
  readonly mode: "page" | "single" | "local";
  readonly identity: "id" | "versionId" | "key";
  readonly project: (value: unknown) => CatalogJsonObject | undefined;
}
interface Selection extends Definition {
  readonly startAt: number;
  readonly maxResults: number;
  readonly expectedId?: string;
}
const PAGE_ARGS = new Set(["startAt", "maxResults", "query", "projectIds"]);
const LOCAL_ARGS = new Set(["startAt", "maxResults"]);
function withProject(
  value: unknown,
  project: (value: unknown) => CatalogJsonObject | undefined,
): CatalogJsonObject | undefined {
  const summary = project(value);
  if (summary === undefined) return undefined;
  const raw = asRecord(value);
  const projectId = raw?.projectId;
  if (projectId === undefined || projectId === null) return summary;
  const observed = jiraNativeNumericId(projectId);
  return observed === undefined ? undefined : { ...summary, projectId: observed };
}
function accessibility(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.key, 255)) return undefined;
  const enabled = projectJiraOptionalFields(raw, ["enabled"], (value) =>
    typeof value === "boolean" ? value : undefined,
  );
  return enabled === undefined ? undefined : { key: raw.key, ...enabled };
}
const DEFINITIONS: Readonly<Record<LookupRead, Definition>> = {
  "jira.global-version-page": {
    path: "version",
    mode: "page",
    identity: "versionId",
    project: (value) => withProject(value, jiraVersionSummary),
  },
  "jira.component-page": {
    path: "component/page",
    mode: "page",
    identity: "id",
    project: (value) => withProject(value, jiraComponentSummary),
  },
  "jira.link-type": {
    path: "issueLinkType",
    mode: "single",
    identity: "id",
    project: jiraIssueLinkTypeProjection,
  },
  "jira.accessibility-settings": {
    path: "user/a11y/personal-settings",
    mode: "local",
    identity: "key",
    project: accessibility,
  },
};
function projectFilter(value: unknown, query: URLSearchParams): boolean {
  if (value === undefined) return true;
  const ids = asArray(value);
  if (ids === undefined || ids.length === 0 || ids.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return false;
  if (!ids.every(jiraNativeId) || new Set(ids).size !== ids.length) return false;
  // Official 11.3 resource signatures declare List<Long>/Set<Long>, not CSV or JSON query strings.
  for (const id of ids) query.append("projectIds", id);
  return true;
}
function pageSelection(definition: Definition, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, PAGE_ARGS);
  if (page === undefined) return undefined;
  const query = new URLSearchParams({
    startAt: String(page.startAt),
    maxResults: String(page.maxResults),
  });
  if (args.query !== undefined) {
    if (!jiraNativeText(args.query, 255, true)) return undefined;
    query.set("query", args.query);
  }
  return projectFilter(args.projectIds, query)
    ? { ...definition, ...page, path: `${definition.path}?${query.toString()}` }
    : undefined;
}
function selection(name: LookupRead, args: CatalogJsonObject): Selection | undefined {
  const definition = DEFINITIONS[name];
  if (definition.mode === "page") return pageSelection(definition, args);
  if (definition.mode === "single") {
    const page = selectJiraReadPage(args, new Set(["linkTypeId"]));
    return page !== undefined && jiraNativeId(args.linkTypeId)
      ? {
          ...definition,
          ...page,
          path: `${definition.path}/${args.linkTypeId}`,
          expectedId: args.linkTypeId,
        }
      : undefined;
  }
  const page = selectJiraReadPage(args, LOCAL_ARGS);
  return page === undefined ? undefined : { ...definition, ...page };
}
function exceedsBounds(value: unknown): boolean {
  const raw = asRecord(value);
  const description = raw?.description;
  if (
    typeof description === "string" &&
    (description.length > 32768 || !jiraProjectionTextFits(description))
  )
    return true;
  const projectId = raw?.projectId;
  return (
    typeof projectId === "number" && Number.isInteger(projectId) && !Number.isSafeInteger(projectId)
  );
}
type Rows =
  | { readonly ok: true; readonly items: readonly CatalogJsonObject[] }
  | { readonly ok: false; readonly reason: "malformed-payload" | "bounds-exceeded" };
function rows(values: readonly unknown[] | undefined, selected: Selection, max: number): Rows {
  if (values === undefined) return { ok: false, reason: "malformed-payload" };
  if (values.length > max) return { ok: false, reason: "bounds-exceeded" };
  if (selected.mode === "page" && values.some(exceedsBounds))
    return { ok: false, reason: "bounds-exceeded" };
  const items: CatalogJsonObject[] = [];
  const identities = new Set<string>();
  for (const value of values) {
    const item = selected.project(value);
    const identity = item?.[selected.identity];
    if (item === undefined || typeof identity !== "string" || identities.has(identity))
      return { ok: false, reason: "malformed-payload" };
    identities.add(identity);
    items.push(item);
  }
  return { ok: true, items };
}
function nativePage(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  const projected = rows(asArray(body.values), selected, selected.maxResults);
  if (!projected.ok) return jiraReadFailure(projected.reason);
  return boundJiraReadResult(
    remoteJiraPage(
      body.total === null ? { ...body, total: undefined } : body,
      projected.items,
      selected.startAt,
      selected.maxResults,
    ),
  );
}
function personalSettings(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const projected = rows(response.items, selected, TOOL_CATALOG_LIMITS.maxArrayItems);
  if (!projected.ok) return jiraReadFailure(projected.reason);
  const page = localJiraPage(projected.items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ ...page, data: { ...page.data, settingsScope: "connected-user" } });
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.mode === "page") return nativePage(response, selected);
  if (selected.mode === "local") return personalSettings(response, selected);
  if (selected.expectedId === undefined) return jiraReadFailure("malformed-payload");
  const item = selected.project(response.body);
  return item?.id !== selected.expectedId
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", ...item } });
}
export function isJiraResourceLookupRead(name: string): name is LookupRead {
  return Object.hasOwn(DEFINITIONS, name);
}
/** Native visible metadata and the connected actor's preferences, never writes or a generic resource path. */
export function executeJiraResourceLookupRead(
  name: LookupRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    selection(name, args),
    request,
    DEFINITIONS[name].mode === "local" ? "json-array" : "json",
    projectResponse,
  );
}
