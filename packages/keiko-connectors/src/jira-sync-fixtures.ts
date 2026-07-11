// Deterministic in-memory Jira Cloud REST v3 fixture transport (Issue #2243, Epic #2238).
//
// The Jira sync lane's hermetic test double, mirroring `createInMemoryConfluenceFixture`: a pure
// `AtlassianHttpBodyPort` over a synthetic project model. No network, no atlassian.net, no
// timers. It reproduces the transport contract faithfully — token pagination for
// `/rest/api/3/search/jql` (`nextPageToken`, no `total`), offset pagination for issue comments
// (`startAt`/`maxResults`/`total`), per-request `maxBodyBytes` truncation (bytes are never served
// past the cap), closed status responses, and per-request override hooks for the error matrix
// (401/403/404/429 + Retry-After/5xx sequences, malformed payloads). Exported from the package
// barrel exactly like the Confluence fixture so keiko-server's composition tests reuse the same
// fixture project instead of growing a second one.

import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";

export interface JiraFixtureComment {
  readonly author: string;
  readonly created: string;
  readonly bodyAdf: unknown;
}

export interface JiraFixtureIssue {
  // Stable numeric issue id (identity; survives project moves that change the key).
  readonly issueId: string;
  readonly key: string;
  readonly summary: string;
  // Provider `updated` timestamp, verbatim Jira format (e.g. "2026-05-01T10:22:33.000+0000").
  readonly updated: string;
  readonly descriptionAdf?: unknown;
  readonly comments?: readonly JiraFixtureComment[];
  // Extra raw issue fields merged into the issue payload (status, issuetype, assignee, labels,
  // priority, timetracking, parent, subtasks, issuelinks, ...). Absent fields stay absent so
  // fixtures cover issues WITH and WITHOUT the optional metadata.
  readonly extraFields?: Readonly<Record<string, unknown>> | undefined;
  // Force the issue GET to answer this HTTP status (403/404/500, ...).
  readonly bodyStatus?: number | undefined;
  // Serve an unparseable issue payload (malformed-payload classification).
  readonly malformedBody?: boolean | undefined;
}

export interface JiraFixtureProject {
  readonly key: string;
  readonly issues: readonly JiraFixtureIssue[];
}

export interface InMemoryJiraFixtureOptions {
  readonly baseUrl: string;
  readonly projects: readonly JiraFixtureProject[];
  // Search page size; smaller than the issue count forces `nextPageToken` pagination (defaults
  // to 10 so a ≥30-issue project exercises pagination).
  readonly searchPageSize?: number | undefined;
  readonly commentPageSize?: number | undefined;
  // Targeted transport override: return a result to short-circuit a matching request (rate-limit
  // sequences, auth revocation), or undefined to fall through to the model.
  readonly override?:
    ((request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined) | undefined;
  readonly onRequest?: ((request: AtlassianHttpBodyRequest) => void) | undefined;
}

const DEFAULT_SEARCH_PAGE_SIZE = 10;
const DEFAULT_COMMENT_PAGE_SIZE = 100;

function jsonResult(
  request: AtlassianHttpBodyRequest,
  status: number,
  payload: unknown,
): AtlassianHttpBodyResult {
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  const cap = Math.max(0, Math.trunc(request.maxBodyBytes));
  const truncated = bytes.length > cap;
  const served = truncated ? bytes.subarray(0, cap) : bytes;
  return {
    kind: "response",
    status,
    bodyText: new TextDecoder("utf-8", { fatal: false }).decode(served),
    bodyBytes: served.length,
    truncated,
  };
}

function statusResult(request: AtlassianHttpBodyRequest, status: number): AtlassianHttpBodyResult {
  return jsonResult(request, status, { status });
}

interface FixtureModel {
  readonly orderedIssues: readonly JiraFixtureIssue[];
  readonly issuesByIdOrKey: ReadonlyMap<string, JiraFixtureIssue>;
}

function buildModel(projects: readonly JiraFixtureProject[]): FixtureModel {
  const orderedIssues: JiraFixtureIssue[] = [];
  const issuesByIdOrKey = new Map<string, JiraFixtureIssue>();
  for (const project of projects) {
    for (const issue of project.issues) {
      orderedIssues.push(issue);
      issuesByIdOrKey.set(issue.issueId, issue);
      issuesByIdOrKey.set(issue.key, issue);
    }
  }
  return { orderedIssues, issuesByIdOrKey };
}

// The complete field payload one fixture issue can serve; a search page narrows it to the
// requested `fields` list exactly like Jira Cloud does.
function fullIssueFields(issue: JiraFixtureIssue): Record<string, unknown> {
  return {
    summary: issue.summary,
    updated: issue.updated,
    ...(issue.descriptionAdf === undefined ? {} : { description: issue.descriptionAdf }),
    ...(issue.extraFields ?? {}),
  };
}

// `/rest/api/3/search/jql` result page: issues in stable model order with exactly the REQUESTED
// fields served (the sync enumeration asks for `summary,updated`; the live search (#2248) asks
// for the full metadata field list), `nextPageToken` present exactly while more pages remain.
function searchPage(model: FixtureModel, url: URL, pageSize: number): unknown {
  const token = url.searchParams.get("nextPageToken") ?? "0";
  const parsed = Number.parseInt(token, 10);
  const start = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const requested = (url.searchParams.get("fields") ?? "summary,updated").split(",");
  const slice = model.orderedIssues.slice(start, start + pageSize);
  const issues = slice.map((issue) => {
    const full = fullIssueFields(issue);
    return {
      id: issue.issueId,
      key: issue.key,
      fields: Object.fromEntries(
        requested.filter((field) => field in full).map((field) => [field, full[field]]),
      ),
    };
  });
  const nextStart = start + pageSize;
  const isLast = nextStart >= model.orderedIssues.length;
  return {
    issues,
    isLast,
    ...(isLast ? {} : { nextPageToken: String(nextStart) }),
  };
}

function issuePayload(issue: JiraFixtureIssue): unknown {
  return {
    id: issue.issueId,
    key: issue.key,
    fields: fullIssueFields(issue),
  };
}

function commentsPage(issue: JiraFixtureIssue, url: URL, pageSize: number): unknown {
  const startAtRaw = Number.parseInt(url.searchParams.get("startAt") ?? "0", 10);
  const startAt = Number.isFinite(startAtRaw) && startAtRaw > 0 ? startAtRaw : 0;
  const all = issue.comments ?? [];
  const slice = all.slice(startAt, startAt + pageSize);
  return {
    startAt,
    maxResults: pageSize,
    total: all.length,
    comments: slice.map((comment, index) => ({
      id: `${issue.issueId}-comment-${String(startAt + index)}`,
      author: { displayName: comment.author },
      created: comment.created,
      body: comment.bodyAdf,
    })),
  };
}

function routeIssueRequest(
  model: FixtureModel,
  request: AtlassianHttpBodyRequest,
  rest: string,
  url: URL,
  commentPageSize: number,
): AtlassianHttpBodyResult {
  const commentsMatch = /^([^/]+)\/comment$/u.exec(rest);
  if (commentsMatch !== null) {
    const issue = model.issuesByIdOrKey.get(commentsMatch[1] ?? "");
    if (issue === undefined) return statusResult(request, 404);
    return jsonResult(request, 200, commentsPage(issue, url, commentPageSize));
  }
  const issue = /^[^/]+$/u.test(rest) ? model.issuesByIdOrKey.get(rest) : undefined;
  if (issue === undefined) return statusResult(request, 404);
  if (issue.bodyStatus !== undefined) return statusResult(request, issue.bodyStatus);
  if (issue.malformedBody === true) {
    return {
      kind: "response",
      status: 200,
      bodyText: "<not-json@all",
      bodyBytes: 13,
      truncated: false,
    };
  }
  return jsonResult(request, 200, issuePayload(issue));
}

function routeRequest(
  model: FixtureModel,
  apiPathPrefix: string,
  options: InMemoryJiraFixtureOptions,
  request: AtlassianHttpBodyRequest,
): AtlassianHttpBodyResult {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(apiPathPrefix)) return statusResult(request, 404);
  const rest = path.slice(apiPathPrefix.length);
  if (rest === "search/jql") {
    return jsonResult(
      request,
      200,
      searchPage(model, url, options.searchPageSize ?? DEFAULT_SEARCH_PAGE_SIZE),
    );
  }
  if (rest.startsWith("issue/")) {
    return routeIssueRequest(
      model,
      request,
      rest.slice("issue/".length),
      url,
      options.commentPageSize ?? DEFAULT_COMMENT_PAGE_SIZE,
    );
  }
  return statusResult(request, 404);
}

// Build the deterministic fixture transport for one synthetic Jira site.
export function createInMemoryJiraFixture(
  options: InMemoryJiraFixtureOptions,
): AtlassianHttpBodyPort {
  const base = new URL(options.baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const apiPathPrefix = `${basePath}/rest/api/3/`;
  const model = buildModel(options.projects);
  return (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    options.onRequest?.(request);
    const overridden = options.override?.(request);
    if (overridden !== undefined) return Promise.resolve(overridden);
    return Promise.resolve(routeRequest(model, apiPathPrefix, options, request));
  };
}

// ─── Hostile ADF corpus builder (shared by adapter and composition tests) ─────
// A deterministic ≥`totalNodes`-node ADF document mixing breadth (paragraph/text pairs) with a
// 100-deep blockquote chain — the acceptance criteria's "10k-node hostile document". The chain
// deliberately exceeds the converter's depth cap so the full stack proves the bounded-degradation
// path: the document indexes with an explicit conversion-truncation marker, never a crash or
// hang.
export function buildHostileJiraAdfDocument(totalNodes: number): unknown {
  const breadthPairs = Math.max(1, Math.floor((totalNodes - 120) / 2));
  const paragraphs = Array.from({ length: breadthPairs }, (_, index) => ({
    type: "paragraph",
    content: [{ type: "text", text: `hostile breadth node ${String(index)}` }],
  }));
  let deep: Record<string, unknown> = {
    type: "paragraph",
    content: [{ type: "text", text: "hostile depth tail" }],
  };
  for (let level = 0; level < 100; level += 1) {
    deep = { type: "blockquote", content: [deep] };
  }
  return { type: "doc", version: 1, content: [...paragraphs, deep] };
}
