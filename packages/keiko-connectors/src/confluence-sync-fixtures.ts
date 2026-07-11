// Deterministic in-memory Confluence Cloud v2 fixture transport (Issue #2242, Epic #2238).
//
// The sync lane's hermetic test double, mirroring `createInMemoryManualFetcher` in
// keiko-local-knowledge: a pure `AtlassianHttpBodyPort` over a synthetic space model. No network,
// no atlassian.net, no timers. It reproduces the transport contract faithfully — cursor
// pagination via `_links.next`, per-request `maxBodyBytes` truncation (bytes are never served
// past the cap), closed status responses, and per-request override hooks for the error matrix
// (401/403/404/429 + Retry-After/5xx sequences, cross-host cursors, malformed payloads).
// Exported from the package barrel exactly like the manual fixture fetcher so keiko-server's
// composition tests reuse the same fixture space instead of growing a second one.

import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";

export interface ConfluenceFixturePage {
  readonly pageId: string;
  readonly title: string;
  readonly storageBody: string;
  readonly comments?: readonly string[] | undefined;
  readonly webuiPath?: string | undefined;
  // Nested-tree shape: the listing carries `parentId` exactly as Confluence v2 does (the sync
  // lane enumerates the FLAT listing, so hierarchy must never affect coverage).
  readonly parentId?: string | undefined;
  // Force the page-body request to answer this HTTP status (403/404/500, ...).
  readonly bodyStatus?: number | undefined;
  // Serve an unparseable page-body payload (malformed-payload classification).
  readonly malformedBody?: boolean | undefined;
}

export interface ConfluenceFixtureSpace {
  readonly key: string;
  readonly id: string;
  readonly pages: readonly ConfluenceFixturePage[];
}

export interface InMemoryConfluenceFixtureOptions {
  readonly baseUrl: string;
  readonly spaces: readonly ConfluenceFixtureSpace[];
  // Page-listing page size; a value smaller than a space's page count forces `_links.next`
  // cursors (defaults to 10 so a ≥30-page space exercises pagination).
  readonly listPageSize?: number | undefined;
  // Targeted transport override: return a result to short-circuit a matching request (rate-limit
  // sequences, auth revocation, hostile cursors), or undefined to fall through to the model.
  readonly override?:
    ((request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined) | undefined;
  readonly onRequest?: ((request: AtlassianHttpBodyRequest) => void) | undefined;
}

const DEFAULT_LIST_PAGE_SIZE = 10;

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
  readonly spacesByKey: ReadonlyMap<string, ConfluenceFixtureSpace>;
  readonly spacesById: ReadonlyMap<string, ConfluenceFixtureSpace>;
  readonly pagesById: ReadonlyMap<string, ConfluenceFixturePage>;
}

function buildModel(spaces: readonly ConfluenceFixtureSpace[]): FixtureModel {
  const spacesByKey = new Map<string, ConfluenceFixtureSpace>();
  const spacesById = new Map<string, ConfluenceFixtureSpace>();
  const pagesById = new Map<string, ConfluenceFixturePage>();
  for (const space of spaces) {
    spacesByKey.set(space.key, space);
    spacesById.set(space.id, space);
    for (const page of space.pages) pagesById.set(page.pageId, page);
  }
  return { spacesByKey, spacesById, pagesById };
}

function spacesListing(model: FixtureModel, url: URL): unknown {
  const keysParam = url.searchParams.get("keys") ?? "";
  const results = keysParam
    .split(",")
    .map((key) => model.spacesByKey.get(key))
    .filter((space): space is ConfluenceFixtureSpace => space !== undefined)
    .map((space) => ({ id: space.id, key: space.key, name: `Space ${space.key}` }));
  return { results, _links: {} };
}

function pageListing(
  space: ConfluenceFixtureSpace,
  url: URL,
  apiPathPrefix: string,
  listPageSize: number,
): unknown {
  const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
  const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  const slice = space.pages.slice(start, start + listPageSize);
  const results = slice.map((page) => ({
    id: page.pageId,
    title: page.title,
    status: "current",
    parentId: page.parentId ?? null,
  }));
  const nextStart = start + listPageSize;
  const links =
    nextStart < space.pages.length
      ? {
          next: `${apiPathPrefix}spaces/${space.id}/pages?limit=100&cursor=${String(nextStart)}`,
        }
      : {};
  return { results, _links: links };
}

function pageBody(page: ConfluenceFixturePage, spaceKey: string): unknown {
  return {
    id: page.pageId,
    title: page.title,
    status: "current",
    body: { storage: { value: page.storageBody, representation: "storage" } },
    _links: {
      webui: page.webuiPath ?? `/wiki/spaces/${spaceKey}/pages/${page.pageId}`,
    },
  };
}

function commentsListing(page: ConfluenceFixturePage): unknown {
  const results = (page.comments ?? []).map((comment, index) => ({
    id: `${page.pageId}-comment-${String(index)}`,
    body: { storage: { value: comment, representation: "storage" } },
  }));
  return { results, _links: {} };
}

function spaceKeyOfPage(model: FixtureModel, pageId: string): string {
  for (const space of model.spacesById.values()) {
    if (space.pages.some((page) => page.pageId === pageId)) return space.key;
  }
  return "UNKNOWN";
}

function routePagesRequest(
  model: FixtureModel,
  request: AtlassianHttpBodyRequest,
  rest: string,
): AtlassianHttpBodyResult {
  const commentsMatch = /^(\d+)\/footer-comments$/u.exec(rest);
  if (commentsMatch !== null) {
    const page = model.pagesById.get(commentsMatch[1] ?? "");
    if (page === undefined) return statusResult(request, 404);
    return jsonResult(request, 200, commentsListing(page));
  }
  const pageMatch = /^(\d+)$/u.exec(rest);
  const page = pageMatch === null ? undefined : model.pagesById.get(pageMatch[1] ?? "");
  if (page === undefined) return statusResult(request, 404);
  if (page.bodyStatus !== undefined) return statusResult(request, page.bodyStatus);
  if (page.malformedBody === true) {
    return {
      kind: "response",
      status: 200,
      bodyText: "<not-json@all",
      bodyBytes: 13,
      truncated: false,
    };
  }
  return jsonResult(request, 200, pageBody(page, spaceKeyOfPage(model, page.pageId)));
}

function routeRequest(
  model: FixtureModel,
  apiPathPrefix: string,
  listPageSize: number,
  request: AtlassianHttpBodyRequest,
): AtlassianHttpBodyResult {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(apiPathPrefix)) return statusResult(request, 404);
  const rest = path.slice(apiPathPrefix.length);
  if (rest === "spaces") return jsonResult(request, 200, spacesListing(model, url));
  const spacePages = /^spaces\/(\d+)\/pages$/u.exec(rest);
  if (spacePages !== null) {
    const space = model.spacesById.get(spacePages[1] ?? "");
    if (space === undefined) return statusResult(request, 404);
    return jsonResult(request, 200, pageListing(space, url, apiPathPrefix, listPageSize));
  }
  if (rest.startsWith("pages/")) {
    return routePagesRequest(model, request, rest.slice("pages/".length));
  }
  return statusResult(request, 404);
}

// Build the deterministic fixture transport for one synthetic Confluence site.
export function createInMemoryConfluenceFixture(
  options: InMemoryConfluenceFixtureOptions,
): AtlassianHttpBodyPort {
  const base = new URL(options.baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const apiPathPrefix = `${basePath}/wiki/api/v2/`;
  const model = buildModel(options.spaces);
  const listPageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
  return (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    options.onRequest?.(request);
    const overridden = options.override?.(request);
    if (overridden !== undefined) return Promise.resolve(overridden);
    return Promise.resolve(routeRequest(model, apiPathPrefix, listPageSize, request));
  };
}
