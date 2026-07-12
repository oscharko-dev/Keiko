// Confluence Cloud v2 REST sync adapter (Issue #2242, Epic #2238, ADR-0128 D3/D5).
//
// Implements the provider-agnostic `AtlassianSyncSource` seam over the injected bounded-body
// transport. Exact endpoints used (Atlassian Cloud REST v2, recorded per the issue's engineering
// note; every request stays on the connector's single allowlisted host):
//
//   - Space resolution:   GET {base}/wiki/api/v2/spaces?keys={k1},{k2}&limit=250
//   - Pages per space:    GET {base}/wiki/api/v2/spaces/{spaceId}/pages?limit=100
//   - Page body:          GET {base}/wiki/api/v2/pages/{pageId}?body-format=storage
//   - Footer comments:    GET {base}/wiki/api/v2/pages/{pageId}/footer-comments?body-format=storage&limit=100
//
// Cursor pagination follows `_links.next` (a same-site path+query). A cursor that resolves
// off-host, off-scheme, or outside the `/wiki/api/v2/` API root is refused fail-closed
// (`scope-exceeded`) — pagination can never widen egress beyond the allowlisted base URL.
//
// Normalization: the storage-format XHTML body is wrapped into ONE complete HTML document
// (`<title>` + `<main>` + a trailing comments section) so it flows through the EXISTING
// keiko-local-knowledge HTML parser downstream — no second HTML parsing path exists in this lane.
// Item identity is the stable `confluence:<connectorId>:<pageId>` key; the mount path
// `pages/<pageId>.html` is derived from the page id only, so title renames never move the
// document (fingerprints and citations survive renames).
//
// Fail-closed classification: scope-level failures (space resolution, page enumeration) fail the
// RUN — a silently narrowed approved scope would misreport removals; page-level failures degrade
// the run to partial (403 → permission-denied skip, 404 → missing/removed, truncated body →
// bounds-exceeded skip, unparseable payload → malformed-payload skip). Comment retrieval is
// supplementary enrichment: a failed or oversized comments read never fails its page (the page
// body remains the citable artifact) — except a 401, which is always run-fatal.

import {
  isSafeAtlassianIdentifier,
  isSafeConfluenceSpaceKey,
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
  type AtlassianSyncFetchContext,
  type AtlassianSyncItemFetchOutcome,
  type AtlassianSyncEnumerationOutcome,
  type AtlassianSyncItemRef,
  type AtlassianSyncSource,
} from "./atlassian-sync-lane.js";

// Response cap for list/JSON-metadata requests (spaces, page listings, comment listings). Page
// bodies use the larger per-item cap.
export const CONFLUENCE_LIST_RESPONSE_MAX_BYTES = 1_000_000;
// Hard ceiling on cursor-following per pagination loop: a hostile or looping `_links.next` chain
// terminates the run as malformed instead of spinning until the duration budget. A repeated
// cursor is also classified as `malformed-payload` immediately (below), so a self-referential
// A→A or A→B→A chain fails closed after two requests rather than 500.
const MAX_PAGINATION_REQUESTS = 500;
// Footer-comment pages harvested per item (bounded enrichment).
const MAX_COMMENT_PAGES_PER_ITEM = 10;
const MAX_TITLE_CHARS = 500;

const CONFLUENCE_API_ROOT = "/wiki/api/v2/";
const NUMERIC_ID_PATTERN = /^\d{1,32}$/u;

export interface ConfluenceSyncSourceOptions {
  readonly baseUrl: string;
  readonly connectorId: string;
  readonly spaceKeys: readonly string[];
}

export interface ConfluencePageRef extends AtlassianSyncItemRef {
  readonly pageId: string;
}

// JSON narrowing, single-host URL construction, and transport classification are shared with the
// Jira adapter via atlassian-sync-classify.ts — one degradation vocabulary for every provider.
type ConfluenceEndpoints = AtlassianApiEndpoints;

function endpointsFor(baseUrl: string): ConfluenceEndpoints {
  return atlassianApiEndpointsFor(baseUrl, CONFLUENCE_API_ROOT);
}

function apiUrl(endpoints: ConfluenceEndpoints, relative: string): string {
  return atlassianApiUrl(endpoints, relative);
}

// `_links.next` must resolve to the same host AND stay under the `/wiki/api/v2/` root of the
// configured base URL; anything else is an egress-scope violation and fails closed.
function resolveNextCursorUrl(endpoints: ConfluenceEndpoints, next: unknown): string | undefined {
  const raw = asString(next);
  if (raw === undefined || raw.length === 0) return undefined;
  let target: URL;
  try {
    target = new URL(raw, endpoints.base.origin);
  } catch {
    throw new ConfluenceScopeViolation();
  }
  const allowed =
    target.protocol === "https:" &&
    target.host === endpoints.base.host &&
    target.username.length === 0 &&
    target.password.length === 0 &&
    target.pathname.startsWith(endpoints.apiRootPath);
  if (!allowed) throw new ConfluenceScopeViolation();
  return target.toString();
}

class ConfluenceScopeViolation extends Error {
  constructor() {
    super("confluence pagination cursor left the approved base URL scope");
    this.name = "ConfluenceScopeViolation";
  }
}

// ─── Paginated list walking ────────────────────────────────────────────────────
type ListWalkOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: AtlassianSyncFailureReason };

type NextCursorResult =
  { readonly ok: true; readonly url: string | undefined } | { readonly ok: false };

// Resolves the `_links.next` cursor, folding an off-scope cursor into a fail-closed result so the
// walk loop stays flat (the scope violation never surfaces there as a thrown error).
function nextCursorFrom(
  endpoints: ConfluenceEndpoints,
  body: Record<string, unknown>,
): NextCursorResult {
  try {
    return { ok: true, url: resolveNextCursorUrl(endpoints, asRecord(body._links)?.next) };
  } catch (error) {
    if (error instanceof ConfluenceScopeViolation) return { ok: false };
    throw error;
  }
}

// Walks a cursor-paginated v2 list endpoint, handing each `results` array to `onResults` (which
// returns false to stop early, e.g. once the lane's item ceiling is crossed). Fail-closed on
// off-scope cursors, on cursor chains longer than `MAX_PAGINATION_REQUESTS`, and on any repeated
// cursor URL (which indicates a self-referential loop rather than legitimate large pagination).
async function walkPaginatedList(
  context: AtlassianSyncFetchContext,
  endpoints: ConfluenceEndpoints,
  firstUrl: string,
  onResults: (results: readonly unknown[]) => boolean,
): Promise<ListWalkOutcome> {
  let url: string | undefined = firstUrl;
  let requests = 0;
  const seen = new Set<string>();
  while (url !== undefined) {
    if (requests >= MAX_PAGINATION_REQUESTS) return { ok: false, reason: "malformed-payload" };
    if (seen.has(url)) return { ok: false, reason: "malformed-payload" };
    seen.add(url);
    if (context.deadlineExceeded()) return { ok: false, reason: "timeout" };
    const result = await context.http({
      method: "GET",
      url,
      timeoutMs: ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
      maxBodyBytes: CONFLUENCE_LIST_RESPONSE_MAX_BYTES,
    });
    const page = classifyListResult(result, CONFLUENCE_LIST_RESPONSE_MAX_BYTES);
    if (!page.ok) return { ok: false, reason: page.reason };
    const results = asArray(page.body.results);
    if (results === undefined) return { ok: false, reason: "malformed-payload" };
    if (!onResults(results)) return { ok: true };
    const next = nextCursorFrom(endpoints, page.body);
    if (!next.ok) return { ok: false, reason: "scope-exceeded" };
    url = next.url;
    requests += 1;
  }
  return { ok: true };
}

// ─── Space resolution + page enumeration ──────────────────────────────────────
function collectSpaceIds(
  results: readonly unknown[],
  wanted: ReadonlySet<string>,
  into: Map<string, string>,
): void {
  for (const entry of results) {
    const record = asRecord(entry);
    const key = asString(record?.key);
    const id = asString(record?.id);
    if (record === undefined || key === undefined || id === undefined) continue;
    if (wanted.has(key) && NUMERIC_ID_PATTERN.test(id)) into.set(key, id);
  }
}

// Resolves every configured space key to its numeric space id. A configured key the token cannot
// see (absent from the response) fails the run with `permission-denied`: the approved scope must
// never silently narrow (ADR-0128 D8 honest-permissions posture).
async function resolveSpaceIds(
  context: AtlassianSyncFetchContext,
  endpoints: ConfluenceEndpoints,
  spaceKeys: readonly string[],
): Promise<
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: AtlassianSyncFailureReason }
> {
  const wanted = new Set(spaceKeys);
  const found = new Map<string, string>();
  const url = apiUrl(endpoints, `spaces?keys=${[...wanted].join(",")}&limit=250`);
  const walk = await walkPaginatedList(context, endpoints, url, (results) => {
    collectSpaceIds(results, wanted, found);
    return found.size < wanted.size;
  });
  if (!walk.ok) return { ok: false, reason: walk.reason };
  if (found.size < wanted.size) return { ok: false, reason: "permission-denied" };
  return { ok: true, ids: [...found.values()] };
}

function collectPageRefs(
  results: readonly unknown[],
  connectorId: string,
  into: ConfluencePageRef[],
  ceiling: number,
): boolean {
  for (const entry of results) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    if (record === undefined || id === undefined || !NUMERIC_ID_PATTERN.test(id)) continue;
    into.push({ itemKey: `confluence:${connectorId}:${id}`, pageId: id });
    // Stop as soon as the ceiling is crossed: the lane only needs to KNOW the scope overflows
    // its item budget (complete=false), not the full overflowing list.
    if (into.length > ceiling) return false;
  }
  return true;
}

// ─── Item normalization ────────────────────────────────────────────────────────
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"]/gu, (char) => HTML_ESCAPES[char] ?? char);
}

function boundedTitle(raw: unknown, pageId: string): string {
  const title = asString(raw)?.trim() ?? "";
  if (title.length === 0) return `Page ${pageId}`;
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
}

// `_links.webui` is kept only when it is a plain same-site path (no scheme, no host, no
// whitespace) — anything else is dropped rather than carried into citation metadata.
function safeWebuiPath(raw: unknown): string | undefined {
  const value = asString(raw);
  if (value === undefined || value.length === 0 || value.length > 2048) return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || /\s/u.test(value)) return undefined;
  return value;
}

function storageBodyOf(record: Record<string, unknown>): string | undefined {
  const body = asRecord(record.body);
  const storage = asRecord(body?.storage);
  return asString(storage?.value);
}

function commentsSection(commentBodies: readonly string[]): string {
  if (commentBodies.length === 0) return "";
  const items = commentBodies
    .map((body) => `<section data-connector-comment="true">${body}</section>`)
    .join("");
  return `<section data-connector-comments="true"><h2>Comments</h2>${items}</section>`;
}

// One complete HTML document per page so the existing HTML parser captures the title, heading
// structure, and comment sections through the single shared parsing path.
function composePageHtml(title: string, storageBody: string, comments: readonly string[]): string {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>',
    escapeHtmlText(title),
    "</title></head><body><main>",
    storageBody,
    commentsSection(comments),
    "</main></body></html>",
  ].join("");
}

// ─── Per-page fetch ────────────────────────────────────────────────────────────
interface PagePayload {
  readonly title: string;
  readonly storageBody: string;
  readonly webuiPath: string | undefined;
}

type PageFetchResult =
  | { readonly kind: "payload"; readonly payload: PagePayload }
  | { readonly kind: "missing" }
  | { readonly kind: "skipped"; readonly reason: AtlassianSyncFailureReason }
  | { readonly kind: "fatal"; readonly reason: AtlassianSyncFailureReason };

function classifyPageFailureStatus(status: number): PageFetchResult {
  if (status === 401) return { kind: "fatal", reason: "auth-failed" };
  if (status === 404) return { kind: "missing" };
  return { kind: "skipped", reason: failureReasonForStatus(status) };
}

function parsePagePayload(bodyText: string, pageId: string): PageFetchResult {
  const record = parseJsonRecord(bodyText);
  const storageBody = record === undefined ? undefined : storageBodyOf(record);
  if (record === undefined || storageBody === undefined) {
    return { kind: "skipped", reason: "malformed-payload" };
  }
  return {
    kind: "payload",
    payload: {
      title: boundedTitle(record.title, pageId),
      storageBody,
      webuiPath: safeWebuiPath(asRecord(record._links)?.webui),
    },
  };
}

async function fetchPagePayload(
  context: AtlassianSyncFetchContext,
  endpoints: ConfluenceEndpoints,
  pageId: string,
): Promise<PageFetchResult> {
  const result = await context.http({
    method: "GET",
    url: apiUrl(endpoints, `pages/${pageId}?body-format=storage`),
    timeoutMs: ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
    maxBodyBytes: ATLASSIAN_SYNC_ITEM_MAX_BYTES,
  });
  if (result.kind === "timeout") return { kind: "skipped", reason: "timeout" };
  if (result.kind === "network-error") return { kind: "skipped", reason: "unavailable" };
  if (result.status < 200 || result.status >= 300) {
    return classifyPageFailureStatus(result.status);
  }
  // A truncated page body can never be indexed (mid-tag truncation is malformed by construction):
  // the page is skipped with `bounds-exceeded`, the run continues (the AC's oversized-page case).
  if (result.truncated) return { kind: "skipped", reason: "bounds-exceeded" };
  return parsePagePayload(result.bodyText, pageId);
}

function collectCommentBodies(
  results: readonly unknown[],
  into: string[],
  byteAllowance: { remaining: number },
): boolean {
  for (const entry of results) {
    const record = asRecord(entry);
    const body = record === undefined ? undefined : storageBodyOf(record);
    if (body === undefined || body.length === 0) continue;
    const size = new TextEncoder().encode(body).length;
    if (size > byteAllowance.remaining) return false;
    byteAllowance.remaining -= size;
    into.push(body);
  }
  return true;
}

// Footer comments are bounded enrichment: harvested until the per-item byte allowance or page
// ceiling is reached, and ANY comment-lane failure (except 401, which is run-fatal upstream via
// the page fetch) degrades to "page without comments" rather than failing the page.
async function fetchCommentBodies(
  context: AtlassianSyncFetchContext,
  endpoints: ConfluenceEndpoints,
  pageId: string,
  byteAllowanceRemaining: number,
): Promise<readonly string[]> {
  const bodies: string[] = [];
  const allowance = { remaining: Math.max(0, byteAllowanceRemaining) };
  if (allowance.remaining > 0) {
    let pages = 0;
    const url = apiUrl(endpoints, `pages/${pageId}/footer-comments?body-format=storage&limit=100`);
    await walkPaginatedList(context, endpoints, url, (results) => {
      pages += 1;
      if (!collectCommentBodies(results, bodies, allowance)) return false;
      return pages < MAX_COMMENT_PAGES_PER_ITEM;
    });
  }
  return bodies;
}

// ─── The AtlassianSyncSource implementation ───────────────────────────────────
function validateSourceOptions(options: ConfluenceSyncSourceOptions): void {
  const errors: string[] = [];
  if (!isSafeAtlassianIdentifier(options.connectorId)) {
    errors.push("connectorId must be a safe identifier token");
  }
  if (options.spaceKeys.length === 0) {
    errors.push("spaceKeys must contain at least one space key");
  }
  if (!options.spaceKeys.every((key) => isSafeConfluenceSpaceKey(key))) {
    errors.push("spaceKeys must be valid Confluence space keys");
  }
  if (errors.length > 0) {
    throw new AtlassianCredentialCustodyError("invalid-input", errors);
  }
}

async function enumerateConfluencePages(
  context: AtlassianSyncFetchContext,
  endpoints: ConfluenceEndpoints,
  options: ConfluenceSyncSourceOptions,
): Promise<AtlassianSyncEnumerationOutcome<ConfluencePageRef>> {
  const spaces = await resolveSpaceIds(context, endpoints, options.spaceKeys);
  if (!spaces.ok) return { ok: false, reason: spaces.reason };
  const refs: ConfluencePageRef[] = [];
  for (const spaceId of spaces.ids) {
    const url = apiUrl(endpoints, `spaces/${spaceId}/pages?limit=100`);
    const walk = await walkPaginatedList(context, endpoints, url, (results) =>
      collectPageRefs(results, options.connectorId, refs, context.maxItems),
    );
    if (!walk.ok) return { ok: false, reason: walk.reason };
    if (refs.length > context.maxItems) return { ok: true, refs, complete: false };
  }
  return { ok: true, refs, complete: true };
}

async function fetchConfluenceItem(
  ref: ConfluencePageRef,
  context: AtlassianSyncFetchContext,
  endpoints: ConfluenceEndpoints,
): Promise<AtlassianSyncItemFetchOutcome> {
  const page = await fetchPagePayload(context, endpoints, ref.pageId);
  if (page.kind === "missing") return { kind: "missing" };
  if (page.kind === "fatal") return { kind: "fatal", reason: page.reason };
  if (page.kind === "skipped") return { kind: "skipped", reason: page.reason };
  const bodyBytes = page.payload.storageBody.length;
  const comments = await fetchCommentBodies(
    context,
    endpoints,
    ref.pageId,
    ATLASSIAN_SYNC_ITEM_MAX_BYTES - bodyBytes,
  );
  const contentHtml = composePageHtml(page.payload.title, page.payload.storageBody, comments);
  return {
    kind: "item",
    item: {
      itemKey: ref.itemKey,
      title: page.payload.title,
      relativePath: `pages/${ref.pageId}.html`,
      contentHtml,
      byteLength: new TextEncoder().encode(contentHtml).length,
      ...(page.payload.webuiPath === undefined ? {} : { webuiPath: page.payload.webuiPath }),
    },
  };
}

// Build the Confluence sync source for one connector scope. Transport, budget, deadline, retry,
// and cancellation all arrive through the lane's per-run context — the source holds no transport
// state of its own.
export function createConfluenceSyncSource(
  options: ConfluenceSyncSourceOptions,
): AtlassianSyncSource<ConfluencePageRef> {
  validateSourceOptions(options);
  const endpoints = endpointsFor(options.baseUrl);
  return {
    enumerate: (
      context: AtlassianSyncFetchContext,
    ): Promise<AtlassianSyncEnumerationOutcome<ConfluencePageRef>> =>
      enumerateConfluencePages(context, endpoints, options),
    fetchItem: (
      ref: ConfluencePageRef,
      context: AtlassianSyncFetchContext,
    ): Promise<AtlassianSyncItemFetchOutcome> => fetchConfluenceItem(ref, context, endpoints),
  };
}
