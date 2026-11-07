import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraAccessSchemeBoundsExceeded } from "./jira-managed-access-schemes.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, projectJiraCollection, remoteJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraPrioritySchemeProjection } from "./jira-managed-project-associations.js";
import { executeJiraSelectedRead, selectJiraReadPage, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId } from "./jira-native-values.js";

export const JIRA_PRIORITY_SCHEME_READS = JIRA_READ_TOOL_FAMILIES.prioritySchemes;
type PriorityRead = (typeof JIRA_PRIORITY_SCHEME_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_PRIORITY_SCHEME_READS);
interface Selection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
  readonly schemeId?: string;
}
function selection(name: PriorityRead, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, new Set(name === "jira.priority-schemes" ? ["startAt", "maxResults"] : ["schemeId"]));
  if (page === undefined) return undefined;
  if (name === "jira.priority-schemes") return { ...page,
    path: `priorityschemes?${new URLSearchParams({ startAt: String(page.startAt), maxResults: String(page.maxResults) }).toString()}` };
  return jiraNativeId(args.schemeId) ? { ...page, path: `priorityschemes/${args.schemeId}`, schemeId: args.schemeId } : undefined;
}
function exceedsBounds(value: unknown): boolean {
  const options = asArray(asRecord(value)?.optionIds);
  return jiraAccessSchemeBoundsExceeded(value) || (options !== undefined && options.length > TOOL_CATALOG_LIMITS.maxArrayItems);
}
function project(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw === undefined ? undefined : jiraPrioritySchemeProjection(raw);
}
function single(body: Record<string, unknown>, schemeId: string): ManagedMcpToolResult {
  if (exceedsBounds(body)) return jiraReadFailure("bounds-exceeded");
  const item = project(body);
  return item?.id !== schemeId ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", ...item } });
}
function total(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}
function page(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const values = asArray(body.schemes);
  if (values === undefined || !total(body.total))
    return jiraReadFailure("malformed-payload");
  if (values.length > selected.maxResults || values.some(exceedsBounds)) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, selected.maxResults, project, "id");
  // This native envelope supplies a total and no isLast. Retain its actual offset and page-size checks.
  return boundJiraReadResult(remoteJiraPage({ startAt: body.startAt, maxResults: body.maxResults,
    total: body.total, isLast: selected.startAt + values.length >= body.total }, items, selected.startAt, selected.maxResults));
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  return selected.schemeId === undefined ? page(body, selected) : single(body, selected.schemeId);
}
export function isJiraPrioritySchemeRead(name: string): name is PriorityRead { return READS.has(name); }
/** Global scheme configuration only; no project expansion, association mutation or inferred issue defaults. */
export function executeJiraPrioritySchemeRead(name: PriorityRead, args: CatalogJsonObject, request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(selection(name, args), request, "json", projectResponse);
}
