// Governed fetch/pull sync routes: read-only preview + bounded execute (Issue #1573, Epic #1572).
//
//   * POST /api/git-delivery/{fetch,pull}/preview  — READ-ONLY. Projects the sync readiness envelope
//       (branch / upstream / ahead / behind / hasRemote / hasUpstream / dirty + an executable gate and
//       typed blockReason). Never mutates, never records evidence.
//   * POST /api/git-delivery/{fetch,pull}/approve  — Validates the exact sync request against the
//       active run authority and mints the one-use claim the execute route consumes.
//   * POST /api/git-delivery/{fetch,pull}/execute  — Requires an executable preview before running
//       ONE bounded fetch/pull through the credential-capable runner (NOT the #472 kernel —
//       fetch/pull have no GitDeliveryActionKind) and appends a content-free sync evidence record for
//       the terminal outcome. Below `autonomous-delivery`, the coarse admission gate's
//       "approval-required" disposition for this network-reaching "delivery" effect (ADR-0138 D2) is
//       redeemed by an optional `approval` claim carried on the SAME request body, bound to
//       `{projectId, operation, command}` (final-audit F2 repair, #3390) — mirrors
//       `localMutationRoutes.ts`'s redemption exactly, since fetch/pull have no downstream kernel
//       policy pack of their own to defer approval to the way push/pr/merge/commit do.
//
// Mirrors pushRoutes.ts: the same bounded body read, allowed-key whitelist, credential-shape +
// unsafe-format-char scans, isSafeGitRef operand guard plus configured-remote preflight,
// content-free typed error envelope, and a `createGitDeliverySyncRouteGroup(options)` factory with
// an injectable execution seam. The read → validate → resolve-workspace prologue is shared through
// prepareGitDeliveryRequest. CSRF + JSON content type are enforced CENTRALLY by server.ts for POST,
// so they are NOT re-checked here.

import type {
  GitDeliveryApprovalClaim,
  GitDeliveryApprovalRequirement,
  GitSyncExecuteResponse,
  GitSyncOperation,
  GitSyncPreview,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { GIT_SYNC_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-sync";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { logGitDeliveryNoSpawnRefusal } from "./execution.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalBinding,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
  isSafeGitRef,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";
import {
  gitDeliveryAuthorityContinuityGuard,
  gitDeliveryAuthorityGate,
  prepareGitDeliveryRequest,
  type GitDeliveryAuthorityContinuityDenialCapture,
  type GitDeliveryAuthorityGate as GitDeliveryAuthorityGateResult,
  type GitDeliveryAuthorityIdentity,
  type GitDeliveryRequestErrors,
} from "./requestPreparation.js";
import {
  buildSyncPreview,
  runSyncExecute,
  type GitDeliverySyncSeams,
  type SyncExecuteResult,
} from "./syncExecution.js";
import {
  gitSyncRepoIdHash,
  recordGitSyncEvidence,
  GIT_SYNC_EVIDENCE_SCHEMA_VERSION,
  type GitSyncEvidenceRecord,
} from "./syncEvidence.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

export type GitDeliverySyncErrorCode =
  | "GIT_DELIVERY_SYNC_BAD_REQUEST"
  | "GIT_DELIVERY_SYNC_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_SYNC_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_SYNC_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliverySyncErrorCode, string>> = {
  GIT_DELIVERY_SYNC_BAD_REQUEST: "The request body is not a valid git sync request.",
  GIT_DELIVERY_SYNC_PAYLOAD_TOO_LARGE: "The git sync request exceeds the maximum size.",
  GIT_DELIVERY_SYNC_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials, headers, or URLs.",
  GIT_DELIVERY_SYNC_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliverySyncErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const SYNC_REQUEST_ERRORS: GitDeliveryRequestErrors = {
  tooLarge: errResult(413, "GIT_DELIVERY_SYNC_PAYLOAD_TOO_LARGE"),
  badRequest: errResult(400, "GIT_DELIVERY_SYNC_BAD_REQUEST"),
  unknownProject: errResult(404, "GIT_DELIVERY_SYNC_UNKNOWN_PROJECT"),
};

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliverySyncRouteOptions {
  readonly execution?: GitDeliverySyncSeams;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "remote",
  "approval",
]);

interface ValidatedRequest {
  readonly projectId: string;
  readonly remote: string | undefined;
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

// The credential-shape + unsafe-format-char boundary scans. Returns the typed error RouteResult or
// undefined when the payload is clean.
function scanError(parsed: Record<string, unknown>): RouteResult | undefined {
  if (scanForbiddenStrings(parsed)) {
    return errResult(400, "GIT_DELIVERY_SYNC_FORBIDDEN_PAYLOAD");
  }
  if (scanUnsafeFormatChars(parsed)) {
    return errResult(400, "GIT_DELIVERY_SYNC_BAD_REQUEST");
  }
  return undefined;
}

function validate(parsed: unknown): Validation {
  const bad: Validation = { kind: "err", result: errResult(400, "GIT_DELIVERY_SYNC_BAD_REQUEST") };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, ALLOWED_KEYS)) return bad;
  if (parsed.schemaVersion !== GIT_SYNC_SCHEMA_VERSION || !isNonEmptyString(parsed.projectId)) {
    return bad;
  }
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  if (parsed.remote !== undefined && !isSafeGitRef(parsed.remote)) return bad;
  const approval = parseGitDeliveryApprovalRequest(parsed.approval);
  if (approval === undefined) return bad;
  return {
    kind: "ok",
    value: { projectId: parsed.projectId, remote: parsed.remote, approval },
  };
}

// ─── Preview handler (read-only) ────────────────────────────────────────────────────────────────

export const createHandleSyncPreview = (
  operation: GitSyncOperation,
  options: GitDeliverySyncRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const baseSeams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    // Per request, not per route: the correlation id is what ties this sync's git failures to the
    // request line `server.ts` writes for it (AGENTS.md §8 Rule 1).
    const seams = { ...baseSeams, correlationId: ctx.correlationId };
    const prepared = await prepareGitDeliveryRequest(ctx, deps, SYNC_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { remote } = prepared.value;
    try {
      const preview = await buildSyncPreview(operation, workspace.root, remote, seams);
      return { status: 200, body: deps.redactor(preview) };
    } catch {
      return errResult(409, "GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE");
    }
  };
};

// ─── Execute handler (bounded fetch/pull) ───────────────────────────────────────────────────────

function redactStringFor(deps: Pick<UiHandlerDeps, "redactor">): (input: string) => string {
  return (input: string): string => deps.redactor(input) as string;
}

function executeResponse(
  operation: GitSyncOperation,
  remote: string | undefined,
  result: SyncExecuteResult,
): GitSyncExecuteResponse {
  return {
    schemaVersion: GIT_SYNC_SCHEMA_VERSION,
    operation,
    status: result.outcome,
    available: true,
    branch: result.branch,
    upstream: result.upstream,
    remote,
    ahead: result.ahead,
    behind: result.behind,
    truncated: result.truncated,
  };
}

function evidenceRecord(
  operation: GitSyncOperation,
  remote: string | undefined,
  repoIdHash: string,
  before: GitSyncPreview | undefined,
  result: SyncExecuteResult,
  recordedAtMs: number,
): GitSyncEvidenceRecord {
  return {
    schemaVersion: GIT_SYNC_EVIDENCE_SCHEMA_VERSION,
    operation,
    outcome: result.outcome,
    repoIdHash,
    branch: result.branch ?? before?.branch,
    remote,
    aheadBefore: before?.ahead,
    behindBefore: before?.behind,
    aheadAfter: result.ahead,
    behindAfter: result.behind,
    recordedAtMs,
  };
}

function persistSyncResult(
  deps: UiHandlerDeps,
  operation: GitSyncOperation,
  remote: string | undefined,
  workspaceRoot: string,
  before: GitSyncPreview,
  result: SyncExecuteResult,
  recordedAtMs: number,
): void {
  const record = evidenceRecord(
    operation,
    remote,
    gitSyncRepoIdHash(workspaceRoot),
    before,
    result,
    recordedAtMs,
  );
  recordGitSyncEvidence(
    {
      evidenceStore: deps.evidenceStore,
      redactString: redactStringFor(deps),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
    },
    record,
  );
}

interface SyncDispatchInput {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly operation: GitSyncOperation;
  readonly seams: GitDeliverySyncSeams;
  readonly projectId: string;
  readonly workspace: WorkspaceInfo;
  readonly before: GitSyncPreview;
  readonly remote: string | undefined;
  readonly authority: GitDeliveryAuthorityIdentity;
}

interface SyncDispatchResult {
  readonly result: SyncExecuteResult;
  readonly denial?: RouteResult | undefined;
}

async function dispatchSync(input: SyncDispatchInput): Promise<SyncDispatchResult> {
  const denialCapture: GitDeliveryAuthorityContinuityDenialCapture = {};
  const activityLog = input.seams.activityLog ?? processServerLogSink();
  const authorityGuard = gitDeliveryAuthorityContinuityGuard({
    ctx: input.ctx,
    deps: input.deps,
    projectId: input.projectId,
    workspace: input.workspace,
    operation: input.operation,
    target: input.before.branch === undefined ? {} : { headBranchName: input.before.branch },
    admitted: input.authority,
    next: input.seams.beforeRemoteDispatch,
    denialCapture,
    // Final-audit F2 repair: the up-front admission gate already verified AND consumed a real,
    // matching approval claim for this exact request (see `handleSyncExecute`'s
    // `resolveGitDeliveryApprovalRequirement` call, which runs before `dispatchSync` is ever
    // reached) when the mode required one. Peeking the store again here would find that record
    // already gone and spuriously deny a request this same admission chain just admitted, so the
    // continuity re-check defers instead — it still re-verifies the run authority hasn't changed
    // (`admitted`/`expectedAuthority`), just not the approval a second time.
    audit: { logSink: input.seams.activityLog, deliveryApprovalDeferred: true },
  });
  const beforeRemoteDispatch = (): boolean => {
    const allowed = authorityGuard();
    if (!allowed) {
      logGitDeliveryNoSpawnRefusal(activityLog, input.operation, input.seams.correlationId);
    }
    return allowed;
  };
  const result = await runSyncExecute(
    input.operation,
    input.workspace.root,
    input.remote,
    { ...input.seams, beforeRemoteDispatch },
    input.before,
  );
  if (denialCapture.result === undefined) return { result };
  return { result, denial: denialCapture.result };
}

function syncResponse(
  deps: UiHandlerDeps,
  operation: GitSyncOperation,
  remote: string | undefined,
  workspaceRoot: string,
  before: GitSyncPreview,
  dispatched: SyncDispatchResult,
  now: () => number,
): RouteResult {
  persistSyncResult(deps, operation, remote, workspaceRoot, before, dispatched.result, now());
  if (dispatched.denial !== undefined) return dispatched.denial;
  return {
    status: 200,
    body: deps.redactor(executeResponse(operation, remote, dispatched.result)),
  };
}

// Final-audit F2 repair (#3390, ADR-0138 D2): fetch/pull are network-reaching "delivery"-scope
// operations whose "approval-required" disposition below `autonomous-delivery` had no production
// redemption path — unlike push/pr/merge/commit, they have no `GitDeliveryActionKind` / kernel
// policy pack of their own to defer to (syncExecution.ts's header comment), so they cannot reuse
// `deliveryApprovalDeferred`. Redeemed the SAME way `localMutationRoutes.ts` redeems local
// mutations instead: bound to `{projectId, operation, command}` with no run identity (mirrors
// "local-mutation" exactly — see approvalStore.ts).
interface SyncApprovalCommand {
  readonly kind: GitSyncOperation;
  readonly remote: string | undefined;
}

function syncApprovalBinding(
  projectId: string,
  operation: GitSyncOperation,
  remote: string | undefined,
): GitDeliveryApprovalBinding {
  const command: SyncApprovalCommand = { kind: operation, remote };
  return { projectId, operation, command };
}

export interface GitDeliverySyncApproveResponseBody {
  readonly schemaVersion: "1";
  readonly approval: GitDeliveryApprovalClaim;
  readonly expiresAt: string;
}

function logSyncApprovalMinted(
  activityLog: ServerLogSink,
  correlationId: string,
  operation: GitSyncOperation,
  runId: string,
): void {
  activityLog.write({
    category: "security",
    op: "git.delivery.sync.approval.minted",
    correlationId,
    status: 200,
    extra: { operation, runId },
  });
}

export const createHandleSyncApprove = (
  operation: GitSyncOperation,
  options: GitDeliverySyncRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const prepared = await prepareGitDeliveryRequest(ctx, deps, SYNC_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { projectId, remote } = prepared.value;
    const nowMs = (seams.now ?? Date.now)();
    const authority = gitDeliveryAuthorityGate(
      ctx,
      deps,
      projectId,
      prepared.workspace,
      operation,
      {},
      {
        logSink: seams.activityLog,
        nowIso: new Date(nowMs).toISOString(),
        deliveryApprovalDeferred: true,
      },
    );
    if (!authority.allowed) return authority.result;
    const store = seams.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    const issued = store.issue({
      binding: syncApprovalBinding(projectId, operation, remote),
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs,
    });
    logSyncApprovalMinted(
      seams.activityLog ?? processServerLogSink(),
      ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
      operation,
      authority.runId,
    );
    const body: GitDeliverySyncApproveResponseBody = {
      schemaVersion: "1",
      approval: issued.approval,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
    return { status: 200, body: deps.redactor(body) };
  };
};

interface SyncAuthorityGateInput {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly workspace: WorkspaceInfo;
  readonly operation: GitSyncOperation;
  readonly binding: GitDeliveryApprovalBinding;
  readonly approval: ParsedGitDeliveryApprovalRequest;
  readonly seams: GitDeliverySyncSeams;
  readonly nowIso: string;
}
function syncAuthorityGate({
  ctx,
  deps,
  workspace,
  operation,
  binding,
  approval,
  seams,
  nowIso,
}: SyncAuthorityGateInput): GitDeliveryAuthorityGateResult {
  return gitDeliveryAuthorityGate(
    ctx,
    deps,
    binding.projectId,
    workspace,
    operation,
    {},
    {
      logSink: seams.activityLog,
      nowIso,
      approval,
      approvalStore: seams.approvalStore,
      approvalBinding: { operation: binding.operation, command: binding.command },
    },
  );
}

// The single real, single-use consumption of the claim the admission gate above only peeked at —
// mirrors `localMutationRoutes.ts`'s own `resolveGitDeliveryApprovalRequirement` call exactly.
// Returns `{ required: false }` (never `undefined`) when no claim was offered at all, which is the
// ordinary autonomous-delivery / no-approval-needed path.
function resolveSyncApproval(
  approval: ParsedGitDeliveryApprovalRequest,
  binding: GitDeliveryApprovalBinding,
  seams: GitDeliverySyncSeams,
  nowMs: number,
): GitDeliveryApprovalRequirement | undefined {
  return resolveGitDeliveryApprovalRequirement(approval, {
    store: seams.approvalStore,
    binding,
    nowMs,
  });
}

type SyncAdmission =
  | { readonly ok: true; readonly authority: GitDeliveryAuthorityIdentity }
  | { readonly ok: false; readonly result: RouteResult };

// Extracted purely to keep `handleSyncExecute` under the repo's max-lines-per-function bar
// (AGENTS.md §6) — no behavioral seam of its own. Runs the admission gate (peek), then the single
// real consumption, in that order.
interface AdmitSyncExecuteInput {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly workspace: WorkspaceInfo;
  readonly operation: GitSyncOperation;
  readonly binding: GitDeliveryApprovalBinding;
  readonly approval: ParsedGitDeliveryApprovalRequest;
  readonly seams: GitDeliverySyncSeams;
  readonly nowMs: number;
}
function admitSyncExecute({
  ctx,
  deps,
  workspace,
  operation,
  binding,
  approval,
  seams,
  nowMs,
}: AdmitSyncExecuteInput): SyncAdmission {
  const authority = syncAuthorityGate({
    ctx,
    deps,
    workspace,
    operation,
    binding,
    approval,
    seams,
    nowIso: new Date(nowMs).toISOString(),
  });
  if (!authority.allowed) return { ok: false, result: authority.result };
  if (resolveSyncApproval(approval, binding, seams, nowMs) === undefined) {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_SYNC_BAD_REQUEST") };
  }
  return { ok: true, authority };
}

async function handleSyncExecute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  operation: GitSyncOperation,
  seams: GitDeliverySyncSeams,
): Promise<RouteResult> {
  const prepared = await prepareGitDeliveryRequest(ctx, deps, SYNC_REQUEST_ERRORS, validate);
  if (!prepared.ok) return prepared.result;
  const { workspace } = prepared;
  const { projectId, remote, approval } = prepared.value;
  const nowMs = (seams.now ?? Date.now)();
  const binding = syncApprovalBinding(projectId, operation, remote);
  const admission = admitSyncExecute({
    ctx,
    deps,
    workspace,
    operation,
    binding,
    approval,
    seams,
    nowMs,
  });
  if (!admission.ok) return admission.result;
  let before: GitSyncPreview;
  try {
    before = await buildSyncPreview(operation, workspace.root, remote, seams);
  } catch {
    return errResult(409, "GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE");
  }
  const dispatched = await dispatchSync({
    ctx,
    deps,
    projectId,
    operation,
    seams,
    workspace,
    before,
    remote,
    authority: admission.authority,
  });
  return syncResponse(
    deps,
    operation,
    remote,
    workspace.root,
    before,
    dispatched,
    seams.now ?? Date.now,
  );
}

export const createHandleSyncExecute = (
  operation: GitSyncOperation,
  options: GitDeliverySyncRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const baseSeams = options.execution ?? {};
  return (ctx, deps) =>
    handleSyncExecute(ctx, deps, operation, {
      ...baseSeams,
      correlationId: ctx.correlationId,
    });
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliverySyncRouteGroup = (
  options: GitDeliverySyncRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/fetch/preview",
    handler: createHandleSyncPreview("fetch", options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/fetch/approve",
    handler: createHandleSyncApprove("fetch", options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/fetch/execute",
    handler: createHandleSyncExecute("fetch", options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pull/preview",
    handler: createHandleSyncPreview("pull", options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pull/approve",
    handler: createHandleSyncApprove("pull", options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pull/execute",
    handler: createHandleSyncExecute("pull", options),
  },
];

export const GIT_DELIVERY_SYNC_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliverySyncRouteGroup();
