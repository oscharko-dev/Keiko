// Governed live Jira JQL search executor (Issue #2248, Epic #2238, ADR-0128 D3/D4/D5/D6).
//
// A THIN orchestration over the SAME lane internals the #2243 sync adapter runs on — no second
// client, no second backoff, no second classification vocabulary:
//
//   - Endpoint: GET {base}/rest/api/3/search/jql
//         ?jql={executed}&maxResults={cap}&fields=summary,{metadata field list}
//         [&nextPageToken={token}]                    (token pagination, no `total`)
//     The metadata field list is the shared #2243 constant (`JIRA_ISSUE_METADATA_FIELDS`), so a
//     live hit requests exactly the citation-metadata fields the sync fetch requests — parity by
//     construction. Live results deliberately request NO `description`: they carry summaries and
//     metadata, never bodies (Issue #2248 Scope 2).
//   - Transport: the sync lane's budget-/deadline-/retry-aware wrapper
//     (`createAtlassianBudgetedRetryingPort`) — identical D3 429/5xx backoff with capped
//     Retry-After, backoff never overshooting the deadline, continuous byte accounting.
//   - Bounds (ADR-0128 D3/D5): 15 000 ms wall-clock budget for the whole action, `maxResults`
//     capped at ATLASSIAN_LIVE_SEARCH_MAX_RESULTS (100); pagination stops AT the cap with
//     `truncated: true`, and a hostile or degenerate token chain terminates at a hard page
//     ceiling with the collected slice reported truncated (honest coverage, never a spin).
//   - Failures: the closed sync vocabulary via the shared classifier — auth-failed /
//     permission-denied / rate-limited / timeout / unavailable / malformed-payload /
//     bounds-exceeded. Content-free: no response body, header, or JQL text in any failure.
//
// EPHEMERAL by construction: this module computes no fingerprints, composes no documents, and
// touches no store — it maps provider entries to the `JiraLiveIssue` wire shape and returns
// them. The result carries `source: "live"`, `queriedAt`, and `jqlDigest` (sha256 of the
// executed JQL via keiko-security — the query text itself never leaves the request path).

import {
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  isSafeAtlassianIdentifier,
  type AtlassianLiveSearchTemplateId,
  type AtlassianSyncFailureReason,
  type JiraLiveIssue,
  type JiraLiveSearchRequest,
  type JiraLiveSearchResult,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  asArray,
  asRecord,
  asString,
  atlassianApiEndpointsFor,
  atlassianApiUrl,
  classifyListResult,
  type AtlassianApiEndpoints,
} from "./atlassian-sync-classify.js";
import {
  AtlassianSyncBudgetExhausted,
  createAtlassianBudgetedRetryingPort,
} from "./atlassian-sync-lane.js";
import {
  buildJiraIssueCitationMetadata,
  JIRA_ISSUE_METADATA_FIELDS,
} from "./jira-issue-document.js";
import { JIRA_LIST_RESPONSE_MAX_BYTES, nextSearchToken } from "./jira-sync-adapter.js";

// ADR-0128 D3: the live JQL search action's wall-clock budget (15 s), covering every page
// request and every backoff wait inside one call.
export const ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS = 15_000;
// Hard ceiling on pagination requests: a conforming provider serves ≤ 100 capped results in one
// or two pages; a degenerate or hostile token chain terminates here with truncated coverage.
export const JIRA_LIVE_SEARCH_MAX_PAGE_REQUESTS = 10;
// Cumulative response-byte budget for one live search — metadata-only payloads for ≤ 100 issues
// sit far below this; the budgeted port clamps every page read to the remainder.
export const JIRA_LIVE_SEARCH_MAX_TOTAL_BYTES = 5_000_000;

const JIRA_API_ROOT = "/rest/api/3/";
// Live field list: the shared citation-metadata fields plus the summary — never `description`.
const JIRA_LIVE_SEARCH_FIELDS = `summary,${JIRA_ISSUE_METADATA_FIELDS}`;

// ─── Well-known templates (Issue #2248 Scope 2/D4 row 3) ───────────────────────
// Composed from FIXED validated parts — never from user input. Exact JQL per template:
//   assigned-to-me-open →
//     `assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC`
//   ("the open issues assigned to me right now, most recently updated first": `resolution =
//   EMPTY` is Jira's unresolved marker, and `currentUser()` binds to the token identity at the
//   moment of the call — the ADR-0128 D8 point-in-time permissions posture.)
export const JIRA_LIVE_SEARCH_TEMPLATE_JQL: Readonly<
  Record<AtlassianLiveSearchTemplateId, string>
> = Object.freeze({
  "assigned-to-me-open": "assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC",
} as const satisfies Readonly<Record<AtlassianLiveSearchTemplateId, string>>);

// Resolve the EXECUTED JQL for a validated live-search request: a template id maps through the
// fixed table; free-form JQL passes through opaquely (bounded, never parsed). The wire validator
// enforces the XOR; this re-check fails closed on programmer error.
export function resolveJiraLiveSearchJql(request: JiraLiveSearchRequest): string {
  if (request.templateId !== undefined && request.jql === undefined) {
    return JIRA_LIVE_SEARCH_TEMPLATE_JQL[request.templateId];
  }
  if (request.jql !== undefined && request.templateId === undefined) {
    return request.jql;
  }
  throw new AtlassianCredentialCustodyError("invalid-input", [
    "live search request must carry exactly one of jql or templateId",
  ]);
}

// ─── Executor surface ───────────────────────────────────────────────────────────
export interface JiraLiveSearchDeps {
  readonly http: AtlassianHttpBodyPort;
  readonly now?: (() => number) | undefined;
  // Injected backoff sleep (real timer in production, recorded no-op in tests).
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface JiraLiveSearchInput {
  readonly baseUrl: string;
  // The EXECUTED JQL — free-form user JQL passed through opaquely, or a template resolved via
  // `resolveJiraLiveSearchJql`. Hashed into the result's `jqlDigest`, never logged or echoed.
  readonly jql: string;
  // Defaults to the D5 ceiling; a caller can only narrow it (validated fail-closed).
  readonly maxResults?: number | undefined;
}

// The #2248 degradation vocabulary — identical literals to the sync lane's closed reasons.
export type JiraLiveSearchFailureReason = Extract<
  AtlassianSyncFailureReason,
  | "auth-failed"
  | "permission-denied"
  | "rate-limited"
  | "timeout"
  | "unavailable"
  | "malformed-payload"
  | "bounds-exceeded"
>;

export type JiraLiveSearchOutcome =
  | { readonly ok: true; readonly result: JiraLiveSearchResult }
  | { readonly ok: false; readonly reason: JiraLiveSearchFailureReason };

// `scope-exceeded`/`cancelled` cannot arise from the shared list classifier or the budgeted
// port; the defensive collapse keeps the executor's vocabulary closed without a cast.
function liveFailureReason(reason: AtlassianSyncFailureReason): JiraLiveSearchFailureReason {
  return reason === "scope-exceeded" || reason === "cancelled" ? "unavailable" : reason;
}

function validateLiveSearchInput(input: JiraLiveSearchInput): void {
  const errors: string[] = [];
  if (input.jql.length === 0 || input.jql.length > ATLASSIAN_JQL_MAX_CHARS) {
    errors.push("jql must be a non-empty string within the contract length bound");
  }
  const maxResults = input.maxResults;
  if (
    maxResults !== undefined &&
    (!Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)
  ) {
    errors.push("maxResults must be a positive integer within the live search ceiling");
  }
  if (errors.length > 0) {
    throw new AtlassianCredentialCustodyError("invalid-input", errors);
  }
}

// ─── Entry normalization ────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to STRIP them
const CONTROL_CHARS_GLOBAL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;

// Live summaries are bounded single-line display text: hostile control characters are flattened
// to spaces, whitespace collapses, and the result truncates at the shared contract bound.
function boundedLiveSummary(value: unknown): string {
  const flattened = (asString(value) ?? "")
    .replace(CONTROL_CHARS_GLOBAL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flattened.length > ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS
    ? flattened.slice(0, ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS)
    : flattened;
}

// Site-root browse base (origin plus any Data Center context path) — the same click-through
// shape the synced `webuiPath` resolves to against the connector base URL.
function browseBaseFor(endpoints: AtlassianApiEndpoints): string {
  const basePath = endpoints.base.pathname.endsWith("/")
    ? endpoints.base.pathname.slice(0, -1)
    : endpoints.base.pathname;
  return `${endpoints.base.origin}${basePath}`;
}

// One search entry → one live hit. Hostile entries (missing or unsafe key) are dropped exactly
// as the sync enumeration drops them, and the citation metadata is built by the SAME #2243
// builder the sync lane uses — the parity acceptance criterion holds by construction.
function liveIssueFromEntry(entry: unknown, browseBase: string): JiraLiveIssue | undefined {
  const record = asRecord(entry);
  const key = asString(record?.key);
  if (record === undefined || key === undefined || !isSafeAtlassianIdentifier(key)) {
    return undefined;
  }
  const fields = asRecord(record.fields) ?? {};
  return {
    key,
    summary: boundedLiveSummary(fields.summary),
    browseUrl: `${browseBase}/browse/${key}`,
    metadata: buildJiraIssueCitationMetadata(key, fields),
  };
}

// Collect one page's valid entries, deduplicating by issue key (a hostile token loop re-serving
// the same page can never inflate the result). Returns false the moment a valid match beyond the
// cap appears — the walk stops AT the cap with truncated coverage.
function collectLivePageEntries(
  entries: readonly unknown[],
  browseBase: string,
  maxResults: number,
  into: JiraLiveIssue[],
  seenKeys: Set<string>,
): boolean {
  for (const entry of entries) {
    const issue = liveIssueFromEntry(entry, browseBase);
    if (issue === undefined || seenKeys.has(issue.key)) continue;
    if (into.length >= maxResults) return false;
    seenKeys.add(issue.key);
    into.push(issue);
  }
  return true;
}

// ─── Bounded page walk ──────────────────────────────────────────────────────────
interface LiveSearchWalk {
  readonly issues: readonly JiraLiveIssue[];
  readonly truncated: boolean;
}

type LiveWalkOutcome =
  | { readonly ok: true; readonly walk: LiveSearchWalk }
  | { readonly ok: false; readonly reason: JiraLiveSearchFailureReason };

function liveSearchPageUrl(
  endpoints: AtlassianApiEndpoints,
  jql: string,
  maxResults: number,
  pageToken: string | undefined,
): string {
  const token = pageToken === undefined ? "" : `&nextPageToken=${encodeURIComponent(pageToken)}`;
  return atlassianApiUrl(
    endpoints,
    `search/jql?jql=${encodeURIComponent(jql)}&maxResults=${String(maxResults)}` +
      `&fields=${JIRA_LIVE_SEARCH_FIELDS}${token}`,
  );
}

async function walkLiveSearchPages(
  http: AtlassianHttpBodyPort,
  endpoints: AtlassianApiEndpoints,
  jql: string,
  maxResults: number,
  remainingTimeoutMs: () => number,
): Promise<LiveWalkOutcome> {
  const browseBase = browseBaseFor(endpoints);
  const issues: JiraLiveIssue[] = [];
  const seenKeys = new Set<string>();
  let token: string | undefined;
  for (let requests = 0; requests < JIRA_LIVE_SEARCH_MAX_PAGE_REQUESTS; requests += 1) {
    const result = await http({
      method: "GET",
      url: liveSearchPageUrl(endpoints, jql, maxResults, token),
      timeoutMs: remainingTimeoutMs(),
      maxBodyBytes: JIRA_LIST_RESPONSE_MAX_BYTES,
    });
    const page = classifyListResult(result, JIRA_LIST_RESPONSE_MAX_BYTES);
    if (!page.ok) return { ok: false, reason: liveFailureReason(page.reason) };
    const entries = asArray(page.body.issues);
    if (entries === undefined) return { ok: false, reason: "malformed-payload" };
    if (!collectLivePageEntries(entries, browseBase, maxResults, issues, seenKeys)) {
      return { ok: true, walk: { issues, truncated: true } };
    }
    const next = nextSearchToken(page.body);
    if (!next.ok) return { ok: false, reason: "malformed-payload" };
    if (next.token === undefined) return { ok: true, walk: { issues, truncated: false } };
    // A continuing token chain at a full cap means more matches exist upstream: stop AT the cap.
    if (issues.length >= maxResults) return { ok: true, walk: { issues, truncated: true } };
    token = next.token;
  }
  // The page ceiling terminated a still-continuing chain: report the collected slice as
  // truncated coverage (honest degradation) rather than failing the whole query.
  return { ok: true, walk: { issues, truncated: true } };
}

// ─── Result envelope ────────────────────────────────────────────────────────────
// `totalMatched` is present exactly when the full match set was enumerated: the token-paginated
// endpoint reports no total, so a truncated result omits it (the contract's integrity rule).
function liveSearchResult(
  jql: string,
  queriedAt: number,
  walk: LiveSearchWalk,
): JiraLiveSearchResult {
  return {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    source: "live",
    queriedAt,
    jqlDigest: sha256Hex(jql),
    ...(walk.truncated ? {} : { totalMatched: walk.issues.length }),
    truncated: walk.truncated,
    issues: walk.issues,
  };
}

// Execute one bounded live JQL search. Never throws for provider or transport failures — those
// return the closed content-free reason; invalid caller input (unvalidated JQL bounds, widened
// cap, malformed base URL) throws the custody validation error exactly like the sync source.
export async function executeJiraLiveSearch(
  deps: JiraLiveSearchDeps,
  input: JiraLiveSearchInput,
): Promise<JiraLiveSearchOutcome> {
  validateLiveSearchInput(input);
  const endpoints = atlassianApiEndpointsFor(input.baseUrl, JIRA_API_ROOT);
  const maxResults = input.maxResults ?? ATLASSIAN_LIVE_SEARCH_MAX_RESULTS;
  const now = deps.now ?? ((): number => Date.now());
  const queriedAt = now();
  const deadlineAt = queriedAt + ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS;
  const http = createAtlassianBudgetedRetryingPort({
    http: deps.http,
    maxBytes: JIRA_LIVE_SEARCH_MAX_TOTAL_BYTES,
    deadlineAt,
    now,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  try {
    const outcome = await walkLiveSearchPages(http, endpoints, input.jql, maxResults, () =>
      Math.max(1, deadlineAt - now()),
    );
    if (!outcome.ok) return outcome;
    return { ok: true, result: liveSearchResult(input.jql, queriedAt, outcome.walk) };
  } catch (error) {
    if (error instanceof AtlassianSyncBudgetExhausted) {
      return { ok: false, reason: liveFailureReason(error.reason) };
    }
    throw error;
  }
}
