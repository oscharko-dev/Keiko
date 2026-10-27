import {
  jiraSelectedFieldValues,
  jiraProjectionBytes,
  jiraProjectionTextFits,
} from "./jira-managed-field-reads.js";
import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraReadFailure, remoteJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";

export const JIRA_MANAGED_ISSUE_FIELDS =
  "summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated";
export const JIRA_MANAGED_SEARCH_FIELDS =
  "summary,status,issuetype,project,assignee,priority,labels,created,updated";
// Reserve the complete catalog envelope (fixed Jira reference, bounded invocation/digest,
// metrics and a cursor-free page). The unchanged catalog cap still validates the final envelope.
const ISSUE_DATA_MAX_BYTES = TOOL_CATALOG_LIMITS.maxResultBytes - 4096;
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
function reference(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const output: Record<string, string> = {};
  for (const key of ["id", "key", "name", "displayName"] as const) {
    if (text(raw[key], 256)) output[key] = raw[key];
  }
  return Object.keys(output).length === 0 ? undefined : output;
}
function referenceDetails(
  fields: Record<string, unknown>,
  details: boolean,
): Record<string, CatalogJsonObject | string | readonly string[] | boolean> {
  const result: Record<string, CatalogJsonObject | string | readonly string[] | boolean> = {};
  for (const key of [
    "status",
    "issuetype",
    "project",
    "assignee",
    "priority",
    ...(details ? ["reporter"] : []),
  ]) {
    const value = reference(fields[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["created", "updated", ...(details ? ["duedate"] : [])]) {
    if (text(fields[key], 64)) result[key] = fields[key];
  }
  return result;
}
function issueDetails(
  fields: Record<string, unknown>,
  includeDescription: boolean,
): CatalogJsonObject | undefined {
  const result = referenceDetails(fields, includeDescription);
  if (fields.assignee === null) result.assigneeEmpty = true;
  if (includeDescription && fields.description !== undefined) {
    const description = fields.description ?? "";
    if (!text(description, 32768)) return undefined;
    result.description = description;
  }
  if (fields.labels !== undefined) {
    const labels = asArray(fields.labels);
    if (labels === undefined || labels.length > 100 || !labels.every((value) => text(value, 255)))
      return undefined;
    result.labels = labels;
  }
  return result;
}
function issue(value: unknown, includeDescription: boolean): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const fields = asRecord(raw?.fields);
  if (
    raw === undefined ||
    fields === undefined ||
    !isSafeAtlassianIdentifier(raw.id) ||
    !isSafeAtlassianIdentifier(raw.key) ||
    !text(fields.summary, 255)
  )
    return undefined;
  const details = issueDetails(fields, includeDescription);
  return details === undefined
    ? undefined
    : { id: raw.id, key: raw.key, summary: fields.summary, ...details };
}
function comment(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !isSafeAtlassianIdentifier(raw.id) ||
    !text(raw.body, 32768) ||
    !text(raw.created, 64)
  )
    return undefined;
  const author = reference(raw.author);
  return {
    id: raw.id,
    body: raw.body,
    created: raw.created,
    ...(author === undefined ? {} : { author }),
  };
}
function items(
  value: unknown,
  project: (value: unknown) => CatalogJsonObject | undefined,
): readonly CatalogJsonObject[] | undefined {
  const values = asArray(value);
  return values === undefined ? undefined : projectJiraCollection(values, 100, project, "id");
}
function page(
  body: Record<string, unknown>,
  values: readonly CatalogJsonObject[] | undefined,
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  if (body.total !== undefined && typeof body.total !== "number")
    return jiraReadFailure("malformed-payload");
  return remoteJiraPage(
    {
      start: body.startAt,
      size: body.maxResults,
      total: body.total,
      last:
        typeof body.total === "number"
          ? startAt + (values?.length ?? 0) >= body.total
          : values?.length === 0,
    },
    values,
    startAt,
    maxResults,
  );
}
function singleIssueData(value: CatalogJsonObject): CatalogJsonObject {
  return { outcome: "succeeded", items: [value], startAt: 0, total: 1 };
}
function singleIssueResult(
  body: Record<string, unknown>,
  selected: readonly string[],
): ManagedMcpToolResult {
  let value = issue(body, true);
  if (value === undefined) return jiraReadFailure("malformed-payload");
  if (typeof value.description === "string" && !jiraProjectionTextFits(value.description))
    return jiraReadFailure("bounds-exceeded");
  if (selected.length > 0) {
    const baseBytes = jiraProjectionBytes(singleIssueData({ ...value, fieldValues: [] })) - 2;
    const fields = jiraSelectedFieldValues(body, selected, ISSUE_DATA_MAX_BYTES - baseBytes);
    if (fields === undefined) return jiraReadFailure("bounds-exceeded");
    value = { ...value, fieldValues: fields };
  }
  const data = singleIssueData(value);
  return jiraProjectionBytes(data) <= ISSUE_DATA_MAX_BYTES
    ? { data }
    : jiraReadFailure("bounds-exceeded");
}
export function jiraIssueReadResult(
  name: string,
  body: Record<string, unknown>,
  startAt: number,
  maxResults: number,
  selectedFields: readonly string[] = [],
): ManagedMcpToolResult {
  if (name === "jira.issue") return singleIssueResult(body, selectedFields);
  return name === "jira.search"
    ? page(
        body,
        items(body.issues, (value) => issue(value, false)),
        startAt,
        maxResults,
      )
    : page(body, items(body.comments, comment), startAt, maxResults);
}
