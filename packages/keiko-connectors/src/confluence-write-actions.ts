// Governed Confluence write executors (Issue #2244, Epic #2238, ADR-0128 D3/D4). Exact endpoints
// (Atlassian Cloud REST v2; every request stays on the connector's single allowlisted host):
//
//   - create-page:       POST {base}/wiki/api/v2/pages
//   - update-page:       PUT  {base}/wiki/api/v2/pages/{pageId}
//   - add-page-comment:  POST {base}/wiki/api/v2/footer-comments
//
// Same shape as the Jira executors: bounded fail-closed input validation, deterministic
// plain-text→storage-format body composition (shared markdown-lite dialect, fully escaped — no
// model call anywhere), the one method-aware D3 retry helper, and typed content-free results.
//
// Concurrency (Issue #2244 Scope 4): `update-page` sends an optimistic version bump — the caller
// supplies the version it believes is current and the executor writes `currentVersion + 1`; a
// provider 409 maps to the typed `conflict` result so the caller can re-read and re-decide,
// never overwrite blind. The v2 API addresses spaces and pages by their NUMERIC ids (space keys
// are a v1/UI concept); callers resolve keys to ids before invoking these executors.

import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  asRecord,
  asString,
  atlassianApiEndpointsFor,
  atlassianApiUrl,
} from "./atlassian-sync-classify.js";
import {
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import type { AtlassianWriteActionFailure } from "./jira-write-actions.js";
import { composePlainTextToStorageFormat } from "./plain-text-to-storage-format.js";

const CONFLUENCE_API_ROOT = "/wiki/api/v2/";
export const CONFLUENCE_TITLE_MAX_CHARS = 255;
const NUMERIC_ID_PATTERN = /^[0-9]{1,32}$/u;
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export interface ConfluenceWriteActionDeps {
  readonly http: AtlassianHttpBodyPort;
  readonly baseUrl: string;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface CreateConfluencePageInput {
  // Numeric v2 space id (not the space key).
  readonly spaceId: string;
  readonly parentId?: string | undefined;
  readonly title: string;
  readonly bodyText: string;
}

export type CreateConfluencePageResult =
  | { readonly ok: true; readonly pageId: string; readonly version: number }
  | AtlassianWriteActionFailure;

export interface UpdateConfluencePageInput {
  readonly pageId: string;
  readonly title: string;
  readonly bodyText: string;
  // The version the caller believes is current; the executor writes `currentVersion + 1`.
  readonly currentVersion: number;
}

export type UpdateConfluencePageResult =
  | { readonly ok: true; readonly pageId: string; readonly version: number }
  | AtlassianWriteActionFailure;

export interface AddConfluencePageCommentInput {
  readonly pageId: string;
  readonly commentText: string;
}

export type AddConfluencePageCommentResult =
  { readonly ok: true; readonly commentId: string } | AtlassianWriteActionFailure;

const FIELD_VALIDATION: AtlassianWriteActionFailure = { ok: false, reason: "field-validation" };

function isBoundedTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CONFLUENCE_TITLE_MAX_CHARS &&
    !CONTROL_CHARS_PATTERN.test(value)
  );
}

// Composer rejections map onto the closed failure vocabulary exactly as the Jira executors map
// them: oversized input is a bounds violation; control characters are a field-validation failure.
function composeBody(
  text: string,
): { readonly ok: true; readonly xhtml: string } | AtlassianWriteActionFailure {
  const composed = composePlainTextToStorageFormat(text);
  if (composed.ok) return composed;
  return {
    ok: false,
    reason: composed.reason === "input-too-large" ? "bounds-exceeded" : "field-validation",
  };
}

function failureOf(outcome: AtlassianWriteHttpOutcome): AtlassianWriteActionFailure {
  if (outcome.ok) return { ok: false, reason: "malformed-payload" };
  return {
    ok: false,
    reason: outcome.reason,
    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
  };
}

function pagesUrl(deps: ConfluenceWriteActionDeps, relative: string): string {
  return atlassianApiUrl(atlassianApiEndpointsFor(deps.baseUrl, CONFLUENCE_API_ROOT), relative);
}

function storageBody(xhtml: string): Record<string, unknown> {
  return { representation: "storage", value: xhtml };
}

function createdPageOf(
  outcome: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
): { readonly pageId: string; readonly version: number } | undefined {
  const pageId = asString(outcome.body?.id);
  const version = asRecord(outcome.body?.version)?.number;
  if (pageId === undefined || !NUMERIC_ID_PATTERN.test(pageId)) return undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return undefined;
  }
  return { pageId, version };
}

// POST /wiki/api/v2/pages — create one page (space, optional parent, title, composed storage
// body). The response is read minimally: the created page id and version number.
export async function createConfluencePage(
  deps: ConfluenceWriteActionDeps,
  input: CreateConfluencePageInput,
): Promise<CreateConfluencePageResult> {
  const parentValid = input.parentId === undefined || NUMERIC_ID_PATTERN.test(input.parentId);
  if (!NUMERIC_ID_PATTERN.test(input.spaceId) || !parentValid || !isBoundedTitle(input.title)) {
    return FIELD_VALIDATION;
  }
  const body = composeBody(input.bodyText);
  if (!body.ok) return body;
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "POST",
    url: pagesUrl(deps, "pages"),
    bodyJson: JSON.stringify({
      spaceId: input.spaceId,
      status: "current",
      title: input.title,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      body: storageBody(body.xhtml),
    }),
    expect: "json",
  });
  if (!outcome.ok) return failureOf(outcome);
  const created = createdPageOf(outcome);
  if (created === undefined) {
    return { ok: false, reason: "malformed-payload", httpStatus: outcome.status };
  }
  return { ok: true, ...created };
}

// PUT /wiki/api/v2/pages/{pageId} — optimistic-version update. A stale `currentVersion` answers
// the provider's 409, mapped to the typed `conflict` result (Issue #2244 Scope 4). Idempotent
// under the D3 retry rule: a replay of the same version bump lands as `conflict`, never a
// double-apply.
export async function updateConfluencePage(
  deps: ConfluenceWriteActionDeps,
  input: UpdateConfluencePageInput,
): Promise<UpdateConfluencePageResult> {
  const versionValid =
    Number.isSafeInteger(input.currentVersion) &&
    input.currentVersion >= 1 &&
    input.currentVersion < Number.MAX_SAFE_INTEGER;
  if (!NUMERIC_ID_PATTERN.test(input.pageId) || !isBoundedTitle(input.title) || !versionValid) {
    return FIELD_VALIDATION;
  }
  const body = composeBody(input.bodyText);
  if (!body.ok) return body;
  const nextVersion = input.currentVersion + 1;
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "PUT",
    url: pagesUrl(deps, `pages/${input.pageId}`),
    bodyJson: JSON.stringify({
      id: input.pageId,
      status: "current",
      title: input.title,
      body: storageBody(body.xhtml),
      version: { number: nextVersion },
    }),
    expect: "none",
  });
  return outcome.ok ? { ok: true, pageId: input.pageId, version: nextVersion } : failureOf(outcome);
}

// POST /wiki/api/v2/footer-comments — additive footer comment on one page.
export async function addConfluencePageComment(
  deps: ConfluenceWriteActionDeps,
  input: AddConfluencePageCommentInput,
): Promise<AddConfluencePageCommentResult> {
  if (!NUMERIC_ID_PATTERN.test(input.pageId)) return FIELD_VALIDATION;
  const body = composeBody(input.commentText);
  if (!body.ok) return body;
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "POST",
    url: pagesUrl(deps, "footer-comments"),
    bodyJson: JSON.stringify({ pageId: input.pageId, body: storageBody(body.xhtml) }),
    expect: "json",
  });
  if (!outcome.ok) return failureOf(outcome);
  const commentId = asString(outcome.body?.id);
  if (commentId === undefined || !NUMERIC_ID_PATTERN.test(commentId)) {
    return { ok: false, reason: "malformed-payload", httpStatus: outcome.status };
  }
  return { ok: true, commentId };
}
