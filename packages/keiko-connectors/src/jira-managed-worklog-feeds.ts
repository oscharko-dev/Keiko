import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

export const JIRA_WORKLOG_FEED_READS = JIRA_READ_TOOL_FAMILIES.worklogFeeds;
type FeedRead = (typeof JIRA_WORKLOG_FEED_READS)[number];
interface Selection {
  readonly path: string;
  readonly resource: "worklog/deleted" | "worklog/updated";
  readonly since: string;
  readonly changeType: "deleted" | "updated";
}
interface FeedWindow {
  readonly since: string;
  readonly until: string;
  readonly isLastPage: boolean;
}
/** Long query values remain decimal text; native JSON numbers must separately prove precision. */
function timestampSelector(value: unknown): value is string {
  return value === "0" || jiraNativeId(value);
}
function timestamp(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}
function selection(name: FeedRead, args: CatalogJsonObject): Selection | undefined {
  if (Object.keys(args).some((key) => key !== "since")) return undefined;
  const since = args.since === undefined ? "0" : args.since;
  if (!timestampSelector(since)) return undefined;
  const changeType = name === "jira.deleted-worklogs" ? "deleted" : "updated";
  const resource = `worklog/${changeType}` as const;
  return { since, changeType, resource, path: `${resource}?${new URLSearchParams({ since }).toString()}` };
}
function nativeReference(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 4096 || /[\p{Cc}\\]/u.test(value) || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.username === "" && url.password === "" && url.hash === "" ? url : undefined;
}
/** A proxy-safe native reference is compared, never followed or returned as a link. */
function referenceMatches(value: unknown, resource: string, since: string): boolean {
  const url = nativeReference(value);
  if (url === undefined) return false;
  const parameters = [...url.searchParams.entries()];
  const parameter = parameters[0];
  return parameters.length === 1 && parameter?.[0] === "since" && parameter[1] === since &&
    jiraResourceSelfMatches(`${url.origin}${url.pathname}`, resource);
}
function lastPage(body: Record<string, unknown>): boolean | undefined {
  const values = [body.isLastPage, body.lastPage].filter((value) => value !== undefined && value !== null);
  const first = values[0];
  return typeof first === "boolean" && values.every((value) => value === first) ? first : undefined;
}
function nativeReferences(body: Record<string, unknown>, selected: Selection, until: string): boolean {
  return (body.self === undefined || body.self === null || referenceMatches(body.self, selected.resource, selected.since)) &&
    (body.nextPage === undefined || body.nextPage === null || referenceMatches(body.nextPage, selected.resource, until));
}
function windowBounds(body: Record<string, unknown>, selected: Selection): FeedWindow | undefined {
  const since = timestamp(body.since);
  const until = timestamp(body.until);
  const isLastPage = lastPage(body);
  if (since === undefined || since !== selected.since || until === undefined || isLastPage === undefined || BigInt(until) < BigInt(since))
    return undefined;
  return { since, until, isLastPage };
}
function continuationRefusal(body: Record<string, unknown>, selected: Selection, window: FeedWindow): "conflict" | "bounds-exceeded" | undefined {
  if (!nativeReferences(body, selected, window.until)) return "conflict";
  // Inclusive timestamps can repeat. Never add one or drop a capped prefix to manufacture progress.
  return !window.isLastPage && BigInt(window.until) <= BigInt(window.since) ? "bounds-exceeded" : undefined;
}
function change(value: unknown, since: string, until: string): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const worklogId = typeof raw?.worklogId === "number" ? jiraNativeNumericId(raw.worklogId) : undefined;
  const changedAt = timestamp(raw?.updatedTime);
  return worklogId === undefined || changedAt === undefined || BigInt(changedAt) < BigInt(since) || BigInt(changedAt) > BigInt(until)
    ? undefined : { worklogId, changedAt };
}
function unsafeNativeInteger(body: Record<string, unknown>, values: readonly unknown[]): boolean {
  const numbers = [body.since, body.until, ...values.flatMap((value) => {
    const raw = asRecord(value);
    return [raw?.worklogId, raw?.updatedTime];
  })];
  return numbers.some((value) => typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value));
}
function page(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const body = response.body;
  const values = asArray(body?.values);
  if (body === undefined || values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || unsafeNativeInteger(body, values)) return jiraReadFailure("bounds-exceeded");
  const window = windowBounds(body, selected);
  if (window === undefined) return jiraReadFailure("malformed-payload");
  const refusal = continuationRefusal(body, selected, window);
  if (refusal !== undefined) return jiraReadFailure(refusal);
  const { since, until, isLastPage } = window;
  const items = values.map((value) => change(value, since, until));
  if (items.some((item) => item === undefined)) return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({ data: {
    outcome: "succeeded", changeType: selected.changeType, feedScope: "native-visible-change-window",
    timeUnit: "unix-milliseconds", excludesLatestMinute: true, since, until, isLastPage,
    items: items.filter((item) => item !== undefined),
    ...(!isLastPage ? { nextSince: until } : {}),
  } });
}
export function isJiraWorklogFeedRead(name: string): name is FeedRead {
  return JIRA_WORKLOG_FEED_READS.some((candidate) => candidate === name);
}
/** WorklogResource/WorklogChangedSincePage (11.3.3): one complete native page, never all-history evidence.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/issue/worklog/WorklogResource.html
 */
export function executeJiraWorklogFeedRead(name: FeedRead, args: CatalogJsonObject, request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(selection(name, args), request, "json", page);
}
