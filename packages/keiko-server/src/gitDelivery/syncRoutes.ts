// Governed fetch/pull sync routes: read-only preview + bounded execute (Issue #1573, Epic #1572).
//
//   * POST /api/git-delivery/{fetch,pull}/preview  — READ-ONLY. Projects the sync readiness envelope
//       (branch / upstream / ahead / behind / hasRemote / hasUpstream / dirty + an executable gate and
//       typed blockReason). Never mutates, never records evidence.
//   * POST /api/git-delivery/{fetch,pull}/execute  — Requires an executable preview before running
//       ONE bounded fetch/pull through the credential-capable runner (NOT the #472 kernel —
//       fetch/pull have no GitDeliveryActionKind) and appends a content-free sync evidence record for
//       the terminal outcome.
//
// Mirrors pushRoutes.ts: the same bounded body read, allowed-key whitelist, credential-shape +
// unsafe-format-char scans, isSafeGitRef operand guard plus configured-remote preflight,
// content-free typed error envelope, and a `createGitDeliverySyncRouteGroup(options)` factory with
// an injectable execution seam. The read → validate → resolve-workspace prologue is shared through
// prepareGitDeliveryRequest. CSRF + JSON content type are enforced CENTRALLY by server.ts for POST,
// so they are NOT re-checked here.

import type {
  GitSyncExecuteResponse,
  GitSyncOperation,
  GitSyncPreview,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { GIT_SYNC_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-sync";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { processServerLogSink } from "../process-log-sink.js";
import { logGitDeliveryNoSpawnRefusal } from "./execution.js";
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

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "projectId", "remote"]);

interface ValidatedRequest {
  readonly projectId: string;
  readonly remote: string | undefined;
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
  return { kind: "ok", value: { projectId: parsed.projectId, remote: parsed.remote } };
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
    audit: { logSink: input.seams.activityLog },
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

function completedSyncResponse(
  deps: UiHandlerDeps,
  operation: GitSyncOperation,
  remote: string | undefined,
  workspaceRoot: string,
  before: GitSyncPreview,
  result: SyncExecuteResult,
  now: () => number,
): RouteResult {
  persistSyncResult(deps, operation, remote, workspaceRoot, before, result, now());
  return { status: 200, body: deps.redactor(executeResponse(operation, remote, result)) };
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
  const { projectId, remote } = prepared.value;
  const authority = gitDeliveryAuthorityGate(
    ctx,
    deps,
    projectId,
    workspace,
    operation,
    {},
    {
      logSink: seams.activityLog,
    },
  );
  if (!authority.allowed) return authority.result;
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
    authority,
  });
  if (dispatched.denial !== undefined) return dispatched.denial;
  return completedSyncResponse(
    deps,
    operation,
    remote,
    workspace.root,
    before,
    dispatched.result,
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
    pattern: "/api/git-delivery/pull/execute",
    handler: createHandleSyncExecute("pull", options),
  },
];

export const GIT_DELIVERY_SYNC_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliverySyncRouteGroup();
