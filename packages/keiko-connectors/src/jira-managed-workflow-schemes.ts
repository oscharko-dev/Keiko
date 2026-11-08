import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import {
  jiraWorkflowSchemeMappings as mappings,
  jiraWorkflowSchemeReviewSnapshot,
} from "./jira-workflow-scheme-values.js";

const OPERATIONS = {
  "jira.workflow-scheme": { kind: "scheme", draft: false },
  "jira.workflow-scheme-draft": { kind: "scheme", draft: true },
  "jira.workflow-scheme-default": { kind: "default", draft: false },
  "jira.workflow-scheme-draft-default": { kind: "default", draft: true },
  "jira.workflow-scheme-issue-type": { kind: "issue-type", draft: false },
  "jira.workflow-scheme-draft-issue-type": { kind: "issue-type", draft: true },
  "jira.workflow-scheme-workflows": { kind: "workflows", draft: false },
  "jira.workflow-scheme-draft-workflows": { kind: "workflows", draft: true },
} as const;
type Operation = keyof typeof OPERATIONS;
type Kind = (typeof OPERATIONS)[Operation]["kind"];
interface Selection {
  readonly schemeId: string;
  readonly issueTypeId?: string;
  readonly workflowName?: string;
  readonly kind: Kind;
  readonly draft: boolean;
  readonly returnDraft: boolean;
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
}
const MAX_NATIVE = TOOL_CATALOG_LIMITS.maxArrayItems;
export function isJiraWorkflowSchemeRead(name: string): name is Operation {
  return Object.hasOwn(OPERATIONS, name);
}
function page(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}
function allowedKeys(kind: Kind, draft: boolean): ReadonlySet<string> {
  const keys = new Set(["schemeId"]);
  if (!draft) keys.add("returnDraftIfExists");
  if (kind === "scheme" || kind === "workflows") {
    keys.add("startAt");
    keys.add("maxResults");
  }
  if (kind === "issue-type") keys.add("issueTypeId");
  if (kind === "workflows") keys.add("workflowName");
  return keys;
}
function extraSelectors(kind: Kind, args: CatalogJsonObject): boolean {
  return (
    (kind !== "issue-type" || jiraNativeId(args.issueTypeId)) &&
    (!Object.hasOwn(args, "workflowName") || jiraNativeText(args.workflowName, 255)) &&
    (!Object.hasOwn(args, "returnDraftIfExists") || typeof args.returnDraftIfExists === "boolean")
  );
}
function nativePath(base: string, kind: Kind, args: CatalogJsonObject): string {
  if (kind === "default") return `${base}/default`;
  if (kind === "issue-type" && typeof args.issueTypeId === "string")
    return `${base}/issuetype/${args.issueTypeId}`;
  return kind === "workflows" ? `${base}/workflow` : base;
}
function nativeQuery(args: CatalogJsonObject): string {
  const query = new URLSearchParams();
  if (typeof args.workflowName === "string") query.set("workflowName", args.workflowName);
  if (typeof args.returnDraftIfExists === "boolean")
    query.set("returnDraftIfExists", String(args.returnDraftIfExists));
  return query.size === 0 ? "" : `?${query.toString()}`;
}
function selection(operation: Operation, args: CatalogJsonObject): Selection | undefined {
  const { kind, draft } = OPERATIONS[operation];
  const allowed = allowedKeys(kind, draft);
  if (
    !jiraNativeId(args.schemeId) ||
    Object.keys(args).some((key) => !allowed.has(key)) ||
    !extraSelectors(kind, args)
  )
    return undefined;
  const startAt = page(args.startAt, 0, 0, 1_000_000);
  const maxResults = page(args.maxResults, 25, 1, 100);
  if (startAt === undefined || maxResults === undefined) return undefined;
  const base = `workflowscheme/${args.schemeId}${draft ? "/draft" : ""}`;
  return {
    schemeId: args.schemeId,
    kind,
    draft,
    returnDraft: args.returnDraftIfExists === true,
    startAt,
    maxResults,
    path: nativePath(base, kind, args) + nativeQuery(args),
    ...(typeof args.issueTypeId === "string" ? { issueTypeId: args.issueTypeId } : {}),
    ...(typeof args.workflowName === "string" ? { workflowName: args.workflowName } : {}),
  };
}
function nativeId(value: unknown): string | undefined {
  if (jiraNativeId(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : undefined;
}
function optionalText(
  raw: Record<string, unknown>,
  fields: Readonly<Record<string, number>>,
): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const [key, max] of Object.entries(fields)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (!jiraNativeText(value, max, true)) return undefined;
    result[key] = value;
  }
  return result;
}
function schemeMappings(raw: Record<string, unknown>): readonly CatalogJsonObject[] | undefined {
  const current = mappings(raw.issueTypeMappings ?? {});
  const original = mappings(raw.originalIssueTypeMappings ?? {});
  if (current === undefined || original === undefined) return undefined;
  const keys = [...new Set([...current.keys(), ...original.keys()])].sort(compareStrings);
  if (keys.length > MAX_NATIVE) return undefined;
  return keys.map((issueTypeId) => {
    const workflow = current.get(issueTypeId);
    const originalWorkflow = original.get(issueTypeId);
    return {
      issueTypeId,
      ...(workflow === undefined ? {} : { workflow }),
      ...(originalWorkflow === undefined ? {} : { originalWorkflow }),
    };
  });
}
function schemeIdentityMatches(
  raw: Record<string, unknown>,
  id: string,
  selected: Pick<Selection, "draft" | "returnDraft" | "schemeId">,
): boolean {
  if (selected.draft) return raw.draft !== false;
  if (raw.draft === true) return selected.returnDraft;
  return id === selected.schemeId;
}
function draftFlagValid(raw: Record<string, unknown>): boolean {
  return raw.draft === undefined || raw.draft === null || typeof raw.draft === "boolean";
}
function hasMappings(raw: Record<string, unknown>): boolean {
  return [raw.issueTypeMappings, raw.originalIssueTypeMappings].some(
    (value) => value !== undefined && value !== null,
  );
}
export function jiraWorkflowSchemeResult(
  raw: Record<string, unknown>,
  selected: Pick<Selection, "draft" | "returnDraft" | "schemeId" | "startAt" | "maxResults">,
): ManagedMcpToolResult {
  const id = nativeId(raw.id);
  const text = optionalText(raw, {
    name: 255,
    description: 32768,
    defaultWorkflow: 255,
    originalDefaultWorkflow: 255,
    lastModified: 128,
  });
  if (id === undefined || text === undefined || !draftFlagValid(raw))
    return jiraReadFailure("malformed-payload");
  if (!schemeIdentityMatches(raw, id, selected)) return jiraReadFailure("malformed-payload");
  const reviewSnapshot = jiraWorkflowSchemeReviewSnapshot(raw);
  const data: CatalogJsonObject = {
    outcome: "succeeded",
    schemeId: selected.schemeId,
    id,
    ...text,
    ...(typeof raw.draft === "boolean" ? { draft: raw.draft } : {}),
    ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
  };
  if (!hasMappings(raw)) return boundJiraReadResult({ data });
  const items = schemeMappings(raw);
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({
        data: { ...data, ...localJiraPage(items, selected.startAt, selected.maxResults).data },
      });
}
function mappingIssueTypes(value: unknown): CatalogJsonObject | undefined {
  if (value === undefined || value === null) return {};
  const ids = asArray(value);
  if (
    ids === undefined ||
    ids.length > MAX_NATIVE ||
    !ids.every(jiraNativeId) ||
    new Set(ids).size !== ids.length
  )
    return undefined;
  return { issueTypeIds: ids };
}
function workflowMapping(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (!jiraNativeText(raw?.workflow, 255)) return undefined;
  const result: Record<string, CatalogJsonValue> = { workflow: raw.workflow };
  if (raw.defaultMapping !== undefined && raw.defaultMapping !== null) {
    if (typeof raw.defaultMapping !== "boolean") return undefined;
    result.defaultMapping = raw.defaultMapping;
  }
  const issueTypes = mappingIssueTypes(raw.issueTypes);
  return issueTypes === undefined ? undefined : { ...result, ...issueTypes };
}
function workflowsResult(values: readonly unknown[], selected: Selection): ManagedMcpToolResult {
  if (values.length > MAX_NATIVE) return jiraReadFailure("bounds-exceeded");
  const projected = values.map(workflowMapping);
  if (projected.includes(undefined)) return jiraReadFailure("malformed-payload");
  const items = projected.filter((item) => item !== undefined);
  if (
    new Set(items.map((item) => item.workflow)).size !== items.length ||
    (selected.workflowName !== undefined && items[0]?.workflow !== selected.workflowName)
  )
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: {
      ...localJiraPage(items, selected.startAt, selected.maxResults).data,
      schemeId: selected.schemeId,
    },
  });
}
function scalarResult(raw: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  if (
    !jiraNativeText(raw.workflow, 255) ||
    (selected.kind === "issue-type" && raw.issueType !== selected.issueTypeId)
  )
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      schemeId: selected.schemeId,
      workflow: raw.workflow,
      ...(selected.issueTypeId === undefined ? {} : { issueTypeId: selected.issueTypeId }),
    },
  });
}
function projectResponse(
  response: Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>,
  selected: Selection,
  array: boolean,
): ManagedMcpToolResult {
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  if (array)
    return response.items === undefined
      ? jiraReadFailure("malformed-payload")
      : workflowsResult(response.items, selected);
  if (response.body === undefined) return jiraReadFailure("malformed-payload");
  if (selected.kind === "scheme") return jiraWorkflowSchemeResult(response.body, selected);
  return selected.kind === "workflows"
    ? workflowsResult([response.body], selected)
    : scalarResult(response.body, selected);
}
/** Published scheme reads only; administrative permission/websudo failures never trigger escalation. */
export async function executeJiraWorkflowSchemeRead(
  operation: Operation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(operation, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const array = selected.kind === "workflows" && selected.workflowName === undefined;
  const response = await request(selected.path, "GET", undefined, array ? "json-array" : "json");
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  return projectResponse(response, selected, array);
}
