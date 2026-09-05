// Governed PR-description application routes (#3399, epic #3384 correction 4, ADR-0086).
//
//   * POST /api/git-delivery/pr-description/preview  — Captures the exact base-to-head snapshot,
//       generates a validated description artifact through the Model Gateway, and reconciles it
//       into the one versioned managed region — never mutating the remote PR. Returns the exact
//       rendered preview and a bounded proposal id.
//   * POST /api/git-delivery/pr-description/approve  — Mints the one-use description-apply approval
//       claim `apply` consumes, bound to this exact proposal (repository, PR, base/head, current-body
//       and outside-region digests, draft version, final-body digest) — mirrors createHandleCommitApprove
//       /createHandlePushApprove/createHandlePrApprove, but through the description service's own
//       continuation (`PrDescriptionApprovals`) rather than a caller-presented claim object, since the
//       server retains the proposal server-side between these calls.
//   * POST /api/git-delivery/pr-description/apply  — Re-reads current PR base/head/body immediately
//       before the effect and, only on an exact match with a consumed approval, sends the body-only
//       PATCH through `GitPullRequestBodyAdapter`. Never includes title, base, or draft state.
//   * POST /api/git-delivery/pr-description/status  — Read-only. Reconciles and returns the current
//       `PrDescriptionApplicationStatus` for the bound repository/PR.
//
// Admission: exactly like every other Git delivery mutation, through `gitDeliveryAuthorityGate` for
// the "pull-request" operation — but that gate now also accepts the server-minted description
// authority when no run is active (#3399's addition to `authorizeGitDelivery`), so this route group
// is reachable from a running Code task AND from a Chat/post-terminal caller holding a live
// description authority for the exact (remoteDigest, PR, snapshotDigest) scope. Every other Git
// delivery route keeps requiring a running run; this is the only route group where the fallback
// applies. CSRF + JSON content type are enforced centrally by server.ts.
//
// Content-free in evidence and logs: only ids, digests, counts, and typed states — never PR body
// text, diffs, or prompts.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { PrDescription } from "@oscharko-dev/keiko-model-gateway";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { PR_DESCRIPTION_LANGUAGES } from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import type { GitPullRequestBodyAdapter } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { GitChangeSnapshotService } from "../gitChangeSnapshotService.js";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import type { GitDeliveryApprovalStore } from "./approvalStore.js";
import { resolveProjectWorkspace } from "./execution.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
  readParsedGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";
import { gitDeliveryAuthorityGate } from "./requestPreparation.js";
import { authorizeGitDeliveryModelEgress } from "./runBoundAuthority.js";
import type {
  GitDeliveryDescriptionAuthorityPort,
  GitDeliveryDescriptionAuthorityScope,
} from "./runBoundAuthority.js";
import { createPrDescriptionApplicationService } from "./prDescriptionService.js";
import type {
  PrDescriptionApplicationService,
  PrDescriptionContext,
  PrDescriptionServiceOptions,
} from "./prDescriptionTypes.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

export type GitDeliveryPrDescriptionErrorCode =
  | "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST"
  | "GIT_DELIVERY_PR_DESCRIPTION_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_PR_DESCRIPTION_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE"
  | "GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROPOSAL";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryPrDescriptionErrorCode, string>> = {
  GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST:
    "The request body is not a valid PR-description request.",
  GIT_DELIVERY_PR_DESCRIPTION_PAYLOAD_TOO_LARGE:
    "The PR-description request exceeds the maximum size.",
  GIT_DELIVERY_PR_DESCRIPTION_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials or auth headers.",
  GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE:
    "The PR-description application service is not configured for this deployment.",
  GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROPOSAL:
    "The referenced proposal is unknown, expired, or no longer current.",
};

const errResult = (status: number, code: GitDeliveryPrDescriptionErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

// ─── Request validation ─────────────────────────────────────────────────────────────────────────

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isOwnerAndRepo(value: unknown): value is string {
  return typeof value === "string" && OWNER_REPO_RE.test(value);
}
function isPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isSnapshotDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

interface BaseFields {
  readonly projectId: string;
  readonly ownerAndRepo: string;
  readonly prNumber: number;
  readonly snapshotDigest?: string;
}
type Validation<V> =
  | { readonly kind: "ok"; readonly value: V }
  | { readonly kind: "err"; readonly result: RouteResult };

function scanError(parsed: Record<string, unknown>): RouteResult | undefined {
  if (scanForbiddenStrings(parsed)) {
    return errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_FORBIDDEN_PAYLOAD");
  }
  if (scanUnsafeFormatChars(parsed)) {
    return errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST");
  }
  return undefined;
}

// Every field beyond this closed set is rejected before any adapter call — the "binding smuggling"
// hazard: a request that adds `mergeMethod`, `closeIssue`, `title`, `base`, or any other
// operation-shaped field this route never accepts is refused at validation, never silently ignored.
function baseFields(
  parsed: Record<string, unknown>,
  allowedExtra: ReadonlySet<string>,
): Validation<BaseFields> {
  const bad: Validation<BaseFields> = {
    kind: "err",
    result: errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST"),
  };
  const allowed = new Set([
    "schemaVersion",
    "projectId",
    "ownerAndRepo",
    "prNumber",
    ...allowedExtra,
  ]);
  if (!hasOnlyAllowedKeys(parsed, allowed)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  if (!isOwnerAndRepo(parsed.ownerAndRepo) || !isPrNumber(parsed.prNumber)) return bad;
  if (parsed.snapshotDigest !== undefined && !isSnapshotDigest(parsed.snapshotDigest)) return bad;
  return {
    kind: "ok",
    value: {
      projectId: parsed.projectId,
      ownerAndRepo: parsed.ownerAndRepo,
      prNumber: parsed.prNumber,
      ...(parsed.snapshotDigest === undefined ? {} : { snapshotDigest: parsed.snapshotDigest }),
    },
  };
}

interface PreviewRequest extends BaseFields {
  readonly language: unknown;
  readonly refinement: unknown;
}
function validatePreview(parsed: unknown): Validation<PreviewRequest> {
  const bad: Validation<PreviewRequest> = {
    kind: "err",
    result: errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST"),
  };
  if (!isPlainObject(parsed)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  const base = baseFields(parsed, new Set(["language", "refinement", "snapshotDigest"]));
  if (base.kind === "err") return base;
  if (!PR_DESCRIPTION_LANGUAGES.some((language) => language === parsed.language)) return bad;
  return {
    kind: "ok",
    value: { ...base.value, language: parsed.language, refinement: parsed.refinement },
  };
}

interface ProposalRequest extends BaseFields {
  readonly proposalId: string;
}
function validateProposal(parsed: unknown): Validation<ProposalRequest> {
  const bad: Validation<ProposalRequest> = {
    kind: "err",
    result: errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST"),
  };
  if (!isPlainObject(parsed)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  const base = baseFields(parsed, new Set(["proposalId", "snapshotDigest"]));
  if (base.kind === "err") return base;
  if (!isNonEmptyString(parsed.proposalId)) return bad;
  return { kind: "ok", value: { ...base.value, proposalId: parsed.proposalId } };
}

function validateStatus(parsed: unknown): Validation<BaseFields> {
  const bad: Validation<BaseFields> = {
    kind: "err",
    result: errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST"),
  };
  if (!isPlainObject(parsed)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  return baseFields(parsed, new Set(["snapshotDigest"]));
}

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface PrDescriptionRouteExecutionSeams {
  readonly now?: (() => number) | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly adapterFactory?: ((workspace: WorkspaceInfo) => GitPullRequestBodyAdapter) | undefined;
  readonly generation?: Omit<PrDescription.PrDescriptionDeps, "resolveSnapshot"> | undefined;
  readonly snapshots?: GitChangeSnapshotService | undefined;
  readonly recordStatus?: PrDescriptionServiceOptions["recordStatus"] | undefined;
  readonly readStatus?: PrDescriptionServiceOptions["readStatus"] | undefined;
}

export interface PrDescriptionRouteOptions {
  readonly execution?: PrDescriptionRouteExecutionSeams | undefined;
  // Test-only escape hatch: inject a fully fake `PrDescriptionApplicationService` directly, bypassing
  // every production composition piece above. Production callers never set this.
  readonly serviceFactory?:
    | ((context: () => PrDescriptionContext | undefined) => PrDescriptionApplicationService)
    | undefined;
}

// ─── Admission ──────────────────────────────────────────────────────────────────────────────────

interface AdmittedScope {
  readonly runId: string | undefined;
  readonly authorityDigest: string;
}

function descriptionScopeFor(
  ownerAndRepo: string,
  prNumber: number,
  snapshotDigest: string,
): GitDeliveryDescriptionAuthorityScope {
  return {
    remoteDigest: codingWorkbenchRemoteDigest(ownerAndRepo),
    pr: { ownerAndRepo, prNumber },
    snapshotDigest,
  };
}

// Admits through the SAME `gitDeliveryAuthorityGate` every other Git delivery mutation uses, for the
// "pull-request" operation — extended (#3399) to also accept the description authority when no run
// is active AND the caller supplied a `snapshotDigest` matching a live grant for this exact PR.
function admitDescription(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: BaseFields,
  workspace: WorkspaceInfo,
  logSink: ServerLogSink,
):
  | { readonly allowed: true; readonly scope: AdmittedScope }
  | { readonly allowed: false; readonly result: RouteResult } {
  const descriptionAuthority =
    deps.gitDeliveryDescriptionAuthority === undefined || request.snapshotDigest === undefined
      ? undefined
      : {
          port: deps.gitDeliveryDescriptionAuthority,
          scope: descriptionScopeFor(
            request.ownerAndRepo,
            request.prNumber,
            request.snapshotDigest,
          ),
        };
  const gate = gitDeliveryAuthorityGate(
    ctx,
    deps,
    request.projectId,
    workspace,
    "pull-request",
    {},
    { logSink, descriptionAuthority },
  );
  if (!gate.allowed) return { allowed: false, result: gate.result };
  // The description authority's fixed identity never matches a real run's `runId`, so `runId` is
  // omitted from the context exactly when this was admitted outside a running Code task.
  const runId = gate.runId === "description-authority" ? undefined : gate.runId;
  return { allowed: true, scope: { runId, authorityDigest: gate.envelopeDigest } };
}

/**
 * The description authority's second admitted effect: model egress of snapshot content for
 * description generation. Consulted only when no run is active; a running run's own authority
 * already covers generation (it is not a Git operation, so `authorizeGitDelivery` never gates it).
 */
export function admitDescriptionModelEgress(
  deps: Pick<UiHandlerDeps, "gitDeliveryAuthority" | "gitDeliveryDescriptionAuthority">,
  request: BaseFields,
  nowIso: string,
): boolean {
  if (deps.gitDeliveryAuthority?.current(nowIso) !== undefined) return true;
  if (deps.gitDeliveryDescriptionAuthority === undefined || request.snapshotDigest === undefined) {
    return false;
  }
  return (
    authorizeGitDeliveryModelEgress(
      deps.gitDeliveryDescriptionAuthority,
      descriptionScopeFor(request.ownerAndRepo, request.prNumber, request.snapshotDigest),
      nowIso,
    ) !== undefined
  );
}

// ─── Service cache ──────────────────────────────────────────────────────────────────────────────
//
// One stateful `PrDescriptionApplicationService` per (project, repository, PR) key, created lazily
// and reused across the preview -> approve -> apply lifecycle: the service holds the in-flight
// proposal and its approval continuation server-side (prDescriptionService.ts), which a fresh
// instance per HTTP request would lose between steps. `context()` is re-derived fresh on every
// internal call (never cached), so a revoked or changed authority is observed on the very next call
// without needing to evict the cache entry itself.
const serviceCache = new Map<string, PrDescriptionApplicationService>();
const MAX_CACHED_SERVICES = 512;

function cacheKey(projectId: string, ownerAndRepo: string, prNumber: number): string {
  return `${projectId} ${ownerAndRepo.toLowerCase()} ${String(prNumber)}`;
}

function pruneServiceCache(): void {
  while (serviceCache.size > MAX_CACHED_SERVICES) {
    const first = serviceCache.keys().next().value;
    if (first === undefined) break;
    serviceCache.delete(first);
  }
}

function unavailableService(): RouteResult {
  return errResult(503, "GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE");
}

function buildServiceOptions(
  deps: UiHandlerDeps,
  seams: PrDescriptionRouteExecutionSeams,
  workspace: WorkspaceInfo,
  contextProvider: () => PrDescriptionContext | undefined,
): PrDescriptionServiceOptions | undefined {
  const snapshots = seams.snapshots ?? deps.gitChangeSnapshotService;
  const generation = seams.generation;
  if (snapshots === undefined || generation === undefined) return undefined;
  const adapterFactory =
    seams.adapterFactory ?? ((): GitPullRequestBodyAdapter | undefined => undefined);
  return {
    context: contextProvider,
    snapshots,
    generation,
    adapter: (): GitPullRequestBodyAdapter | undefined => adapterFactory(workspace),
    mutationDeps: deps,
    execution: {
      now: seams.now,
      approvalStore: seams.approvalStore,
      activityLog: seams.activityLog,
    },
    recordStatus: seams.recordStatus ?? ((): boolean => false),
    readStatus: seams.readStatus ?? ((): undefined => undefined),
  };
}

interface PreparedPrDescriptionRequest<V extends BaseFields> {
  readonly value: V;
  readonly workspace: WorkspaceInfo;
  readonly service: PrDescriptionApplicationService;
  readonly context: () => PrDescriptionContext | undefined;
}

async function prepare<V extends BaseFields>(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: PrDescriptionRouteOptions,
  correlationId: string,
  validate: (parsed: unknown) => Validation<V>,
): Promise<
  | { readonly ok: true; readonly value: PreparedPrDescriptionRequest<V> }
  | { readonly ok: false; readonly result: RouteResult }
> {
  const read = await readParsedGitDeliveryBody(
    ctx.req,
    () => errResult(413, "GIT_DELIVERY_PR_DESCRIPTION_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST"),
  );
  if (!read.ok) return { ok: false, result: read.result };
  const validation = validate(read.value);
  if (validation.kind === "err") return { ok: false, result: validation.result };
  const request = validation.value;
  const workspace = resolveProjectWorkspace(deps, request.projectId);
  if (workspace === undefined) {
    return { ok: false, result: errResult(404, "GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROJECT") };
  }
  const seams = options.execution ?? {};
  const logSink = seams.activityLog ?? processServerLogSink();
  const admitted = admitDescription(ctx, deps, request, workspace, logSink);
  if (!admitted.allowed) return { ok: false, result: admitted.result };
  const key = cacheKey(request.projectId, request.ownerAndRepo, request.prNumber);
  const contextProvider = (): PrDescriptionContext | undefined => {
    const nowIso = new Date((seams.now ?? Date.now)()).toISOString();
    const reAdmitted = admitDescription(ctx, deps, request, workspace, logSink);
    if (!reAdmitted.allowed) return undefined;
    return {
      workspace,
      repository: request.ownerAndRepo,
      prNumber: request.prNumber,
      accessScope: { key },
      authorityDigest: reAdmitted.scope.authorityDigest,
      correlationId,
      ...(reAdmitted.scope.runId === undefined ? {} : { runId: reAdmitted.scope.runId }),
      stillAuthorized: (): boolean =>
        admitDescription(ctx, deps, request, workspace, logSink).allowed,
      signal: undefined as AbortSignal | undefined,
    };
  };
  let service = serviceCache.get(key);
  if (service === undefined) {
    if (options.serviceFactory !== undefined) {
      service = options.serviceFactory(contextProvider);
    } else {
      const serviceOptions = buildServiceOptions(deps, seams, workspace, contextProvider);
      if (serviceOptions === undefined) return { ok: false, result: unavailableService() };
      service = createPrDescriptionApplicationService(serviceOptions);
    }
    serviceCache.set(key, service);
    pruneServiceCache();
  }
  return { ok: true, value: { value: request, workspace, service, context: contextProvider } };
}

// ─── Body-free apply-lifecycle logging ─────────────────────────────────────────────────────────

type ApplyLifecyclePhase = "started" | "succeeded" | "blocked" | "failed";

function logApplyLifecycle(
  activityLog: ServerLogSink,
  correlationId: string,
  phase: ApplyLifecyclePhase,
  extra?: Record<string, unknown>,
): void {
  activityLog.write({
    category: "process",
    op: `pr-description.apply.${phase}`,
    correlationId,
    ...(phase === "failed" ? { level: "warn", errorKind: "internal" } : {}),
    extra,
  });
}

// ─── Handlers ───────────────────────────────────────────────────────────────────────────────────

export const createHandlePrDescriptionPreview = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepare(ctx, deps, options, correlationId, validatePreview);
    if (!prepared.ok) return prepared.result;
    const { value, service } = prepared.value;
    const result = await service.preview({
      language: value.language,
      refinement: value.refinement,
    });
    return { status: 200, body: deps.redactor(result) };
  };
};

export const createHandlePrDescriptionApprove = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepare(ctx, deps, options, correlationId, validateProposal);
    if (!prepared.ok) return prepared.result;
    const { value, service } = prepared.value;
    const issued = service.issueApproval(value.proposalId);
    if (issued === undefined) {
      return errResult(409, "GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROPOSAL");
    }
    return {
      status: 200,
      body: deps.redactor({
        schemaVersion: "1",
        proposalId: value.proposalId,
        expiresAt: new Date(issued.expiresAtMs).toISOString(),
      }),
    };
  };
};

export const createHandlePrDescriptionApply = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepare(ctx, deps, options, correlationId, validateProposal);
    if (!prepared.ok) return prepared.result;
    const { value, service } = prepared.value;
    const seams = options.execution ?? {};
    const activityLog = seams.activityLog ?? processServerLogSink();
    logApplyLifecycle(activityLog, correlationId, "started", { hasProposalId: true });
    const lease = service.consumeApproval(value.proposalId);
    if (lease === undefined) {
      logApplyLifecycle(activityLog, correlationId, "blocked", { reason: "approval-invalid" });
      return errResult(409, "GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROPOSAL");
    }
    const result = await service.executeApproved(value.proposalId, lease);
    if (result.outcome === "blocked") {
      logApplyLifecycle(activityLog, correlationId, "blocked", { reason: result.reason });
    } else if (result.outcome === "observed") {
      logApplyLifecycle(activityLog, correlationId, "succeeded", { state: result.status.state });
    } else {
      logApplyLifecycle(activityLog, correlationId, "failed");
    }
    return { status: 200, body: deps.redactor(result) };
  };
};

export const createHandlePrDescriptionStatus = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepare(ctx, deps, options, correlationId, validateStatus);
    if (!prepared.ok) return prepared.result;
    const { service } = prepared.value;
    const result = await service.reconcile();
    return { status: 200, body: deps.redactor(result) };
  };
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryPrDescriptionRouteGroup = (
  options: PrDescriptionRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/pr-description/preview",
    handler: createHandlePrDescriptionPreview(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pr-description/approve",
    handler: createHandlePrDescriptionApprove(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pr-description/apply",
    handler: createHandlePrDescriptionApply(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pr-description/status",
    handler: createHandlePrDescriptionStatus(options),
  },
];

export const GIT_DELIVERY_PR_DESCRIPTION_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryPrDescriptionRouteGroup();

// Test/diagnostic-only: clears the process-wide service cache between test files so one file's
// admitted scope can never leak a stateful proposal into another's.
export function clearPrDescriptionServiceCache(): void {
  serviceCache.clear();
}
