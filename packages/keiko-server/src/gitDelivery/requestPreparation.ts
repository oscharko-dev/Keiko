// Shared request-preparation prologue for the governed Git delivery routes that resolve a project
// workspace (publish #476, pull request #477, merge #478, and the fetch/pull sync routes). Each of
// those route groups opens BOTH its preview and execute handler with the same three steps: read +
// JSON-parse the bounded body, validate it, then authorize the project workspace — differing only in
// the typed error envelope and the per-route validator. This module is the single home for that
// prologue so the handlers never re-duplicate it.
//
// The commit, local-mutation, and agent-operations routes take a different handler shape (a spec or
// composite-dispatch parameter) and share only the lower-level readParsedGitDeliveryBody guard, not
// this scaffold.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { GitRepositoryAgentOperationKind } from "@oscharko-dev/keiko-contracts";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { CORRELATION_RESPONSE_HEADER, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/index.js";
import { resolveProjectWorkspace } from "./execution.js";
import { readParsedGitDeliveryBody } from "./requestGuards.js";
import {
  authorizeGitDelivery,
  type ActiveGitDeliveryRunAuthority,
  type GitDeliveryApprovalRedemption,
  type GitDeliveryAuthorityDenial,
  type GitDeliveryAuthorityRequest,
  type GitDeliveryDescriptionAuthorityAdmission,
} from "./runBoundAuthority.js";
import {
  resolveGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalStore,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";

// The validator each route already exposes: it maps an unknown parsed body to either a typed request
// value (carrying the projectId) or a ready-to-return error result.
export type GitDeliveryValidation<V> =
  | { readonly kind: "ok"; readonly value: V }
  | { readonly kind: "err"; readonly result: RouteResult };

// The three route-specific error envelopes the prologue can return, pre-built by the caller so this
// module stays agnostic of each route's error-code union.
export interface GitDeliveryRequestErrors {
  readonly tooLarge: RouteResult;
  readonly badRequest: RouteResult;
  readonly unknownProject: RouteResult;
}

export type PreparedGitDeliveryRequest<V> =
  | { readonly ok: true; readonly value: V; readonly workspace: WorkspaceInfo }
  | { readonly ok: false; readonly result: RouteResult };

export interface GitDeliveryAuthorityTarget {
  readonly headBranchName?: string | undefined;
  readonly baseBranchName?: string | undefined;
  readonly remoteBranchName?: string | undefined;
}

export interface GitDeliveryAuthorityAuditSeams {
  readonly nowIso?: string | undefined;
  readonly logSink?: ServerLogSink | undefined;
  readonly expectedAuthority?: GitDeliveryAuthorityIdentity | undefined;
  readonly phase?: GitDeliveryAuthorityPhase | undefined;
  // ADR-0138 D2: when the mode/resource-scope/risk matrix resolves "approval-required" for a lower
  // mode (governed-assist, supervised-coding), the caller may offer a one-use claim to redeem it
  // instead of failing closed outright. Both must be supplied together to have any effect; either
  // omitted leaves "approval-required" a hard refusal (today's behaviour for every mounted route,
  // since none yet threads a claim through this seam — #3387/#3390 are the producers that will).
  readonly approval?: ParsedGitDeliveryApprovalRequest | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  // #3399 (epic #3384 correction 4): admits the "pull-request" body-only description apply outside
  // a running Code task, over the server-minted description authority, when no run is active. Has
  // no effect on any other operation — `authorizeGitDelivery` only consults it for "pull-request".
  readonly descriptionAuthority?: GitDeliveryDescriptionAuthorityAdmission | undefined;
}

export type GitDeliveryAuthorityPhase = "admission" | "continuity";

export interface GitDeliveryAuthorityIdentity {
  readonly runId: string;
  readonly envelopeDigest: string;
}

export type GitDeliveryAuthorityGate =
  | ({ readonly allowed: true } & GitDeliveryAuthorityIdentity)
  | {
      readonly allowed: false;
      readonly reason: GitDeliveryAuthorityDenial | "authority-changed";
      readonly result: RouteResult;
    };

interface GitDeliveryAuthorityContinuityInput {
  readonly ctx: RouteContext;
  readonly deps: Pick<UiHandlerDeps, "gitDeliveryAuthority">;
  readonly projectId: string;
  readonly workspace: WorkspaceInfo;
  readonly operation: GitRepositoryAgentOperationKind;
  readonly target?: GitDeliveryAuthorityTarget | undefined;
  readonly admitted: GitDeliveryAuthorityIdentity;
  readonly next?: (() => boolean) | undefined;
  readonly audit?: Pick<GitDeliveryAuthorityAuditSeams, "nowIso" | "logSink"> | undefined;
  // Optional out-parameter: when the continuity re-check denies (the admitted authority changed or
  // was revoked between admission and remote dispatch), the denial's 403 RouteResult is written here
  // — see GitDeliveryAuthorityContinuityDenialCapture for why the caller needs it.
  readonly denialCapture?: GitDeliveryAuthorityContinuityDenialCapture | undefined;
}

// The continuity guard runs INSIDE the narrow remote adapter, right before the actual network/`gh api`
// dispatch (see pushExecution.ts/prExecution.ts/mergeExecution.ts's authorityGuarded*Adapter). When it
// denies, the adapter never spawns: it logs the F4 no-spawn marker (logGitDeliveryNoSpawnRefusal in
// execution.ts) and resolves a synthetic, code-less "aborted" execution result instead of calling the
// real adapter — so the gateway's execute phase has something to return. But that synthetic result is
// NOT a real execution outcome: fed through the ordinary success/failure taxonomy it reads as a
// transient, retryable "internal-error" (persisted to the evidence ledger and returned to the client
// with HTTP 200), which is exactly wrong for a request that was refused before anything ran. The route
// already knows how to answer an authority denial correctly (the SAME 403 GIT_DELIVERY_AUTHORITY_DENIED
// body the admission gate returns for the up-front check) — this capture is how the continuity guard,
// which fires deep inside the adapter, hands that 403 back up to the route so it can return the SAME
// body instead of projecting the misleading synthetic result.
export interface GitDeliveryAuthorityContinuityDenialCapture {
  result?: RouteResult;
  reason?: GitDeliveryAuthorityDenial | "authority-changed";
  phase?: "continuity";
}

function deniedAuthorityGate(
  ctx: RouteContext,
  reason: GitDeliveryAuthorityDenial | "authority-changed",
): GitDeliveryAuthorityGate {
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  return {
    allowed: false,
    reason,
    result: {
      status: 403,
      body: errorBody(
        "GIT_DELIVERY_AUTHORITY_DENIED",
        "The accepted runtime authority does not admit this Git delivery operation.",
        correlationId,
      ),
      headers: {
        [CORRELATION_RESPONSE_HEADER]: correlationId,
      },
    },
  };
}

function authorityIdentityChanged(
  decision: GitDeliveryAuthorityIdentity,
  expected: GitDeliveryAuthorityIdentity | undefined,
): boolean {
  return (
    expected !== undefined &&
    (decision.runId !== expected.runId || decision.envelopeDigest !== expected.envelopeDigest)
  );
}

export function logGitDeliveryAuthorityDenial(
  ctx: RouteContext,
  operation: GitRepositoryAgentOperationKind,
  reason:
    | GitDeliveryAuthorityDenial
    | "authority-changed"
    | "workspace-unresolvable"
    | "verified-commit-required",
  phase: GitDeliveryAuthorityPhase = "admission",
  logSink: ServerLogSink = processServerLogSink(),
): void {
  logSink.write({
    category: "security",
    op: "git.delivery.authority.denied",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    status: 403,
    extra: { operation, phase, reason },
  });
}

function authorityPhaseFor(audit: GitDeliveryAuthorityAuditSeams): GitDeliveryAuthorityPhase {
  if (audit.phase !== undefined) return audit.phase;
  return audit.expectedAuthority === undefined ? "admission" : "continuity";
}

function admittedAuthorityGate(
  ctx: RouteContext,
  operation: GitRepositoryAgentOperationKind,
  decision: GitDeliveryAuthorityIdentity,
  audit: GitDeliveryAuthorityAuditSeams,
  phase: GitDeliveryAuthorityPhase,
  logSink: ServerLogSink,
): GitDeliveryAuthorityGate {
  if (authorityIdentityChanged(decision, audit.expectedAuthority)) {
    logGitDeliveryAuthorityDenial(ctx, operation, "authority-changed", phase, logSink);
    return deniedAuthorityGate(ctx, "authority-changed");
  }
  logSink.write({
    category: "security",
    op: "git.delivery.authority.admitted",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    status: 200,
    extra: { operation, phase, runId: decision.runId },
  });
  return { allowed: true, runId: decision.runId, envelopeDigest: decision.envelopeDigest };
}

// Builds the caller-side redemption hook `authorizeGitDelivery` consults only when its own
// mode/resource-scope/risk matrix resolves "approval-required" for a lower mode. The claim is bound
// to the run's own identity and the operation attempted — never to a route-specific command shape,
// since this coarse admission layer redeems a distinct "this run may attempt this operation right
// now" fact, not the operation's own execute-time approval (commit's, for instance, which binds the
// exact message and is consumed separately by the commit route itself). Returns undefined when the
// caller supplied neither an approval request nor a store, so every existing route that does not yet
// thread this seam (all of them, until #3387/#3390 land) is unaffected: "approval-required" stays a
// hard refusal, exactly today's fail-closed posture for what was previously "mode-denied".
function gitDeliveryApprovalRedemption(
  projectId: string,
  audit: GitDeliveryAuthorityAuditSeams,
): GitDeliveryApprovalRedemption | undefined {
  if (audit.approval === undefined) return undefined;
  const approval = audit.approval;
  return (active: ActiveGitDeliveryRunAuthority, request: GitDeliveryAuthorityRequest): boolean => {
    const requirement = resolveGitDeliveryApprovalRequirement(approval, {
      store: audit.approvalStore,
      binding: {
        projectId,
        operation: "authority-admission",
        command: { operation: request.operation },
        runId: active.runId,
        envelopeDigest: active.envelopeDigest,
      },
      nowMs: Date.parse(audit.nowIso ?? new Date().toISOString()),
    });
    return requirement?.required === true;
  };
}

/**
 * Applies the sole delivery-write admission decision after a project workspace has been resolved.
 * This intentionally consumes only the live server-owned runtime authority; headers, browser state,
 * and deployment defaults cannot grant access here.
 */
export function gitDeliveryAuthorityGate(
  ctx: RouteContext,
  deps: Pick<UiHandlerDeps, "gitDeliveryAuthority">,
  projectId: string,
  workspace: WorkspaceInfo,
  operation: GitRepositoryAgentOperationKind,
  target: GitDeliveryAuthorityTarget = {},
  audit: GitDeliveryAuthorityAuditSeams = {},
): GitDeliveryAuthorityGate {
  const decision = authorizeGitDelivery(
    deps.gitDeliveryAuthority,
    { projectId, workspaceRoot: workspace.root, operation, ...target },
    audit.nowIso ?? new Date().toISOString(),
    gitDeliveryApprovalRedemption(projectId, audit),
    audit.descriptionAuthority,
  );
  const logSink = audit.logSink ?? processServerLogSink();
  const phase = authorityPhaseFor(audit);
  if (decision.allowed) {
    return admittedAuthorityGate(ctx, operation, decision, audit, phase, logSink);
  }
  logGitDeliveryAuthorityDenial(ctx, operation, decision.reason, phase, logSink);
  return deniedAuthorityGate(ctx, decision.reason);
}

export function gitDeliveryAuthorityContinuityGuard(
  input: GitDeliveryAuthorityContinuityInput,
): () => boolean {
  return (): boolean => {
    const latest = gitDeliveryAuthorityGate(
      input.ctx,
      input.deps,
      input.projectId,
      input.workspace,
      input.operation,
      input.target,
      {
        ...input.audit,
        expectedAuthority: input.admitted,
        phase: "continuity",
      },
    );
    if (!latest.allowed) {
      if (input.denialCapture !== undefined) {
        input.denialCapture.result = latest.result;
        input.denialCapture.reason = latest.reason;
        input.denialCapture.phase = "continuity";
      }
      return false;
    }
    return input.next?.() ?? true;
  };
}

export function gitDeliveryAuthorityDenial(
  ctx: RouteContext,
  deps: Pick<UiHandlerDeps, "gitDeliveryAuthority">,
  projectId: string,
  workspace: WorkspaceInfo,
  operation: GitRepositoryAgentOperationKind,
  target: GitDeliveryAuthorityTarget = {},
  audit: GitDeliveryAuthorityAuditSeams = {},
): RouteResult | undefined {
  const gate = gitDeliveryAuthorityGate(ctx, deps, projectId, workspace, operation, target, audit);
  return gate.allowed ? undefined : gate.result;
}

// Runs the shared read → validate → resolve-workspace prologue. Returns the validated request value
// together with its authorized workspace, or the first typed error result encountered. `V` must carry
// the `projectId` the workspace is resolved (and authorized) from.
export const prepareGitDeliveryRequest = async <V extends { readonly projectId: string }>(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  errors: GitDeliveryRequestErrors,
  validate: (parsed: unknown) => GitDeliveryValidation<V>,
): Promise<PreparedGitDeliveryRequest<V>> => {
  const read = await readParsedGitDeliveryBody(
    ctx.req,
    () => errors.tooLarge,
    () => errors.badRequest,
  );
  if (!read.ok) return { ok: false, result: read.result };
  const validation = validate(read.value);
  if (validation.kind === "err") return { ok: false, result: validation.result };
  const workspace = resolveProjectWorkspace(deps, validation.value.projectId);
  if (workspace === undefined) return { ok: false, result: errors.unknownProject };
  return { ok: true, value: validation.value, workspace };
};
