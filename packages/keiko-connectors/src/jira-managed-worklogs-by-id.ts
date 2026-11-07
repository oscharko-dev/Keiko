import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { jiraWorklogProjection, resolveJiraWorklogIssue } from "./jira-managed-issue-details.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

export function isJiraWorklogsByIdRead(name: string): name is "jira.worklogs-by-id" {
  return name === "jira.worklogs-by-id";
}

function selectedIds(args: CatalogJsonObject): readonly string[] | undefined {
  if (Object.keys(args).some((key) => key !== "worklogIds")) return undefined;
  const ids = args.worklogIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return undefined;
  if (!ids.every((id): id is string => jiraNativeId(id) && Number.isSafeInteger(Number(id))))
    return undefined;
  return new Set(ids).size === ids.length ? [...ids] : undefined;
}

interface IssueReference { readonly id: string; readonly key: string }
interface ProjectionContext {
  readonly request: JiraMutationRequest;
  readonly requested: ReadonlySet<string>;
  readonly seen: Set<string>;
  readonly issues: Map<string, IssueReference>;
}
type RowResult = { readonly item: CatalogJsonObject } | { readonly failure: ManagedMcpToolResult };
async function projectWorklog(value: unknown, context: ProjectionContext): Promise<RowResult> {
  const raw = asRecord(value);
  if (!jiraNativeId(raw?.id) || !jiraNativeId(raw.issueId))
    return { failure: jiraReadFailure("malformed-payload") };
  if (!context.requested.has(raw.id) || context.seen.has(raw.id))
    return { failure: jiraReadFailure("conflict") };
  let issue = context.issues.get(raw.issueId);
  if (issue === undefined) {
    const bound = await resolveJiraWorklogIssue(context.request, raw.issueId);
    if (!bound.ok) return { failure: bound.result };
    issue = bound.issue;
    context.issues.set(issue.id, issue);
  }
  const item = jiraWorklogProjection(raw, issue);
  if (item === undefined) return { failure: jiraReadFailure("malformed-payload") };
  context.seen.add(raw.id);
  return { item };
}

/** Permission-filtered selection, not a project collection or evidence that missing IDs are absent. */
export async function executeJiraWorklogsByIdRead(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const ids = selectedIds(args);
  if (ids === undefined) return jiraReadFailure("invalid-input");
  const response = await request("worklog/list", "POST", { ids: ids.map(Number) }, "json-array");
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200 || !Array.isArray(response.items)) return jiraReadFailure("malformed-payload");
  if (response.items.length > ids.length) return jiraReadFailure("conflict");
  const context: ProjectionContext = {
    request, requested: new Set(ids), seen: new Set(), issues: new Map(),
  };
  const items: CatalogJsonObject[] = [];
  for (const row of response.items) {
    const projected = await projectWorklog(row, context);
    if ("failure" in projected) return projected.failure;
    items.push(projected.item);
  }
  return boundJiraReadResult({ data: {
    outcome: "succeeded", selectionScope: "native-visible-requested-worklogs",
    requestedCount: ids.length, returnedCount: items.length,
    unreturnedWorklogIds: ids.filter((id) => !context.seen.has(id)), items,
  } });
}
