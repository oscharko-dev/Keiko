// Jira Cloud REST v3 sync adapter (Issue #2243, Epic #2238, ADR-0128 D3/D5).
//
// Implements the provider-agnostic `AtlassianSyncSource` seam over the injected bounded-body
// transport — the SAME lane the Confluence adapter (#2242) plugs into; nothing here re-owns
// budgets, retries, or cancellation. Exact endpoints used (Atlassian Cloud REST v3, recorded per
// the issue's engineering note; every request stays on the connector's single allowlisted host):
//
//   - Issue enumeration:  GET {base}/rest/api/3/search/jql
//                             ?jql={composed}&maxResults=100&fields=summary,updated
//                             [&nextPageToken={token}]        (token pagination; no `total`)
//   - Issue payload:      GET {base}/rest/api/3/issue/{issueId}?fields=summary,description,
//                             status,issuetype,assignee,reporter,labels,priority,created,
//                             updated,resolution,timetracking,parent,subtasks,issuelinks
//   - Issue comments:     GET {base}/rest/api/3/issue/{issueId}/comment
//                             ?startAt={n}&maxResults=100     (offset pagination, ADF bodies)
//
// JQL composition: `project IN (<validated keys>)` narrowed by ` AND (<user JQL>)` when the
// approved scope carries user JQL, else suffixed ` ORDER BY id ASC` for stable pagination (no
// ORDER BY can be appended around opaque user JQL, which may carry its own). The user JQL is
// opaque and length-bounded (#2240) — transported in the request URL only, never logged, never
// placed in evidence (ADR-0128 D6 hashes or omits it).
//
// Enumeration is ONE bounded full id-set walk (issue ids + verbatim `updated` timestamps). On an
// incremental re-sync the adapter narrows the FETCH set locally: an issue is re-fetched when its
// provider `updated` is at/after `<persisted watermark> - <5 min overlap>` (compared in UTC via
// parsed epoch milliseconds — the watermark is the verbatim provider timestamp of the last
// applied run, so no local-clock skew enters the comparison) OR when its item key is missing from
// the persisted fingerprint baseline (new issues, and issues withheld from the baseline for
// retry). Everything else is reported as carried — present upstream, content unchanged — through
// the `onEnumerated` snapshot, and the SAME full id set powers deletion/moved-out-of-JQL
// detection downstream (dropped-from-set → removed, mirroring Confluence 404 semantics). Overlap
// re-fetches dedupe harmlessly via fingerprints. Doing the narrowing locally over the one full
// enumeration (instead of a second JQL-side `updated >=` search) keeps deletion detection and
// narrowing consistent by construction and avoids the JQL date-format/user-timezone hazard.
//
// Item identity is `jira:<connectorId>:<issueId>` — the numeric issue id, NOT the key, because
// keys change when an issue moves project; the mount path `issues/<issueId>.html` is id-derived
// so moves and summary edits never move the document. `/browse/<KEY>` is the citation
// click-through path. Per-item degradation matches the Confluence matrix through the shared
// classifier: 401 fatal, 403 permission-denied skip, 404 missing/removed, 429 rate-limited,
// truncated payload bounds-exceeded, unparseable payload malformed-payload. Comment retrieval is
// supplementary enrichment — a failed comments read never fails its issue.

import {
  ATLASSIAN_JQL_MAX_CHARS,
  isSafeAtlassianIdentifier,
  isSafeJiraProjectKey,
  type AtlassianSyncFailureReason,
} from "@oscharko-dev/keiko-contracts";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import {
  asArray,
  asRecord,
  asString,
  atlassianApiEndpointsFor,
  atlassianApiUrl,
  classifyListResult,
  failureReasonForStatus,
  parseJsonRecord,
  type AtlassianApiEndpoints,
} from "./atlassian-sync-classify.js";
import {
  ATLASSIAN_SYNC_ITEM_MAX_BYTES,
  ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
  type AtlassianSyncEnumerationOutcome,
  type AtlassianSyncFetchContext,
  type AtlassianSyncItemFetchOutcome,
  type AtlassianSyncItemRef,
  type AtlassianSyncSource,
} from "./atlassian-sync-lane.js";
import {
  boundedJiraIssueTitle,
  buildJiraIssueCitationMetadata,
  composeJiraComment,
  composeJiraIssueDocument,
  jiraBodyText,
  jiraIssueMetadataLine,
  serializeJiraIssueCitationMetadata,
  JIRA_ISSUE_METADATA_FIELDS,
  type JiraComposedComment,
} from "./jira-issue-document.js";

// Response cap for list/JSON-metadata requests (search pages, comment listings). Issue payloads
// use the larger per-item cap.
export const JIRA_LIST_RESPONSE_MAX_BYTES = 1_000_000;
export const JIRA_SEARCH_PAGE_SIZE = 100;
// Incremental safety overlap: re-fetch anything updated within this window before the persisted
// watermark, so provider-side commit-order jitter can never lose an update. Overlap re-fetches
// are deduplicated by fingerprints downstream.
export const JIRA_INCREMENTAL_SYNC_OVERLAP_MS = 300_000;
// Hard ceilings on pagination loops: a hostile or looping token chain terminates as malformed
// instead of spinning until the duration budget.
const MAX_SEARCH_REQUESTS = 500;
const MAX_COMMENT_PAGES_PER_ITEM = 10;
const MAX_PAGE_TOKEN_CHARS = 4_096;
const NUMERIC_ID_PATTERN = /^[0-9]{1,32}$/u;

const JIRA_API_ROOT = "/rest/api/3/";
// The full sync fetch list: the shared citation-metadata fields (#2243/#2248 parity source)
// plus `summary` (title) and `description` (document body — sync-only; live results carry none).
const ISSUE_FETCH_FIELDS = `summary,description,${JIRA_ISSUE_METADATA_FIELDS}`;

export interface JiraIncrementalSyncOptions {
  // Verbatim provider `updated` watermark persisted by the last APPLIED run.
  readonly providerWatermark: string;
  // Item keys in the persisted fingerprint baseline; anything absent is force-fetched.
  readonly knownItemKeys: readonly string[];
}

export interface JiraSyncEnumerationSnapshot {
  // Enumeration-confirmed items whose content was NOT re-fetched this run.
  readonly carriedItemKeys: readonly string[];
  // Max verbatim provider `updated` observed across the complete enumeration.
  readonly providerWatermark: string | undefined;
}

export interface JiraSyncSourceOptions {
  readonly baseUrl: string;
  readonly connectorId: string;
  readonly projectKeys: readonly string[];
  readonly jql?: string | undefined;
  readonly incremental?: JiraIncrementalSyncOptions | undefined;
  // Fires once per COMPLETE enumeration (a truncated enumeration never snapshots — the lane
  // discards the run fail-closed anyway).
  readonly onEnumerated?: ((snapshot: JiraSyncEnumerationSnapshot) => void) | undefined;
}

export interface JiraIssueRef extends AtlassianSyncItemRef {
  readonly issueId: string;
}

// ─── Provider timestamps (verbatim strings, compared in UTC) ──────────────────
// Jira emits "2026-05-01T10:22:33.000+0000"; the colon-less zone offset is normalized before
// parsing so the comparison is engine-portable. Unparseable values return undefined and are
// treated fail-closed (always re-fetch, never advance the watermark).
export function parseJiraProviderTimestampMs(value: string): number | undefined {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

// The later of two verbatim provider timestamps (monotonic watermark advancement downstream).
export function laterJiraProviderTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  const currentMs = parseJiraProviderTimestampMs(current);
  const candidateMs = parseJiraProviderTimestampMs(candidate);
  if (candidateMs === undefined) return current;
  if (currentMs === undefined) return candidate;
  return candidateMs > currentMs ? candidate : current;
}

// ─── Options validation and JQL composition ───────────────────────────────────
function validateSourceOptions(options: JiraSyncSourceOptions): void {
  const errors: string[] = [];
  if (!isSafeAtlassianIdentifier(options.connectorId)) {
    errors.push("connectorId must be a safe identifier token");
  }
  if (options.projectKeys.length === 0) {
    errors.push("projectKeys must contain at least one project key");
  }
  if (!options.projectKeys.every((key) => isSafeJiraProjectKey(key))) {
    errors.push("projectKeys must be valid Jira project keys");
  }
  if (options.jql !== undefined) {
    if (options.jql.length === 0 || options.jql.length > ATLASSIAN_JQL_MAX_CHARS) {
      errors.push("jql must be a non-empty string within the contract length bound");
    }
  }
  if (errors.length > 0) {
    throw new AtlassianCredentialCustodyError("invalid-input", errors);
  }
}

// `project IN (...)` scopes every query to the approved projects; user JQL only ever NARROWS via
// AND. Without user JQL an `ORDER BY id ASC` suffix keeps pagination stable.
export function composeJiraScopeJql(
  projectKeys: readonly string[],
  userJql: string | undefined,
): string {
  const scope = `project IN (${projectKeys.join(", ")})`;
  return userJql === undefined ? `${scope} ORDER BY id ASC` : `${scope} AND (${userJql})`;
}

// ─── Enumeration (one bounded full id-set walk) ────────────────────────────────
interface JiraEnumeratedIssue {
  readonly issueId: string;
  readonly key: string;
  readonly updated: string | undefined;
}

function searchPageUrl(
  endpoints: AtlassianApiEndpoints,
  jql: string,
  pageToken: string | undefined,
): string {
  const token = pageToken === undefined ? "" : `&nextPageToken=${encodeURIComponent(pageToken)}`;
  return atlassianApiUrl(
    endpoints,
    `search/jql?jql=${encodeURIComponent(jql)}&maxResults=${String(JIRA_SEARCH_PAGE_SIZE)}` +
      `&fields=summary,updated${token}`,
  );
}

// One search-result entry narrowed to a validated enumerated issue; hostile entries (missing or
// unsafe id/key) are dropped, mirroring the Confluence listing collector.
function searchEntryToIssue(entry: unknown): JiraEnumeratedIssue | undefined {
  const record = asRecord(entry);
  const issueId = asString(record?.id);
  const key = asString(record?.key);
  if (record === undefined || issueId === undefined || key === undefined) return undefined;
  if (!NUMERIC_ID_PATTERN.test(issueId) || !isSafeAtlassianIdentifier(key)) return undefined;
  return { issueId, key, updated: asString(asRecord(record.fields)?.updated) };
}

function collectSearchEntries(
  results: readonly unknown[],
  into: JiraEnumeratedIssue[],
  ceiling: number,
): boolean {
  for (const entry of results) {
    const issue = searchEntryToIssue(entry);
    if (issue === undefined) continue;
    into.push(issue);
    // Stop as soon as the ceiling is crossed: the lane only needs to KNOW the approved scope
    // overflows its item budget (complete=false), not the full overflowing list.
    if (into.length > ceiling) return false;
  }
  return true;
}

// The `nextPageToken` is opaque provider data: bounded and echoed back verbatim, never resolved
// as a URL — pagination can never widen egress beyond the composed search endpoint. Exported
// package-internally so the live search walk (#2248) applies the identical token discipline.
export function nextSearchToken(
  body: Record<string, unknown>,
): { readonly ok: true; readonly token: string | undefined } | { readonly ok: false } {
  const token = body.nextPageToken;
  if (token === undefined || token === null) return { ok: true, token: undefined };
  const text = asString(token);
  if (text === undefined || text.length === 0 || text.length > MAX_PAGE_TOKEN_CHARS) {
    return { ok: false };
  }
  return { ok: true, token: text };
}

type JiraEnumerationWalk =
  | {
      readonly ok: true;
      readonly entries: readonly JiraEnumeratedIssue[];
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly reason: AtlassianSyncFailureReason };

async function walkSearchPages(
  context: AtlassianSyncFetchContext,
  endpoints: AtlassianApiEndpoints,
  jql: string,
): Promise<JiraEnumerationWalk> {
  const entries: JiraEnumeratedIssue[] = [];
  let token: string | undefined;
  for (let requests = 0; ; requests += 1) {
    if (requests >= MAX_SEARCH_REQUESTS) return { ok: false, reason: "malformed-payload" };
    if (context.deadlineExceeded()) return { ok: false, reason: "timeout" };
    const result = await context.http({
      method: "GET",
      url: searchPageUrl(endpoints, jql, token),
      timeoutMs: ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
      maxBodyBytes: JIRA_LIST_RESPONSE_MAX_BYTES,
    });
    const page = classifyListResult(result, JIRA_LIST_RESPONSE_MAX_BYTES);
    if (!page.ok) return { ok: false, reason: page.reason };
    const issues = asArray(page.body.issues);
    if (issues === undefined) return { ok: false, reason: "malformed-payload" };
    if (!collectSearchEntries(issues, entries, context.maxItems)) {
      return { ok: true, entries, complete: false };
    }
    const next = nextSearchToken(page.body);
    if (!next.ok) return { ok: false, reason: "malformed-payload" };
    if (next.token === undefined) return { ok: true, entries, complete: true };
    token = next.token;
  }
}

interface JiraEnumerationPartition {
  readonly fetchRefs: readonly JiraIssueRef[];
  readonly carriedItemKeys: readonly string[];
}

// Fetch when updated at/after `<watermark> - <overlap>` (UTC compare), when the timestamp is
// unparseable (fail closed to re-fetch), or when the key left the persisted baseline (new issue,
// or withheld for retry). Everything else carries forward.
function partitionForIncremental(
  entries: readonly JiraEnumeratedIssue[],
  connectorId: string,
  incremental: JiraIncrementalSyncOptions | undefined,
): JiraEnumerationPartition {
  const cutoffBaseMs =
    incremental === undefined
      ? undefined
      : parseJiraProviderTimestampMs(incremental.providerWatermark);
  const known = new Set(incremental?.knownItemKeys ?? []);
  const fetchRefs: JiraIssueRef[] = [];
  const carriedItemKeys: string[] = [];
  for (const entry of entries) {
    const itemKey = `jira:${connectorId}:${entry.issueId}`;
    const updatedMs =
      entry.updated === undefined ? undefined : parseJiraProviderTimestampMs(entry.updated);
    const carried =
      cutoffBaseMs !== undefined &&
      known.has(itemKey) &&
      updatedMs !== undefined &&
      updatedMs < cutoffBaseMs - JIRA_INCREMENTAL_SYNC_OVERLAP_MS;
    if (carried) {
      carriedItemKeys.push(itemKey);
    } else {
      fetchRefs.push({ itemKey, issueId: entry.issueId });
    }
  }
  return { fetchRefs, carriedItemKeys };
}

function enumerationWatermark(entries: readonly JiraEnumeratedIssue[]): string | undefined {
  let latest: string | undefined;
  for (const entry of entries) {
    latest = laterJiraProviderTimestamp(latest, entry.updated);
  }
  return latest;
}

async function enumerateJiraIssues(
  context: AtlassianSyncFetchContext,
  endpoints: AtlassianApiEndpoints,
  options: JiraSyncSourceOptions,
): Promise<AtlassianSyncEnumerationOutcome<JiraIssueRef>> {
  const jql = composeJiraScopeJql(options.projectKeys, options.jql);
  const walk = await walkSearchPages(context, endpoints, jql);
  if (!walk.ok) return { ok: false, reason: walk.reason };
  const partition = partitionForIncremental(walk.entries, options.connectorId, options.incremental);
  if (!walk.complete) {
    // Truncated coverage: report the overflow (the lane fails the run closed) and never snapshot
    // a partial watermark or carried set.
    return { ok: true, refs: partition.fetchRefs, complete: false };
  }
  options.onEnumerated?.({
    carriedItemKeys: partition.carriedItemKeys,
    providerWatermark: enumerationWatermark(walk.entries),
  });
  return { ok: true, refs: partition.fetchRefs, complete: true };
}

// ─── Per-issue fetch ───────────────────────────────────────────────────────────
type IssueFetchResult =
  | { readonly kind: "payload"; readonly record: Record<string, unknown> }
  | { readonly kind: "missing" }
  | { readonly kind: "skipped"; readonly reason: AtlassianSyncFailureReason }
  | { readonly kind: "fatal"; readonly reason: AtlassianSyncFailureReason };

function classifyIssueFailureStatus(status: number): IssueFetchResult {
  if (status === 401) return { kind: "fatal", reason: "auth-failed" };
  if (status === 404) return { kind: "missing" };
  return { kind: "skipped", reason: failureReasonForStatus(status) };
}

async function fetchIssuePayload(
  context: AtlassianSyncFetchContext,
  endpoints: AtlassianApiEndpoints,
  issueId: string,
): Promise<IssueFetchResult> {
  const result = await context.http({
    method: "GET",
    url: atlassianApiUrl(endpoints, `issue/${issueId}?fields=${ISSUE_FETCH_FIELDS}`),
    timeoutMs: ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
    maxBodyBytes: ATLASSIAN_SYNC_ITEM_MAX_BYTES,
  });
  if (result.kind === "timeout") return { kind: "skipped", reason: "timeout" };
  if (result.kind === "network-error") return { kind: "skipped", reason: "unavailable" };
  if (result.status < 200 || result.status >= 300) {
    return classifyIssueFailureStatus(result.status);
  }
  // A truncated issue payload can never be indexed faithfully (mid-JSON truncation is malformed
  // by construction): skipped with bounds-exceeded, the run continues.
  if (result.truncated) return { kind: "skipped", reason: "bounds-exceeded" };
  const record = parseJsonRecord(result.bodyText);
  if (record === undefined) return { kind: "skipped", reason: "malformed-payload" };
  return { kind: "payload", record };
}

// Comments are bounded supplementary enrichment: harvested in listing order up to the page
// ceiling, and ANY comment-lane failure degrades to "issue without further comments" rather than
// failing the issue (the issue body remains the citable artifact).
async function fetchIssueComments(
  context: AtlassianSyncFetchContext,
  endpoints: AtlassianApiEndpoints,
  issueId: string,
): Promise<readonly unknown[]> {
  const collected: unknown[] = [];
  for (let page = 0; page < MAX_COMMENT_PAGES_PER_ITEM; page += 1) {
    if (context.deadlineExceeded()) return collected;
    const url = atlassianApiUrl(
      endpoints,
      `issue/${issueId}/comment?startAt=${String(collected.length)}&maxResults=100`,
    );
    const result = await context.http({
      method: "GET",
      url,
      timeoutMs: ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
      maxBodyBytes: JIRA_LIST_RESPONSE_MAX_BYTES,
    });
    const listing = classifyListResult(result, JIRA_LIST_RESPONSE_MAX_BYTES);
    if (!listing.ok) return collected;
    const comments = asArray(listing.body.comments);
    if (comments === undefined || comments.length === 0) return collected;
    collected.push(...comments);
    const total = listing.body.total;
    if (typeof total === "number" && collected.length >= total) return collected;
  }
  return collected;
}

function composedComments(entries: readonly unknown[]): readonly JiraComposedComment[] {
  return entries
    .map((entry) => composeJiraComment(entry))
    .filter((comment): comment is JiraComposedComment => comment !== undefined);
}

function buildJiraItem(
  ref: JiraIssueRef,
  issueRecord: Record<string, unknown>,
  commentEntries: readonly unknown[],
): AtlassianSyncItemFetchOutcome {
  const key = asString(issueRecord.key);
  if (key === undefined || !isSafeAtlassianIdentifier(key)) {
    return { kind: "skipped", reason: "malformed-payload" };
  }
  const fields = asRecord(issueRecord.fields) ?? {};
  const metadata = buildJiraIssueCitationMetadata(key, fields);
  const title = boundedJiraIssueTitle(key, fields.summary);
  const document = composeJiraIssueDocument({
    title,
    metadataLine: jiraIssueMetadataLine(metadata),
    descriptionText: jiraBodyText(fields.description).text,
    comments: composedComments(commentEntries),
  });
  return {
    kind: "item",
    item: {
      itemKey: ref.itemKey,
      title,
      relativePath: `issues/${ref.issueId}.html`,
      contentHtml: document.contentHtml,
      byteLength: document.byteLength,
      webuiPath: `/browse/${key}`,
      citationMetadataJson: serializeJiraIssueCitationMetadata(metadata),
    },
  };
}

async function fetchJiraItem(
  ref: JiraIssueRef,
  context: AtlassianSyncFetchContext,
  endpoints: AtlassianApiEndpoints,
): Promise<AtlassianSyncItemFetchOutcome> {
  const payload = await fetchIssuePayload(context, endpoints, ref.issueId);
  if (payload.kind === "missing") return { kind: "missing" };
  if (payload.kind === "fatal") return { kind: "fatal", reason: payload.reason };
  if (payload.kind === "skipped") return { kind: "skipped", reason: payload.reason };
  const commentEntries = await fetchIssueComments(context, endpoints, ref.issueId);
  return buildJiraItem(ref, payload.record, commentEntries);
}

// Build the Jira sync source for one approved connector scope. Transport, budget, deadline,
// retry, and cancellation all arrive through the lane's per-run context — the source holds no
// transport state of its own.
export function createJiraSyncSource(
  options: JiraSyncSourceOptions,
): AtlassianSyncSource<JiraIssueRef> {
  validateSourceOptions(options);
  const endpoints = atlassianApiEndpointsFor(options.baseUrl, JIRA_API_ROOT);
  return {
    enumerate: (
      context: AtlassianSyncFetchContext,
    ): Promise<AtlassianSyncEnumerationOutcome<JiraIssueRef>> =>
      enumerateJiraIssues(context, endpoints, options),
    fetchItem: (
      ref: JiraIssueRef,
      context: AtlassianSyncFetchContext,
    ): Promise<AtlassianSyncItemFetchOutcome> => fetchJiraItem(ref, context, endpoints),
  };
}
