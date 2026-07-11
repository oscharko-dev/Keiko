// Issues #2242/#2243/#2244 — Atlassian connector sync BFF routes (ADR-0128 D4/D5/D6).
//
//   POST /api/atlassian-connectors/credentials/:authRef/sync-jobs   start a sync run
//        confluence body { spaceKeys, displayName? }        → initial sync (creates the pod)
//        jira body       { projectKeys, jql?, displayName? } → initial sync (creates the pod)
//        body            { capsuleId }                       → explicit re-sync (scope, JQL
//                                            included, reconstructed from persisted approved
//                                            state; never widened or swapped)
//        optional        { authority: { runId, envelopeDigest, workspaceRoot } }
//                                            → agent-initiated start under a validated
//                                            Authority Envelope (Issue #2244)
//   GET  /api/atlassian-connectors/sync-jobs/:jobId                 poll job status/progress
//   POST /api/atlassian-connectors/sync-jobs/:jobId/cancel          cancel an in-flight run
//   GET  /api/atlassian-connectors/credentials/:authRef/activity    content-free activity records
//
// Sync-start disposition (Issue #2244, closing the #2242 open item): ADR-0128 D5 fixes v1 sync
// as EXPLICITLY USER-TRIGGERED, so a start WITHOUT authority context is human-approved by
// construction under the ADR-0129 human-control invariant — the per-action human trigger
// satisfies the D4 review requirement in every mode, and the run's activity record says so
// explicitly (`allowed` + `human-initiated` rationale, never a bare static "allowed"). A start
// WITH authority context is agent-initiated: it flows through the shared policy seam
// (`decideAtlassianConnectorAction` over the validated envelope, stricter-wins) so the D4
// `sync-space`/`sync-project` rows hold at route level — review-required parks a pending
// approval (the job does NOT start), denied answers exactly one content-free reason, and
// allowed charges the envelope budget before the run starts.
//
// The start/status/cancel poll model mirrors the memory-consolidation job routes (the existing
// BFF convention for explicit long-running jobs). Wire payloads are the #2240 contracts only —
// job states, progress counts, closed failure reasons, and redacted change summaries; no
// page/issue body, token, URL, or JQL text can appear (JQL is accepted as opaque bounded input
// here and persisted into the approved scope; it is never echoed into job state, activity, or
// evidence — ADR-0128 D6 hashes or omits it). Expected failures answer typed 4xx codes;
// unexpected failures propagate to the server's top-level catch (opaque 500 + correlation id +
// redacted operator diagnostic — the `check:error-observability` contract).

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_SYNC_SCOPE_MAX_KEYS,
  isAtlassianConnectorAuthRef,
  isSafeAtlassianDisplayName,
  isSafeAtlassianIdentifier,
  isSafeConfluenceSpaceKey,
  isSafeJiraProjectKey,
  type AtlassianConnectorActionType,
  type AtlassianConnectorActivityReasonCode,
  type AtlassianConnectorProvider,
  type KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  createAtlassianPendingApprovalResult,
  deniedAtlassianActionResult,
} from "./actionActivity.js";
import {
  decideGovernedAtlassianAction,
  parseAtlassianActionAuthorityContext,
  reserveGovernedAtlassianAction,
  type AtlassianActionAuthorityContext,
} from "./actionPolicy.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import {
  AtlassianSyncRequestError,
  atlassianSyncJobRegistry,
  connectorIdForAuthRef,
  startAtlassianSyncJob,
} from "./syncService.js";

const MAX_SYNC_BODY_BYTES = 16_000;

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

function isRouteResult(value: DepsOrResult): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

class BodyTooLargeError extends Error {
  constructor() {
    super("atlassian connector sync request body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_SYNC_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AtlassianSyncRequestError(
      400,
      "VALIDATION_FAILED",
      "request body must be valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AtlassianSyncRequestError(
      400,
      "VALIDATION_FAILED",
      "request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

async function runHandler(work: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof AtlassianSyncRequestError) {
      return { status: error.status, body: errorBody(error.code, error.message) };
    }
    throw error;
  }
}

function decodeAuthRefParam(ctx: RouteContext): string | undefined {
  const raw = ctx.params.authRef ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return isAtlassianConnectorAuthRef(decoded) ? decoded : undefined;
}

// Shared with the write-action routes (Issue #2244): one credential-resolution implementation
// for the whole connector route family. Malformed and unknown references both answer 404 (fail
// closed, no oracle distinguishing "never existed" from "wrong shape").
export function requireAtlassianCredential(
  ctx: RouteContext,
  guard: AtlassianConnectorCredentialDeps,
): AtlassianCredentialMetadata {
  const authRef = decodeAuthRefParam(ctx);
  const metadata = authRef === undefined ? undefined : guard.custody.getMetadata(authRef);
  if (metadata === undefined) {
    throw new AtlassianSyncRequestError(
      404,
      "CREDENTIAL_NOT_FOUND",
      "Atlassian connector credential is not available.",
    );
  }
  return metadata;
}

// ─── Start-sync body validation ────────────────────────────────────────────────
const START_SYNC_KEYS: ReadonlySet<string> = new Set([
  "spaceKeys",
  "projectKeys",
  "jql",
  "displayName",
  "capsuleId",
  "authority",
]);

interface StartSyncBody {
  readonly spaceKeys?: readonly string[] | undefined;
  readonly projectKeys?: readonly string[] | undefined;
  readonly jql?: string | undefined;
  readonly displayName?: string | undefined;
  readonly capsuleId?: KnowledgeCapsuleId | undefined;
  readonly authority?: AtlassianActionAuthorityContext | undefined;
}

function invalid(message: string): AtlassianSyncRequestError {
  return new AtlassianSyncRequestError(400, "VALIDATION_FAILED", message);
}

function validatedScopeKeys(
  value: unknown,
  field: string,
  isSafeKey: (key: unknown) => boolean,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${field} must be a non-empty array of ${label}`);
  }
  if (value.length > ATLASSIAN_SYNC_SCOPE_MAX_KEYS) {
    throw invalid(`${field} must contain at most ${String(ATLASSIAN_SYNC_SCOPE_MAX_KEYS)} keys`);
  }
  if (!value.every((key) => isSafeKey(key))) {
    throw invalid(`${field} must contain valid ${label}`);
  }
  return value as readonly string[];
}

// Opaque JQL: bounded and transported only (#2240) — no parsing, no evidence exposure.
function validatedOptionalJql(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > ATLASSIAN_JQL_MAX_CHARS) {
    throw invalid(
      `jql must be a non-empty string of at most ${String(ATLASSIAN_JQL_MAX_CHARS)} characters`,
    );
  }
  return value;
}

function validatedResyncBody(body: Record<string, unknown>): StartSyncBody {
  const scopeFields = ["spaceKeys", "projectKeys", "jql", "displayName"] as const;
  if (scopeFields.some((field) => body[field] !== undefined)) {
    throw invalid(
      "a re-sync reuses the pod's approved scope; spaceKeys, projectKeys, jql, and displayName must be absent",
    );
  }
  if (!isSafeAtlassianIdentifier(body.capsuleId)) {
    throw invalid("capsuleId must be a safe identifier token");
  }
  return { capsuleId: body.capsuleId as KnowledgeCapsuleId };
}

function validatedInitialScope(
  body: Record<string, unknown>,
  provider: AtlassianConnectorProvider,
): StartSyncBody {
  if (provider === "confluence") {
    if (body.projectKeys !== undefined || body.jql !== undefined) {
      throw invalid("projectKeys and jql apply to Jira connectors only");
    }
    return {
      spaceKeys: validatedScopeKeys(
        body.spaceKeys,
        "spaceKeys",
        isSafeConfluenceSpaceKey,
        "Confluence space keys",
      ),
    };
  }
  if (body.spaceKeys !== undefined) {
    throw invalid("spaceKeys apply to Confluence connectors only");
  }
  const jql = validatedOptionalJql(body.jql);
  return {
    projectKeys: validatedScopeKeys(
      body.projectKeys,
      "projectKeys",
      isSafeJiraProjectKey,
      "Jira project keys",
    ),
    ...(jql === undefined ? {} : { jql }),
  };
}

// A malformed `authority` object is a validation failure, never silently treated as a
// human-initiated start — the human-approved-by-construction path is ONLY the fully absent key.
function validatedOptionalAuthority(value: unknown): AtlassianActionAuthorityContext | undefined {
  if (value === undefined) return undefined;
  const authority = parseAtlassianActionAuthorityContext(value);
  if (authority === undefined) {
    throw invalid("authority must carry runId, envelopeDigest, and workspaceRoot");
  }
  return authority;
}

// Exactly one of {provider scope keys (+ optional displayName)} or {capsuleId} — an explicit
// re-sync can never carry scope input, so the approved scope (JQL included) cannot be silently
// widened, narrowed, or swapped.
function validateStartSyncBody(
  body: Record<string, unknown>,
  provider: AtlassianConnectorProvider,
): StartSyncBody {
  if (Object.keys(body).some((key) => !START_SYNC_KEYS.has(key))) {
    throw invalid("request body must not include unexpected fields");
  }
  const authority = validatedOptionalAuthority(body.authority);
  const withAuthority = authority === undefined ? {} : { authority };
  if (body.capsuleId !== undefined) return { ...validatedResyncBody(body), ...withAuthority };
  const scope = validatedInitialScope(body, provider);
  if (body.displayName !== undefined && !isSafeAtlassianDisplayName(body.displayName)) {
    throw invalid("displayName must be bounded redaction-safe display text");
  }
  return {
    ...scope,
    ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
    ...withAuthority,
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────────
const SYNC_ACTION_TYPE_FOR_PROVIDER: Readonly<
  Record<AtlassianConnectorProvider, AtlassianConnectorActionType>
> = Object.freeze({
  confluence: "sync-space",
  jira: "sync-project",
});

function syncScopeTargetRef(body: StartSyncBody): string | undefined {
  return body.capsuleId !== undefined
    ? String(body.capsuleId)
    : (body.spaceKeys?.[0] ?? body.projectKeys?.[0]);
}

async function startSyncAllowed(
  deps: UiHandlerDeps,
  guard: AtlassianConnectorCredentialDeps,
  credential: AtlassianCredentialMetadata,
  body: StartSyncBody,
): Promise<RouteResult> {
  const { authority, ...scope } = body;
  const started = await startAtlassianSyncJob(
    deps,
    {
      credential,
      ...scope,
      // Envelope-admitted agent start; a start without authority records `human-initiated`
      // through the syncService default instead.
      ...(authority === undefined ? {} : { governance: { disposition: "allowed" } }),
    },
    guard.httpBodyPortFactory(credential),
  );
  return { status: 202, body: { job: started.job, capsuleId: started.capsuleId } };
}

// Agent-initiated start under a validated Authority Envelope (Issue #2244): the D4
// `sync-space`/`sync-project` row holds at route level — denied answers one content-free
// reason, review-required parks a pending approval WITHOUT starting the job (zero fetcher
// invocations), and allowed charges one envelope toolCall before the run starts.
async function startSyncGoverned(
  deps: UiHandlerDeps,
  guard: AtlassianConnectorCredentialDeps,
  credential: AtlassianCredentialMetadata,
  body: StartSyncBody,
  authority: AtlassianActionAuthorityContext,
): Promise<RouteResult> {
  const actionType = SYNC_ACTION_TYPE_FOR_PROVIDER[credential.provider];
  const connectorId = connectorIdForAuthRef(credential.authRef);
  const correlationId = randomUUID();
  const targetRef = syncScopeTargetRef(body);
  const outcome = decideGovernedAtlassianAction(actionType, authority, deps);
  const denied = (reasonCode: AtlassianConnectorActivityReasonCode): RouteResult =>
    deniedAtlassianActionResult({ connectorId, actionType, reasonCode, targetRef, correlationId });
  if (outcome.kind === "authority-denied") return denied(outcome.reason);
  if (outcome.kind === "policy-denied") {
    return denied(outcome.decision.denyReason ?? "connector-access-denied");
  }
  if (outcome.kind === "review-required") {
    // The raw request `authority` is validated separately above and must not ride into the
    // pending-approval payload; peel it off and forward only the sync-start fields.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-sibling omit of body.authority
    const { authority: _authority, ...syncStart } = body;
    return createAtlassianPendingApprovalResult({
      connectorId,
      actionType,
      reviewReason: outcome.decision.reviewReason ?? "mode-approval-required",
      targetRef,
      correlationId,
      authority,
      authRef: credential.authRef,
      payload: { kind: "sync-start", syncStart },
    });
  }
  const reservation = reserveGovernedAtlassianAction(authority, deps);
  if (!reservation.ok) return denied(reservation.reason);
  return startSyncAllowed(deps, guard, credential, body);
}

// POST /api/atlassian-connectors/credentials/:authRef/sync-jobs
export function handleStartAtlassianConnectorSync(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const credential = requireAtlassianCredential(ctx, guard);
    const body = validateStartSyncBody(await readJsonObject(ctx.req), credential.provider);
    if (body.authority !== undefined) {
      return startSyncGoverned(deps, guard, credential, body, body.authority);
    }
    // Direct human-triggered start: human-approved by construction (ADR-0129; ADR-0128 D5) —
    // recorded as `allowed` + `human-initiated` on the run's activity record.
    return startSyncAllowed(deps, guard, credential, body);
  });
}

function jobNotFound(): RouteResult {
  return {
    status: 404,
    body: errorBody("SYNC_JOB_NOT_FOUND", "Atlassian connector sync job is not available."),
  };
}

function decodedJobIdParam(ctx: RouteContext): string | undefined {
  const raw = ctx.params.jobId ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return isSafeAtlassianIdentifier(decoded) ? decoded : undefined;
}

// GET /api/atlassian-connectors/sync-jobs/:jobId
export function handleGetAtlassianConnectorSyncJob(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const jobId = decodedJobIdParam(ctx);
    const job = jobId === undefined ? undefined : atlassianSyncJobRegistry.get(jobId);
    if (job === undefined) return jobNotFound();
    return { status: 200, body: { job: job.state } };
  });
}

// POST /api/atlassian-connectors/sync-jobs/:jobId/cancel — aborts the run's signal; the job
// reaches its terminal `cancelled` state at the next page boundary (nothing is partially
// applied, ADR-0128 D5).
export function handleCancelAtlassianConnectorSyncJob(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const jobId = decodedJobIdParam(ctx);
    const job = jobId === undefined ? undefined : atlassianSyncJobRegistry.cancel(jobId);
    if (job === undefined) return jobNotFound();
    return { status: 202, body: { job: job.state } };
  });
}

// GET /api/atlassian-connectors/credentials/:authRef/activity — the bounded, content-free
// activity trail for this connector (ADR-0128 D6).
export function handleListAtlassianConnectorActivity(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireConnectorDeps(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const credential = requireAtlassianCredential(ctx, guard);
    const activity = atlassianSyncJobRegistry.listActivity(
      connectorIdForAuthRef(credential.authRef),
    );
    return { status: 200, body: { activity } };
  });
}
