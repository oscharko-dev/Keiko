// Issues #2244/#2248 (Epic #2238, ADR-0128 D4/D5/D6) — governed Confluence/Jira connector
// action BFF routes: the seven write actions plus the live JQL read.
//
//   POST /api/atlassian-connectors/credentials/:authRef/actions
//        body { action: {...one of the seven write actions...}
//                     | { type: "search-issues-live", jql? | templateId?, maxResults? },
//               authority: { runId, envelopeDigest, workspaceRoot } }   REQUIRED authority:
//        every action request resolves the validated Authority Envelope (the EXISTING
//        ADR-0125 registry — same opaque run id + envelope digest contract as the editor lane)
//        and is dispositioned by the shared D4 matrix. Responses are 200-level policy data
//        (mirroring the editor lane's not-run results):
//          allowed          → 200 { disposition, result, correlationId }   (executed; a live
//                             search additionally carries `liveSearch: JiraLiveSearchResult`)
//          review-required  → 202 { disposition, approval, correlationId } (pending, NOT executed)
//          denied           → 200 { disposition, reasonCode, correlationId }
//   GET  /api/atlassian-connectors/action-approvals                     pending approvals (#2245)
//   GET  /api/atlassian-connectors/action-approvals/:approvalId         one pending approval
//   POST /api/atlassian-connectors/action-approvals/:approvalId/approve revalidate envelope,
//        charge budget, execute NOW, answer { disposition: "review-required",
//        result [+ liveSearch] | job }
//   POST /api/atlassian-connectors/action-approvals/:approvalId/reject  record, never execute
//
// Action inputs carry composed text (summaries, descriptions, comment/page bodies) or opaque
// JQL. That text exists ONLY in the request and — for review-required dispositions — inside the
// server-side pending entry the approve endpoint consumes; it never enters approval projections,
// activity records, or error messages (ADR-0128 D6; JQL is recorded as `jqlDigest` only). A live
// search result is EPHEMERAL provider data (Issue #2248 Scope 3): returned to the caller with
// `source: "live"` + `queriedAt`, never persisted, indexed, or fingerprinted — this route family
// has no store access on the live path by construction. Credentials are resolved via the opaque
// `authRef` exclusively at execution time inside the transport-port closure (ADR-0128 D2).
// Expected failures answer typed 4xx codes; unexpected failures propagate to the server's
// top-level catch (opaque 500 + correlation id + redacted operator diagnostic — the
// `check:error-observability` contract).

import { randomUUID } from "node:crypto";
import {
  addConfluencePageComment,
  addJiraIssueComment,
  createConfluencePage,
  createJiraIssue,
  composePlainTextToAdf,
  executeJiraLiveSearch,
  resolveJiraLiveSearchJql,
  transitionJiraIssue,
  updateConfluencePage,
  updateJiraIssueFields,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianWriteActionFailure,
  type JiraLiveSearchOutcome,
  JIRA_ISSUE_LABELS_MAX_ENTRIES,
  MARKDOWN_LITE_MAX_INPUT_CHARS,
} from "@oscharko-dev/keiko-connectors";
import {
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON,
  isSafeAtlassianIdentifier,
  isSafeJiraProjectKey,
  validateJiraLiveSearchRequest,
  type AtlassianConnectorActionExecutionResult,
  type AtlassianConnectorActionType,
  type AtlassianConnectorActivityReasonCode,
  type AtlassianConnectorActionReviewReason,
  type JiraLiveSearchRequest,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { readJsonObject } from "../files.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  createAtlassianPendingApprovalResult,
  deniedAtlassianActionResult,
  recordAtlassianActionActivity,
} from "./actionActivity.js";
import {
  atlassianActionApprovalRegistry,
  type AtlassianLiveSearchPayload,
  type AtlassianWriteActionInput,
  type PendingAtlassianActionEntry,
  type PendingAtlassianActionPayload,
} from "./actionApprovals.js";
import {
  decideGovernedAtlassianAction,
  parseAtlassianActionAuthorityContext,
  reserveGovernedAtlassianAction,
  type AtlassianActionAuthorityContext,
} from "./actionPolicy.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { requireAtlassianCredential } from "./syncRoutes.js";
import {
  AtlassianSyncRequestError,
  connectorIdForAuthRef,
  startAtlassianSyncJob,
} from "./syncService.js";

// Composable body text is bounded at 100k characters; the JSON envelope around it stays well
// under this request cap even at full UTF-8 width.
const MAX_ACTION_BODY_BYTES = 512_000;
const SINGLE_LINE_TEXT_MAX_CHARS = 255;
const FIELD_TEXT_MAX_CHARS = 100;
const NUMERIC_ID_PATTERN = /^\d{1,32}$/u;
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

function unavailable(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "ATLASSIAN_CONNECTORS_UNAVAILABLE",
      "Atlassian connector credential custody is not configured for this BFF.",
    ),
  };
}

type DepsOrResult = AtlassianConnectorCredentialDeps | RouteResult;

function requireConnectorDeps(deps: UiHandlerDeps): DepsOrResult {
  return deps.atlassianConnectorCredentials ?? unavailable();
}

function isRouteResult(value: DepsOrResult | Record<string, unknown>): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

async function runHandler(work: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AtlassianSyncRequestError) {
      return { status: error.status, body: errorBody(error.code, error.message) };
    }
    throw error;
  }
}

// ─── Action input validation ───────────────────────────────────────────────────
function invalid(message: string): AtlassianSyncRequestError {
  return new AtlassianSyncRequestError(400, "VALIDATION_FAILED", message);
}

const WRITE_ACTION_KEYS: Readonly<Record<AtlassianWriteActionInput["type"], readonly string[]>> =
  Object.freeze({
    "create-issue": [
      "type",
      "projectKey",
      "issueTypeId",
      "issueTypeName",
      "summary",
      "descriptionText",
    ],
    "update-issue-fields": [
      "type",
      "issueKey",
      "summary",
      "descriptionText",
      "labels",
      "priorityName",
    ],
    "transition-issue": ["type", "issueKey", "transitionId"],
    "add-issue-comment": ["type", "issueKey", "commentText"],
    "create-page": ["type", "spaceId", "parentId", "title", "bodyText"],
    "update-page": ["type", "pageId", "title", "bodyText", "currentVersion"],
    "add-page-comment": ["type", "pageId", "commentText"],
  });

function isWriteActionType(value: unknown): value is AtlassianWriteActionInput["type"] {
  return typeof value === "string" && value in WRITE_ACTION_KEYS;
}

function requireSingleLine(value: unknown, field: string, maxChars: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    CONTROL_CHARS_PATTERN.test(value)
  ) {
    throw invalid(`${field} must be single-line text of at most ${String(maxChars)} characters`);
  }
  return value;
}

// Composable body text: validated with the SAME parser the composers run at execution time, so
// a request that passes here can never park an uncomposable payload in a pending approval.
function requireComposable(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${field} must be non-empty text`);
  }
  if (value.length > MARKDOWN_LITE_MAX_INPUT_CHARS || !composePlainTextToAdf(value).ok) {
    throw invalid(
      `${field} must be composable text of at most ${String(MARKDOWN_LITE_MAX_INPUT_CHARS)} characters without control characters`,
    );
  }
  return value;
}

function optionalComposable(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireComposable(value, field);
}

function requireNumericId(value: unknown, field: string): string {
  if (typeof value !== "string" || !NUMERIC_ID_PATTERN.test(value)) {
    throw invalid(`${field} must be a numeric provider id`);
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (!isSafeAtlassianIdentifier(value)) {
    throw invalid(`${field} must be a bounded identifier token`);
  }
  return value;
}

function validateCreateIssue(body: Record<string, unknown>): AtlassianWriteActionInput {
  if (!isSafeJiraProjectKey(body.projectKey))
    throw invalid("projectKey must be a Jira project key");
  if ((body.issueTypeId === undefined) === (body.issueTypeName === undefined)) {
    throw invalid("exactly one of issueTypeId or issueTypeName is required");
  }
  const descriptionText = optionalComposable(body.descriptionText, "descriptionText");
  return {
    type: "create-issue",
    projectKey: body.projectKey,
    ...(body.issueTypeId === undefined
      ? {
          issueTypeName: requireSingleLine(
            body.issueTypeName,
            "issueTypeName",
            FIELD_TEXT_MAX_CHARS,
          ),
        }
      : { issueTypeId: requireNumericId(body.issueTypeId, "issueTypeId") }),
    summary: requireSingleLine(body.summary, "summary", SINGLE_LINE_TEXT_MAX_CHARS),
    ...(descriptionText === undefined ? {} : { descriptionText }),
  };
}

function isValidLabelList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= JIRA_ISSUE_LABELS_MAX_ENTRIES &&
    value.every((label) => isSafeAtlassianIdentifier(label))
  );
}

function validatedLabels(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isValidLabelList(value)) {
    throw invalid(
      `labels must be at most ${String(JIRA_ISSUE_LABELS_MAX_ENTRIES)} bounded identifier tokens`,
    );
  }
  return value;
}

function optionalSingleLine(value: unknown, field: string, maxChars: number): string | undefined {
  return value === undefined ? undefined : requireSingleLine(value, field, maxChars);
}

function validateUpdateIssueFields(body: Record<string, unknown>): AtlassianWriteActionInput {
  const issueKey = requireIdentifier(body.issueKey, "issueKey");
  const summary = optionalSingleLine(body.summary, "summary", SINGLE_LINE_TEXT_MAX_CHARS);
  const descriptionText = optionalComposable(body.descriptionText, "descriptionText");
  const labels = validatedLabels(body.labels);
  const priorityName = optionalSingleLine(body.priorityName, "priorityName", FIELD_TEXT_MAX_CHARS);
  if (
    summary === undefined &&
    descriptionText === undefined &&
    labels === undefined &&
    priorityName === undefined
  ) {
    throw invalid("update-issue-fields requires at least one field");
  }
  return {
    type: "update-issue-fields",
    issueKey,
    ...(summary === undefined ? {} : { summary }),
    ...(descriptionText === undefined ? {} : { descriptionText }),
    ...(labels === undefined ? {} : { labels }),
    ...(priorityName === undefined ? {} : { priorityName }),
  };
}

function validateJiraSimpleActions(
  type: "transition-issue" | "add-issue-comment",
  body: Record<string, unknown>,
): AtlassianWriteActionInput {
  const issueKey = requireIdentifier(body.issueKey, "issueKey");
  if (type === "transition-issue") {
    return {
      type,
      issueKey,
      transitionId: requireNumericId(body.transitionId, "transitionId"),
    };
  }
  return { type, issueKey, commentText: requireComposable(body.commentText, "commentText") };
}

function validateConfluenceActions(
  type: "create-page" | "update-page" | "add-page-comment",
  body: Record<string, unknown>,
): AtlassianWriteActionInput {
  if (type === "create-page") {
    return {
      type,
      spaceId: requireNumericId(body.spaceId, "spaceId"),
      ...(body.parentId === undefined
        ? {}
        : { parentId: requireNumericId(body.parentId, "parentId") }),
      title: requireSingleLine(body.title, "title", SINGLE_LINE_TEXT_MAX_CHARS),
      bodyText: requireComposable(body.bodyText, "bodyText"),
    };
  }
  if (type === "update-page") {
    const currentVersion = body.currentVersion;
    if (
      typeof currentVersion !== "number" ||
      !Number.isSafeInteger(currentVersion) ||
      currentVersion < 1
    ) {
      throw invalid("currentVersion must be a positive integer");
    }
    return {
      type,
      pageId: requireNumericId(body.pageId, "pageId"),
      title: requireSingleLine(body.title, "title", SINGLE_LINE_TEXT_MAX_CHARS),
      bodyText: requireComposable(body.bodyText, "bodyText"),
      currentVersion,
    };
  }
  return {
    type,
    pageId: requireNumericId(body.pageId, "pageId"),
    commentText: requireComposable(body.commentText, "commentText"),
  };
}

function validateActionByType(
  type: AtlassianWriteActionInput["type"],
  body: Record<string, unknown>,
): AtlassianWriteActionInput {
  switch (type) {
    case "create-issue":
      return validateCreateIssue(body);
    case "update-issue-fields":
      return validateUpdateIssueFields(body);
    case "transition-issue":
    case "add-issue-comment":
      return validateJiraSimpleActions(type, body);
    case "create-page":
    case "update-page":
    case "add-page-comment":
      return validateConfluenceActions(type, body);
  }
}

// ─── Live-search action input (Issue #2248) ────────────────────────────────────
const LIVE_SEARCH_ACTION_KEYS: readonly string[] = ["type", "jql", "templateId", "maxResults"];

// The one non-write member of the actions union: closed key set, then the shared contract
// validator (exactly one of opaque bounded JQL or a well-known template id, plus the result-cap
// narrowing). The validated request — with its admission-time JQL digest — is what a pending
// approval parks server-side.
function validateLiveSearchActionInput(body: Record<string, unknown>): JiraLiveSearchRequest {
  const allowed = new Set(LIVE_SEARCH_ACTION_KEYS);
  if (!Object.keys(body).every((key) => allowed.has(key))) {
    throw invalid("action must not include unexpected fields");
  }
  const validated = validateJiraLiveSearchRequest({
    ...(body.jql === undefined ? {} : { jql: body.jql }),
    ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
    ...(body.maxResults === undefined ? {} : { maxResults: body.maxResults }),
  });
  if (!validated.ok) throw invalid(validated.errors.join("; "));
  return validated.value;
}

// The validated actions-route union: the #2244 write actions plus the #2248 live JQL read.
type AtlassianGovernedActionInput =
  | { readonly kind: "write"; readonly action: AtlassianWriteActionInput }
  | { readonly kind: "live-search"; readonly liveSearch: AtlassianLiveSearchPayload };

// Fail-closed action parse for the whole governed union: closed key set per action type, the
// provider must match the credential, every identifier validated, every body text composable,
// live-search requests validated by the shared contract guard. The validated value is what a
// pending approval parks server-side — garbage can never wait for a human.
function validateGovernedActionInput(
  value: unknown,
  provider: AtlassianCredentialMetadata["provider"],
): AtlassianGovernedActionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("action must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  const type = body.type;
  if (type !== "search-issues-live" && !isWriteActionType(type)) {
    throw invalid("action.type must be a governed connector action type");
  }
  if (ATLASSIAN_CONNECTOR_ACTION_PROVIDER[type] !== provider) {
    throw invalid("action.type does not match the credential's provider");
  }
  if (type === "search-issues-live") {
    const request = validateLiveSearchActionInput(body);
    return {
      kind: "live-search",
      liveSearch: { request, jqlDigest: sha256Hex(resolveJiraLiveSearchJql(request)) },
    };
  }
  const allowed = new Set(WRITE_ACTION_KEYS[type]);
  if (!Object.keys(body).every((key) => allowed.has(key))) {
    throw invalid("action must not include unexpected fields");
  }
  return { kind: "write", action: validateActionByType(type, body) };
}

// The identifier the approval projection and activity records may carry (ADR-0128 D6): the
// action's target key/id — never a summary, title, or body.
function targetRefOf(action: AtlassianWriteActionInput): string {
  switch (action.type) {
    case "create-issue":
      return action.projectKey;
    case "update-issue-fields":
    case "transition-issue":
    case "add-issue-comment":
      return action.issueKey;
    case "create-page":
      return action.spaceId;
    case "update-page":
    case "add-page-comment":
      return action.pageId;
  }
}

// ─── Execution dispatch ────────────────────────────────────────────────────────
interface ExecutionDeps {
  readonly http: AtlassianHttpBodyPort;
  readonly baseUrl: string;
}

function succeeded(
  targetRef: string | undefined,
  version?: number,
): AtlassianConnectorActionExecutionResult {
  return {
    status: "succeeded",
    ...(targetRef === undefined ? {} : { targetRef }),
    ...(version === undefined ? {} : { version }),
  };
}

function failed(failure: AtlassianWriteActionFailure): AtlassianConnectorActionExecutionResult {
  return {
    status: "failed",
    reason: failure.reason,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
  };
}

type JiraActionInput = Extract<
  AtlassianWriteActionInput,
  { type: "create-issue" | "update-issue-fields" | "transition-issue" | "add-issue-comment" }
>;

async function executeJiraAction(
  deps: ExecutionDeps,
  action: JiraActionInput,
): Promise<AtlassianConnectorActionExecutionResult> {
  switch (action.type) {
    case "create-issue": {
      const result = await createJiraIssue(deps, action);
      return result.ok ? succeeded(result.issueKey) : failed(result);
    }
    case "update-issue-fields": {
      const result = await updateJiraIssueFields(deps, action);
      return result.ok ? succeeded(action.issueKey) : failed(result);
    }
    case "transition-issue": {
      const result = await transitionJiraIssue(deps, action);
      return result.ok ? succeeded(action.issueKey) : failed(result);
    }
    case "add-issue-comment": {
      const result = await addJiraIssueComment(deps, action);
      return result.ok ? succeeded(result.commentId) : failed(result);
    }
  }
}

type ConfluenceActionInput = Extract<
  AtlassianWriteActionInput,
  { type: "create-page" | "update-page" | "add-page-comment" }
>;

async function executeConfluenceAction(
  deps: ExecutionDeps,
  action: ConfluenceActionInput,
): Promise<AtlassianConnectorActionExecutionResult> {
  switch (action.type) {
    case "create-page": {
      const result = await createConfluencePage(deps, action);
      return result.ok ? succeeded(result.pageId, result.version) : failed(result);
    }
    case "update-page": {
      const result = await updateConfluencePage(deps, action);
      return result.ok ? succeeded(result.pageId, result.version) : failed(result);
    }
    case "add-page-comment": {
      const result = await addConfluencePageComment(deps, action);
      return result.ok ? succeeded(result.commentId) : failed(result);
    }
  }
}

function executeWriteAction(
  deps: ExecutionDeps,
  action: AtlassianWriteActionInput,
): Promise<AtlassianConnectorActionExecutionResult> {
  switch (action.type) {
    case "create-issue":
    case "update-issue-fields":
    case "transition-issue":
    case "add-issue-comment":
      return executeJiraAction(deps, action);
    case "create-page":
    case "update-page":
    case "add-page-comment":
      return executeConfluenceAction(deps, action);
  }
}

// Executes an admitted action and records exactly one activity record for the attempt: a
// succeeded execution carries the review reason when it was human-approved (`review-required`
// disposition) and no reason for a directly allowed one; a failed execution always carries the
// closed provider failure reason.
async function executeAndRespond(
  guard: AtlassianConnectorCredentialDeps,
  credential: AtlassianCredentialMetadata,
  action: AtlassianWriteActionInput,
  disposition: "allowed" | "review-required",
  reviewReason: AtlassianConnectorActionReviewReason | undefined,
  correlationId: string,
): Promise<RouteResult> {
  const startedAt = Date.now();
  const result = await executeWriteAction(
    { http: guard.httpBodyPortFactory(credential), baseUrl: credential.baseUrl },
    action,
  );
  const reasonCode: AtlassianConnectorActivityReasonCode | undefined =
    result.status === "failed" ? result.reason : reviewReason;
  recordAtlassianActionActivity({
    connectorId: connectorIdForAuthRef(credential.authRef),
    actionType: action.type,
    disposition,
    outcome: result.status === "failed" ? "failed" : "succeeded",
    ...(reasonCode === undefined ? {} : { reasonCode }),
    targetRef:
      result.status === "succeeded"
        ? (result.targetRef ?? targetRefOf(action))
        : targetRefOf(action),
    correlationId,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  return { status: 200, body: { disposition, result, correlationId } };
}

// ─── Live-search execution (Issue #2248) ───────────────────────────────────────
// One content-free record per live attempt: the disposition and review rationale exactly like
// the write path, the JQL digest on EVERY record (ADR-0128 D6 — never the query text), and the
// returned count plus issue keys on success.
function recordLiveSearchActivity(input: {
  readonly credential: AtlassianCredentialMetadata;
  readonly liveSearch: AtlassianLiveSearchPayload;
  readonly disposition: "allowed" | "review-required";
  readonly reviewReason: AtlassianConnectorActionReviewReason | undefined;
  readonly correlationId: string;
  readonly durationMs: number;
  readonly outcome: JiraLiveSearchOutcome;
}): void {
  const { outcome, reviewReason } = input;
  const reasonCode = outcome.ok ? reviewReason : outcome.reason;
  const templateId = input.liveSearch.request.templateId;
  recordAtlassianActionActivity({
    connectorId: connectorIdForAuthRef(input.credential.authRef),
    actionType: "search-issues-live",
    disposition: input.disposition,
    outcome: outcome.ok ? "succeeded" : "failed",
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(templateId === undefined ? {} : { targetRef: templateId }),
    correlationId: input.correlationId,
    durationMs: input.durationMs,
    jqlDigest: input.liveSearch.jqlDigest,
    ...(outcome.ok
      ? {
          resultCount: outcome.result.issues.length,
          resultIssueKeys: outcome.result.issues.map((issue) => issue.key),
        }
      : {}),
  });
}

// Executes an admitted live query and answers the caller. The result is EPHEMERAL: returned on
// the wire (`liveSearch`, with `source: "live"` + `queriedAt`), never persisted, indexed, or
// fingerprinted — the executor is pure transport orchestration with no store access, and the
// store-inspection test pins that no capsule, fingerprint, or connector_sources row changes.
async function executeLiveSearchAndRespond(
  guard: AtlassianConnectorCredentialDeps,
  credential: AtlassianCredentialMetadata,
  liveSearch: AtlassianLiveSearchPayload,
  disposition: "allowed" | "review-required",
  reviewReason: AtlassianConnectorActionReviewReason | undefined,
  correlationId: string,
): Promise<RouteResult> {
  const startedAt = Date.now();
  const request = liveSearch.request;
  const outcome = await executeJiraLiveSearch(
    { http: guard.httpBodyPortFactory(credential) },
    {
      baseUrl: credential.baseUrl,
      jql: resolveJiraLiveSearchJql(request),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
    },
  );
  recordLiveSearchActivity({
    credential,
    liveSearch,
    disposition,
    reviewReason,
    correlationId,
    durationMs: Math.max(0, Date.now() - startedAt),
    outcome,
  });
  if (!outcome.ok) {
    return {
      status: 200,
      body: { disposition, result: { status: "failed", reason: outcome.reason }, correlationId },
    };
  }
  return {
    status: 200,
    body: {
      disposition,
      result: { status: "succeeded" },
      liveSearch: outcome.result,
      correlationId,
    },
  };
}

// ─── Governed disposition skeleton (Issues #2244/#2248) ─────────────────────────
// ONE policy path for every actions-route member: resolve the envelope, disposition via the
// shared D4 matrix (strictest-wins), park review-required payloads without executing, charge the
// budget, then run the action-specific executor. `jqlDigest` accompanies every
// `search-issues-live` record (ADR-0128 D6).
interface GovernedActionPlan {
  readonly actionType: AtlassianConnectorActionType;
  readonly targetRef: string | undefined;
  readonly jqlDigest?: string | undefined;
  readonly payload: PendingAtlassianActionPayload;
  readonly execute: (correlationId: string) => Promise<RouteResult>;
}

function governedActionResult(
  deps: UiHandlerDeps,
  credential: AtlassianCredentialMetadata,
  authority: AtlassianActionAuthorityContext,
  plan: GovernedActionPlan,
): Promise<RouteResult> | RouteResult {
  const connectorId = connectorIdForAuthRef(credential.authRef);
  const correlationId = randomUUID();
  const denied = (reasonCode: AtlassianConnectorActivityReasonCode): RouteResult =>
    deniedAtlassianActionResult({
      connectorId,
      actionType: plan.actionType,
      reasonCode,
      targetRef: plan.targetRef,
      correlationId,
      ...(plan.jqlDigest === undefined ? {} : { jqlDigest: plan.jqlDigest }),
    });
  const outcome = decideGovernedAtlassianAction(plan.actionType, authority, deps);
  if (outcome.kind === "authority-denied") return denied(outcome.reason);
  if (outcome.kind === "policy-denied") {
    return denied(
      outcome.decision.denyReason ??
        ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON[ATLASSIAN_CONNECTOR_ACTION_CLASS[plan.actionType]],
    );
  }
  if (outcome.kind === "review-required") {
    return createAtlassianPendingApprovalResult({
      connectorId,
      actionType: plan.actionType,
      reviewReason: outcome.decision.reviewReason ?? "mode-approval-required",
      targetRef: plan.targetRef,
      correlationId,
      authority,
      authRef: credential.authRef,
      payload: plan.payload,
      ...(plan.jqlDigest === undefined ? {} : { jqlDigest: plan.jqlDigest }),
    });
  }
  const reservation = reserveGovernedAtlassianAction(authority, deps);
  if (!reservation.ok) return denied(reservation.reason);
  return plan.execute(correlationId);
}

// Build the disposition plan for one validated actions-route input. For a template-based live
// query the targetRef is the template id — a safe identifier naming WHAT would run; free-form
// JQL has no identifier-shaped target and records none (the digest is the correlation surface).
function actionPlanFor(
  guard: AtlassianConnectorCredentialDeps,
  credential: AtlassianCredentialMetadata,
  input: AtlassianGovernedActionInput,
): GovernedActionPlan {
  if (input.kind === "live-search") {
    const liveSearch = input.liveSearch;
    return {
      actionType: "search-issues-live",
      targetRef: liveSearch.request.templateId,
      jqlDigest: liveSearch.jqlDigest,
      payload: { kind: "live-search", liveSearch },
      execute: (correlationId: string): Promise<RouteResult> =>
        executeLiveSearchAndRespond(
          guard,
          credential,
          liveSearch,
          "allowed",
          undefined,
          correlationId,
        ),
    };
  }
  const action = input.action;
  return {
    actionType: action.type,
    targetRef: targetRefOf(action),
    payload: { kind: "write-action", action },
    execute: (correlationId: string): Promise<RouteResult> =>
      executeAndRespond(guard, credential, action, "allowed", undefined, correlationId),
  };
}

// POST /api/atlassian-connectors/credentials/:authRef/actions — the only agent entry point for
// governed connector actions (writes and the live JQL read). The authority context is REQUIRED:
// v1 has no direct human surface on this route (the #2245 UI approves or rejects pending
// actions; it does not author them), so every request is envelope-dispositioned — there is no
// ungoverned bypass. The ADR-0128 D5 human-initiated carve-out covers explicitly user-triggered
// SYNC starts only (see syncRoutes.ts); it does not extend to this route.
export function handleExecuteAtlassianConnectorAction(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const credential = requireAtlassianCredential(ctx, guard);
    const body = await readJsonObject(ctx.req, MAX_ACTION_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const authority = parseAtlassianActionAuthorityContext(body.authority);
    if (authority === undefined) {
      throw invalid("authority must carry runId, envelopeDigest, and workspaceRoot");
    }
    const input = validateGovernedActionInput(body.action, credential.provider);
    return governedActionResult(
      deps,
      credential,
      authority,
      actionPlanFor(guard, credential, input),
    );
  });
}

// ─── Pending-approval endpoints (#2245 renders these) ─────────────────────────
function approvalNotFound(): RouteResult {
  return {
    status: 404,
    body: errorBody("APPROVAL_NOT_FOUND", "Atlassian connector action approval is not available."),
  };
}

function decodedApprovalIdParam(ctx: RouteContext): string | undefined {
  const raw = ctx.params.approvalId ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return isSafeAtlassianIdentifier(decoded) ? decoded : undefined;
}

// GET /api/atlassian-connectors/action-approvals
export function handleListAtlassianConnectorActionApprovals(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return { status: 200, body: { approvals: atlassianActionApprovalRegistry.listPending() } };
}

// GET /api/atlassian-connectors/action-approvals/:approvalId
export function handleGetAtlassianConnectorActionApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  const approvalId = decodedApprovalIdParam(ctx);
  const entry =
    approvalId === undefined ? undefined : atlassianActionApprovalRegistry.get(approvalId);
  if (entry === undefined) return approvalNotFound();
  return { status: 200, body: { approval: entry.approval } };
}

// Approved sync-start: the pending scope starts through the SAME startAtlassianSyncJob seam with
// the review-required governance recorded on the run's terminal activity record.
async function approveSyncStart(
  deps: UiHandlerDeps,
  guard: AtlassianConnectorCredentialDeps,
  credential: AtlassianCredentialMetadata,
  entry: PendingAtlassianActionEntry,
  syncStart: Extract<PendingAtlassianActionEntry["payload"], { kind: "sync-start" }>["syncStart"],
): Promise<RouteResult> {
  const started = await startAtlassianSyncJob(
    deps,
    {
      credential,
      ...syncStart,
      governance: {
        disposition: "review-required",
        reasonCode: entry.approval.reviewReason,
      },
    },
    guard.httpBodyPortFactory(credential),
  );
  return {
    status: 202,
    body: {
      disposition: "review-required",
      job: started.job,
      capsuleId: started.capsuleId,
      correlationId: entry.approval.correlationId,
    },
  };
}

// The digest a pending `search-issues-live` entry parked at admission time — threaded onto the
// approve-denied and reject records so every attempt record carries it (ADR-0128 D6).
function pendingEntryJqlDigest(entry: PendingAtlassianActionEntry): string | undefined {
  return entry.payload.kind === "live-search" ? entry.payload.liveSearch.jqlDigest : undefined;
}

async function executeApprovedEntry(
  deps: UiHandlerDeps,
  guard: AtlassianConnectorCredentialDeps,
  entry: PendingAtlassianActionEntry,
): Promise<RouteResult> {
  const credential = guard.custody.getMetadata(entry.authRef);
  if (credential === undefined) {
    throw new AtlassianSyncRequestError(
      404,
      "CREDENTIAL_NOT_FOUND",
      "Atlassian connector credential is not available.",
    );
  }
  // ADR-0125 revalidation at approve time: the envelope may have expired or exhausted its budget
  // while the approval was pending — the reservation re-resolves and charges one toolCall.
  const reservation = reserveGovernedAtlassianAction(entry.authority, deps);
  if (!reservation.ok) {
    const jqlDigest = pendingEntryJqlDigest(entry);
    return deniedAtlassianActionResult({
      connectorId: entry.approval.connectorId,
      actionType: entry.approval.actionType,
      reasonCode: reservation.reason,
      ...(entry.approval.targetRef === undefined ? {} : { targetRef: entry.approval.targetRef }),
      correlationId: entry.approval.correlationId,
      ...(jqlDigest === undefined ? {} : { jqlDigest }),
    });
  }
  if (entry.payload.kind === "sync-start") {
    return approveSyncStart(deps, guard, credential, entry, entry.payload.syncStart);
  }
  if (entry.payload.kind === "live-search") {
    return executeLiveSearchAndRespond(
      guard,
      credential,
      entry.payload.liveSearch,
      "review-required",
      entry.approval.reviewReason,
      entry.approval.correlationId,
    );
  }
  return executeAndRespond(
    guard,
    credential,
    entry.payload.action,
    "review-required",
    entry.approval.reviewReason,
    entry.approval.correlationId,
  );
}

// POST /api/atlassian-connectors/action-approvals/:approvalId/approve — single-use: the entry is
// consumed before execution, so a replayed approve finds nothing (404). Unknown, resolved, and
// expired ids are indistinguishable (fail closed, no oracle).
export function handleApproveAtlassianConnectorActionApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const approvalId = decodedApprovalIdParam(ctx);
    const entry =
      approvalId === undefined ? undefined : atlassianActionApprovalRegistry.consume(approvalId);
    if (entry === undefined) return approvalNotFound();
    return executeApprovedEntry(deps, guard, entry);
  });
}

// POST /api/atlassian-connectors/action-approvals/:approvalId/reject — records the rejection
// (disposition review-required, outcome cancelled) and never executes.
export function handleRejectAtlassianConnectorActionApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const approvalId = decodedApprovalIdParam(ctx);
    const entry =
      approvalId === undefined ? undefined : atlassianActionApprovalRegistry.reject(approvalId);
    if (entry === undefined) return approvalNotFound();
    const jqlDigest = pendingEntryJqlDigest(entry);
    recordAtlassianActionActivity({
      connectorId: entry.approval.connectorId,
      actionType: entry.approval.actionType,
      disposition: "review-required",
      outcome: "cancelled",
      reasonCode: entry.approval.reviewReason,
      ...(entry.approval.targetRef === undefined ? {} : { targetRef: entry.approval.targetRef }),
      correlationId: entry.approval.correlationId,
      durationMs: 0,
      ...(jqlDigest === undefined ? {} : { jqlDigest }),
    });
    return {
      status: 200,
      body: {
        approvalId: entry.approval.approvalId,
        disposition: "review-required",
        outcome: "cancelled",
        correlationId: entry.approval.correlationId,
      },
    };
  });
}
