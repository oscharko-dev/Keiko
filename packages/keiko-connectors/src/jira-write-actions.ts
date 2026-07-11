// Governed Jira write executors (Issue #2244, Epic #2238, ADR-0128 D3/D4). Exact endpoints
// (Atlassian Cloud REST v3; every request stays on the connector's single allowlisted host):
//
//   - create-issue:         POST {base}/rest/api/3/issue
//   - update-issue-fields:  PUT  {base}/rest/api/3/issue/{issueKey}
//   - transition-issue:     GET  {base}/rest/api/3/issue/{issueKey}/transitions
//                           POST {base}/rest/api/3/issue/{issueKey}/transitions
//   - add-issue-comment:    POST {base}/rest/api/3/issue/{issueKey}/comment
//
// Executors are pure orchestration over the injected credential-blind transport port: they
// validate bounded inputs fail-closed, compose description/comment bodies deterministically via
// the shared plain-text→ADF composer (no model call anywhere), execute through the one
// method-aware D3 retry helper, and return typed, content-free results — a closed reason and the
// upstream HTTP status, never a provider error message, body, or header. Transition matching is
// BY ID against the issue's available transitions (never by localized display name); an
// unavailable id is the typed `invalid-transition` result before any mutating request is sent.
//
// Credentials never appear here: the port materialises the Authorization header at execution
// time (ADR-0128 D2), and these executors receive only the port and the validated base URL.

import {
  isSafeAtlassianIdentifier,
  isSafeJiraProjectKey,
  type AtlassianConnectorWriteFailureReason,
} from "@oscharko-dev/keiko-contracts";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  asArray,
  asRecord,
  asString,
  atlassianApiEndpointsFor,
  atlassianApiUrl,
} from "./atlassian-sync-classify.js";
import {
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import { composePlainTextToAdf, type AdfComposedDocument } from "./plain-text-to-adf.js";

const JIRA_API_ROOT = "/rest/api/3/";
export const JIRA_SUMMARY_MAX_CHARS = 255;
export const JIRA_ISSUE_LABELS_MAX_ENTRIES = 20;
const FIELD_TEXT_MAX_CHARS = 100;
const NUMERIC_ID_PATTERN = /^\d{1,32}$/u;
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

// The shared typed failure arm every write executor (Jira and Confluence) returns. The reason
// vocabulary is the closed contract union, so the server's activity records and wire results
// carry these codes without re-mapping.
export interface AtlassianWriteActionFailure {
  readonly ok: false;
  readonly reason: AtlassianConnectorWriteFailureReason;
  readonly httpStatus?: number | undefined;
}

export interface JiraWriteActionDeps {
  readonly http: AtlassianHttpBodyPort;
  readonly baseUrl: string;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface CreateJiraIssueInput {
  readonly projectKey: string;
  // Exactly one of the two selects the issue type; the id form is preferred (locale-stable).
  readonly issueTypeId?: string | undefined;
  readonly issueTypeName?: string | undefined;
  readonly summary: string;
  readonly descriptionText?: string | undefined;
}

export type CreateJiraIssueResult =
  | { readonly ok: true; readonly issueKey: string; readonly issueId: string }
  | AtlassianWriteActionFailure;

export interface UpdateJiraIssueFieldsInput {
  readonly issueKey: string;
  readonly summary?: string | undefined;
  readonly descriptionText?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly priorityName?: string | undefined;
}

export type UpdateJiraIssueFieldsResult = { readonly ok: true } | AtlassianWriteActionFailure;

export interface TransitionJiraIssueInput {
  readonly issueKey: string;
  readonly transitionId: string;
}

export type TransitionJiraIssueResult =
  { readonly ok: true; readonly transitionId: string } | AtlassianWriteActionFailure;

export interface AddJiraIssueCommentInput {
  readonly issueKey: string;
  readonly commentText: string;
}

export type AddJiraIssueCommentResult =
  { readonly ok: true; readonly commentId: string } | AtlassianWriteActionFailure;

const FIELD_VALIDATION: AtlassianWriteActionFailure = { ok: false, reason: "field-validation" };

function isBoundedSingleLineText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !CONTROL_CHARS_PATTERN.test(value)
  );
}

// Composer rejections map onto the closed failure vocabulary: oversized input is a bounds
// violation; control characters are a field-validation failure.
function composeDescription(
  text: string,
): { readonly ok: true; readonly doc: AdfComposedDocument } | AtlassianWriteActionFailure {
  const composed = composePlainTextToAdf(text);
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

function issueUrl(deps: JiraWriteActionDeps, relative: string): string {
  return atlassianApiUrl(atlassianApiEndpointsFor(deps.baseUrl, JIRA_API_ROOT), relative);
}

function issueTypeField(input: CreateJiraIssueInput): Record<string, string> | undefined {
  if (input.issueTypeId !== undefined) {
    return NUMERIC_ID_PATTERN.test(input.issueTypeId) ? { id: input.issueTypeId } : undefined;
  }
  if (input.issueTypeName !== undefined) {
    return isBoundedSingleLineText(input.issueTypeName, FIELD_TEXT_MAX_CHARS)
      ? { name: input.issueTypeName }
      : undefined;
  }
  return undefined;
}

// Builds the create-issue `fields` payload fail-closed.
function createIssueFields(
  input: CreateJiraIssueInput,
): { readonly ok: true; readonly fields: Record<string, unknown> } | AtlassianWriteActionFailure {
  const issuetype = issueTypeField(input);
  if (
    !isSafeJiraProjectKey(input.projectKey) ||
    issuetype === undefined ||
    !isBoundedSingleLineText(input.summary, JIRA_SUMMARY_MAX_CHARS)
  ) {
    return FIELD_VALIDATION;
  }
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype,
    summary: input.summary,
  };
  if (input.descriptionText !== undefined) {
    const description = composeDescription(input.descriptionText);
    if (!description.ok) return description;
    fields.description = description.doc;
  }
  return { ok: true, fields };
}

// The created id/key are re-validated as identifiers before they can ride into any result.
function createdIssueOf(
  body: Record<string, unknown> | undefined,
): { readonly issueKey: string; readonly issueId: string } | undefined {
  const issueKey = asString(body?.key);
  const issueId = asString(body?.id);
  if (issueKey === undefined || !isSafeAtlassianIdentifier(issueKey)) return undefined;
  if (issueId === undefined || !NUMERIC_ID_PATTERN.test(issueId)) return undefined;
  return { issueKey, issueId };
}

// POST /rest/api/3/issue — create one issue in the given project. The response is read minimally:
// the created issue id and key only.
export async function createJiraIssue(
  deps: JiraWriteActionDeps,
  input: CreateJiraIssueInput,
): Promise<CreateJiraIssueResult> {
  const composed = createIssueFields(input);
  if (!composed.ok) return composed;
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "POST",
    url: issueUrl(deps, "issue"),
    bodyJson: JSON.stringify({ fields: composed.fields }),
    expect: "json",
  });
  if (!outcome.ok) return failureOf(outcome);
  const created = createdIssueOf(outcome.body);
  if (created === undefined) {
    return { ok: false, reason: "malformed-payload", httpStatus: outcome.status };
  }
  return { ok: true, ...created };
}

function updatedFieldsOf(input: UpdateJiraIssueFieldsInput): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) {
    if (!isBoundedSingleLineText(input.summary, JIRA_SUMMARY_MAX_CHARS)) return undefined;
    fields.summary = input.summary;
  }
  if (input.labels !== undefined) {
    const valid =
      input.labels.length <= JIRA_ISSUE_LABELS_MAX_ENTRIES &&
      input.labels.every((label) => isSafeAtlassianIdentifier(label));
    if (!valid) return undefined;
    fields.labels = input.labels;
  }
  if (input.priorityName !== undefined) {
    if (!isBoundedSingleLineText(input.priorityName, FIELD_TEXT_MAX_CHARS)) return undefined;
    fields.priority = { name: input.priorityName };
  }
  return fields;
}

// PUT /rest/api/3/issue/{issueKey} — bounded edits to assignable standard fields (summary,
// description, labels, priority). Idempotent: the D3 retry helper may replay it on 429/5xx.
export async function updateJiraIssueFields(
  deps: JiraWriteActionDeps,
  input: UpdateJiraIssueFieldsInput,
): Promise<UpdateJiraIssueFieldsResult> {
  if (!isSafeAtlassianIdentifier(input.issueKey)) return FIELD_VALIDATION;
  const fields = updatedFieldsOf(input);
  if (fields === undefined) return FIELD_VALIDATION;
  if (input.descriptionText !== undefined) {
    const description = composeDescription(input.descriptionText);
    if (!description.ok) return description;
    fields.description = description.doc;
  }
  if (Object.keys(fields).length === 0) return FIELD_VALIDATION;
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "PUT",
    url: issueUrl(deps, `issue/${input.issueKey}`),
    bodyJson: JSON.stringify({ fields }),
    expect: "none",
  });
  return outcome.ok ? { ok: true } : failureOf(outcome);
}

function availableTransitionIds(body: Record<string, unknown> | undefined): readonly string[] {
  const transitions = asArray(body?.transitions);
  if (transitions === undefined) return [];
  const ids: string[] = [];
  for (const entry of transitions) {
    const id = asString(asRecord(entry)?.id);
    if (id !== undefined && NUMERIC_ID_PATTERN.test(id)) ids.push(id);
  }
  return ids;
}

// GET + POST /rest/api/3/issue/{issueKey}/transitions — resolve the issue's available
// transitions first and match the requested transition BY ID (never by localized name); an id
// that is not available is the typed `invalid-transition` result and no mutating request is
// sent.
export async function transitionJiraIssue(
  deps: JiraWriteActionDeps,
  input: TransitionJiraIssueInput,
): Promise<TransitionJiraIssueResult> {
  if (!isSafeAtlassianIdentifier(input.issueKey) || !NUMERIC_ID_PATTERN.test(input.transitionId)) {
    return FIELD_VALIDATION;
  }
  const url = issueUrl(deps, `issue/${input.issueKey}/transitions`);
  const listed = await executeAtlassianWriteRequest(deps, { method: "GET", url, expect: "json" });
  if (!listed.ok) return failureOf(listed);
  if (!availableTransitionIds(listed.body).includes(input.transitionId)) {
    return { ok: false, reason: "invalid-transition" };
  }
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "POST",
    url,
    bodyJson: JSON.stringify({ transition: { id: input.transitionId } }),
    expect: "none",
  });
  return outcome.ok ? { ok: true, transitionId: input.transitionId } : failureOf(outcome);
}

// POST /rest/api/3/issue/{issueKey}/comment — additive comment composed as ADF.
export async function addJiraIssueComment(
  deps: JiraWriteActionDeps,
  input: AddJiraIssueCommentInput,
): Promise<AddJiraIssueCommentResult> {
  if (!isSafeAtlassianIdentifier(input.issueKey)) return FIELD_VALIDATION;
  const body = composeDescription(input.commentText);
  if (!body.ok) return body;
  const outcome = await executeAtlassianWriteRequest(deps, {
    method: "POST",
    url: issueUrl(deps, `issue/${input.issueKey}/comment`),
    bodyJson: JSON.stringify({ body: body.doc }),
    expect: "json",
  });
  if (!outcome.ok) return failureOf(outcome);
  const commentId = asString(outcome.body?.id);
  if (commentId === undefined || !NUMERIC_ID_PATTERN.test(commentId)) {
    return { ok: false, reason: "malformed-payload", httpStatus: outcome.status };
  }
  return { ok: true, commentId };
}
