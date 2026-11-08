import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ATLASSIAN_WRITE_RESPONSE_MAX_BYTES } from "./atlassian-write-http.js";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { agileDate } from "./jira-agile-projection.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";

export const JIRA_ISSUE_DETAIL_READS = [
  ...JIRA_READ_TOOL_FAMILIES.issueLinks,
  ...JIRA_READ_TOOL_FAMILIES.worklogs,
] as const;
type DetailRead = (typeof JIRA_ISSUE_DETAIL_READS)[number];
interface Selection {
  readonly target?: string;
  readonly worklogId?: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function page(value: unknown, fallback: number, min: number, max: number): number | undefined {
  return value === undefined
    ? fallback
    : typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : undefined;
}
function selection(name: DetailRead, args: CatalogJsonObject): Selection | undefined {
  const collection = name === "jira.link-types" || name === "jira.worklogs";
  const startAt = page(args.startAt, 0, 0, 1_000_000);
  const maxResults = page(args.maxResults, 25, 1, 100);
  if (startAt === undefined || maxResults === undefined) return undefined;
  const allowed = new Set(collection ? ["startAt", "maxResults"] : []);
  const target = detailTarget(name, args, allowed);
  if (target === undefined || Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  return { ...target, startAt, maxResults };
}
function detailTarget(
  name: DetailRead,
  args: CatalogJsonObject,
  allowed: Set<string>,
): Omit<Selection, "startAt" | "maxResults"> | undefined {
  if (name === "jira.link-types") return {};
  if (name === "jira.issue-link") {
    allowed.add("linkId");
    return jiraNativeId(args.linkId) ? { target: args.linkId } : undefined;
  }
  allowed.add("issueKey");
  if (!isSafeAtlassianIdentifier(args.issueKey)) return undefined;
  if (name === "jira.worklogs") return { target: args.issueKey };
  allowed.add("worklogId");
  return jiraNativeId(args.worklogId)
    ? { target: args.issueKey, worklogId: args.worklogId }
    : undefined;
}
/** Native link-type identity and relation labels; remote self URLs never enter the projection. */
export function jiraIssueLinkTypeProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    !raw ||
    !jiraNativeId(raw.id) ||
    !jiraNativeText(raw.name, 255) ||
    !jiraNativeText(raw.inward, 255) ||
    !jiraNativeText(raw.outward, 255)
  )
    return undefined;
  return { id: raw.id, name: raw.name, inward: raw.inward, outward: raw.outward };
}
function issueLink(value: unknown, id: string): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw?.id !== id) return undefined;
  const type = jiraIssueLinkTypeProjection(raw.type);
  const inward = asRecord(raw.inwardIssue)?.key;
  const outward = asRecord(raw.outwardIssue)?.key;
  if (
    type === undefined ||
    !isSafeAtlassianIdentifier(inward) ||
    !isSafeAtlassianIdentifier(outward)
  )
    return undefined;
  return { ...type, id, inwardIssueKey: inward, outwardIssueKey: outward };
}
function worklogAuthor(value: unknown): CatalogJsonObject {
  const author = asRecord(value);
  return {
    ...(jiraNativeText(author?.name, 255) ? { authorName: author.name } : {}),
    ...(jiraNativeText(author?.displayName, 255) ? { authorDisplayName: author.displayName } : {}),
  };
}
function worklogText(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const fields: Record<string, string> = {};
  if (raw.comment !== undefined && raw.comment !== null) {
    if (!jiraNativeText(raw.comment, 32768, true)) return undefined;
    fields.comment = raw.comment;
  }
  for (const field of ["started", "created", "updated"] as const) {
    if (raw[field] === undefined || raw[field] === null) continue;
    if (!agileDate(raw[field])) return undefined;
    fields[field] = raw[field];
  }
  return { ...fields, ...worklogAuthor(raw.author) };
}
interface IssueBinding {
  readonly id: string;
  readonly key: string;
}
export function jiraWorklogProjection(value: unknown, issue: IssueBinding): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    !raw ||
    !jiraNativeId(raw.id) ||
    raw.issueId !== issue.id ||
    typeof raw.timeSpentSeconds !== "number" ||
    !Number.isSafeInteger(raw.timeSpentSeconds) ||
    raw.timeSpentSeconds < 0
  )
    return undefined;
  const text = worklogText(raw);
  return text === undefined
    ? undefined
    : { ...text, id: raw.id, issueKey: issue.key, timeSpentSeconds: raw.timeSpentSeconds };
}
function single(item: CatalogJsonObject | undefined): ManagedMcpToolResult {
  return item === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", items: [item] } });
}
async function readLink(
  name: DetailRead,
  selected: Selection,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const response = await request(
    name === "jira.link-types" ? "issueLinkType" : `issueLink/${selected.target ?? ""}`,
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  if (name === "jira.issue-link") return single(issueLink(response.body, selected.target ?? ""));
  const raw = response.body?.issueLinkTypes;
  if (!Array.isArray(raw)) return jiraReadFailure("malformed-payload");
  const items = projectJiraCollection(raw, TOOL_CATALOG_LIMITS.maxArrayItems, jiraIssueLinkTypeProjection, "id");
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
type BoundIssue =
  | { readonly ok: true; readonly issue: IssueBinding }
  | { readonly ok: false; readonly result: ManagedMcpToolResult };
export async function resolveJiraWorklogIssue(request: JiraMutationRequest, target: string): Promise<BoundIssue> {
  const response = await request(`issue/${encodeURIComponent(target)}?fields=summary`);
  if (!response.ok) return { ok: false, result: jiraReadFailure(response.reason, response.remote) };
  const raw = response.body;
  if (response.status !== 200 || !jiraNativeId(raw?.id) || !isSafeAtlassianIdentifier(raw.key))
    return { ok: false, result: jiraReadFailure("malformed-payload") };
  if (raw.id !== target && raw.key.toUpperCase() !== target.toUpperCase())
    return { ok: false, result: jiraReadFailure("conflict") };
  return { ok: true, issue: { id: raw.id, key: raw.key } };
}
type CompleteWorklogs =
  | Extract<JiraMutationAttempt, { readonly ok: false }>
  | { readonly ok: true; readonly items: readonly CatalogJsonObject[] };
function completeWorklogItems(
  raw: Record<string, unknown> | undefined,
  issue: IssueBinding,
): CompleteWorklogs {
  if (
    !Array.isArray(raw?.worklogs) ||
    !Number.isSafeInteger(raw.total) ||
    !Number.isSafeInteger(raw.maxResults)
  )
    return { ok: false, reason: "malformed-payload" };
  // The published DC GET has no paging parameters: only a complete native envelope can be paged locally.
  if (!completeWorklogs(raw, raw.worklogs))
    return {
      ok: false,
      reason: "bounds-exceeded",
      detail: {
        messages: [
          "Jira did not return the complete native worklog collection. No complete time total is available.",
        ],
      },
    };
  // GET issue/{id}/worklog has no native page selectors. The real HTTP response budget,
  // not the catalog's output page size, bounds this complete private observation.
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > ATLASSIAN_WRITE_RESPONSE_MAX_BYTES)
    return { ok: false, reason: "bounds-exceeded" };
  const items = projectJiraCollection(
    raw.worklogs,
    raw.worklogs.length,
    (value) => jiraWorklogProjection(value, issue),
    "id",
  );
  return items === undefined ? { ok: false, reason: "malformed-payload" } : { ok: true, items };
}
function completeWorklogs(raw: Record<string, unknown>, items: readonly unknown[]): boolean {
  return (
    raw.startAt === 0 &&
    raw.total === items.length &&
    typeof raw.maxResults === "number" &&
    raw.maxResults >= items.length
  );
}
/** One native unpaged envelope, shared by readable pages and exact deletion membership proof. */
export async function readJiraCompleteWorklogs(
  request: JiraMutationRequest,
  issue: IssueBinding,
): Promise<CompleteWorklogs> {
  const response = await request(`issue/${issue.id}/worklog`);
  if (!response.ok)
    return {
      ok: false,
      reason: response.reason,
      ...(response.remote === undefined ? {} : { detail: response.remote }),
    };
  return response.status === 200
    ? completeWorklogItems(response.body, issue)
    : { ok: false, reason: "malformed-payload" };
}
async function readWorklog(
  selected: Selection,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const bound = await resolveJiraWorklogIssue(request, selected.target ?? "");
  if (!bound.ok) return bound.result;
  if (selected.worklogId === undefined) {
    const collection = await readJiraCompleteWorklogs(request, bound.issue);
    return collection.ok
      ? boundJiraReadResult(localJiraPage(collection.items, selected.startAt, selected.maxResults))
      : jiraReadFailure(collection.reason, collection.detail);
  }
  const response = await request(`issue/${bound.issue.id}/worklog/${selected.worklogId}`);
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  return single(
    response.body?.id === selected.worklogId ? jiraWorklogProjection(response.body, bound.issue) : undefined,
  );
}
/** Closed DC reads over the existing credential/authority-owned request, with complete collection accounting. */
export async function executeJiraIssueDetailRead(
  name: DetailRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  return name === "jira.link-types" || name === "jira.issue-link"
    ? readLink(name, selected, request)
    : readWorklog(selected, request);
}
export function isJiraIssueDetailRead(value: string): value is DetailRead {
  return JIRA_ISSUE_DETAIL_READS.some((name) => name === value);
}
