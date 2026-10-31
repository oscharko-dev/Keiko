import { jiraBrowseUrl } from "./jira-browse-url.js";
import {
  jiraSelectedFieldValues,
  jiraProjectionBytes,
  jiraProjectionTextFits,
} from "./jira-managed-field-reads.js";
import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
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
// Each search result carries its own requested fields; a page of them stays a bounded fraction of
// the result, and the page boundary (`nextStartAt`) still resumes at the first unreturned issue.
const SEARCH_FIELD_VALUES_MAX_BYTES = 16384;
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
function issue(
  value: unknown,
  includeDescription: boolean,
  baseUrl: string,
): CatalogJsonObject | undefined {
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
  const browseUrl = jiraBrowseUrl(baseUrl, raw.key);
  return details === undefined || browseUrl === undefined
    ? undefined
    : {
        id: raw.id,
        key: raw.key,
        summary: fields.summary,
        browseUrl,
        ...details,
      };
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
/** A search result with the fields the caller asked for, typed by the instance's own names/schema. */
function searchIssue(
  value: unknown,
  body: Record<string, unknown>,
  selected: readonly string[],
  baseUrl: string,
): CatalogJsonObject | undefined {
  const summary = issue(value, false, baseUrl);
  if (summary === undefined || selected.length === 0) return summary;
  const fields = jiraSelectedFieldValues(
    { fields: asRecord(value)?.fields, names: body.names, schema: body.schema },
    selected,
    SEARCH_FIELD_VALUES_MAX_BYTES,
  );
  return fields === undefined ? undefined : { ...summary, fieldValues: fields };
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
  baseUrl: string,
): ManagedMcpToolResult {
  let value = issue(body, true, baseUrl);
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
  baseUrl: string,
  body: Record<string, unknown>,
  startAt: number,
  maxResults: number,
  selectedFields: readonly string[] = [],
): ManagedMcpToolResult {
  if (name === "jira.issue") return singleIssueResult(body, selectedFields, baseUrl);
  return name === "jira.search"
    ? page(
        body,
        items(body.issues, (value) => searchIssue(value, body, selectedFields, baseUrl)),
        startAt,
        maxResults,
      )
    : page(body, items(body.comments, comment), startAt, maxResults);
}

/** Retain a fitting prefix and resume at its first unreturned item; never silently skip a page. */
export function boundJiraReadResult(result: ManagedMcpToolResult): ManagedMcpToolResult {
  if (jiraProjectionBytes(result.data) <= ISSUE_DATA_MAX_BYTES) return result;
  const start = result.data.startAt;
  const values = result.data.items;
  if (typeof start !== "number" || !Array.isArray(values))
    return jiraReadFailure("bounds-exceeded");
  const source = values as readonly CatalogJsonValue[];
  const items: CatalogJsonValue[] = [];
  const base = { ...result.data, items: [], nextStartAt: start + source.length };
  let remaining = ISSUE_DATA_MAX_BYTES - jiraProjectionBytes(base);
  for (const item of source) {
    const cost = jiraProjectionBytes(item) + (items.length === 0 ? 0 : 1);
    if (cost > remaining) break;
    items.push(item);
    remaining -= cost;
  }
  return items.length === 0
    ? jiraReadFailure("bounds-exceeded")
    : {
        ...result,
        data: { ...result.data, items, nextStartAt: start + items.length },
      };
}
