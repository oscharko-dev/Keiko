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
  type GitDeliveryDescriptionAuthorityAdmission,
} from "./runBoundAuthority.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  type GitDeliveryApprovalOperation,
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

// The exact per-operation approval binding this admission attempt corresponds to — the SAME
// operation + typed command the route's own approve/execute logic mints/consumes moments later.
// Paired with `GitDeliveryAuthorityAuditSeams.approval`/`approvalStore` for the non-consuming peek
// in `gitDeliveryApprovalRedemption` below; never consumed here (the route's own execute-time
// `resolveGitDeliveryApprovalRequirement` call is the single-use consumption).
export interface GitDeliveryApprovalBindingHint {
  readonly operation: GitDeliveryApprovalOperation;
  readonly command: unknown;
}

export interface GitDeliveryAuthorityAuditSeams {
  readonly nowIso?: string | undefined;
  readonly logSink?: ServerLogSink | undefined;
  readonly expectedAuthority?: GitDeliveryAuthorityIdentity | undefined;
  readonly phase?: GitDeliveryAuthorityPhase | undefined;
  // Final-audit F2/#3390 (ADR-0138 D2, epic #3384 correction 5): a delivery effect (commit, push,
  // pull-request, merge, pr-mark-ready, pr-description-apply) is designed to be approval-required,
  // never mode-denied, in every mode below `autonomous-delivery`. Every one of those operations'
  // OWN execute path already enforces a mandatory, mode-independent consumed approval claim
  // regardless of what the repo/org policy pack decides (policyPackMintability.ts documents each
  // one) — so this coarse admission layer does not need a SECOND, redundant claim of its own to
  // admit the attempt. Setting this true defers the "approval-required" disposition to that
  // downstream enforcement, exactly mirroring how `autonomous-delivery` already bypasses the same
  // matrix cell. It must be set at BOTH the mint (`/approve`) and execute admission calls for such
  // an operation (minting has no delivery effect of its own — the human's actual consent is
  // exercised once the minted claim is presented at execute — so it would be incoherent to admit
  // execute but refuse the mint that produces what execute needs) and at the continuity re-check
  // immediately before remote dispatch. Never set it for an operation without such downstream
  // enforcement (workspace-contained local mutations) — see `approval`/`approvalBinding` below for
  // that case instead.
  readonly deliveryApprovalDeferred?: boolean | undefined;
  // The workspace-contained-scope alternative to `deliveryApprovalDeferred` above: local mutations
  // (branch-create/switch, stage/unstage) have no operation-independent mandatory downstream
  // enforcement — the repo/org policy pack decides per command whether a consumed claim is even
  // required — so a lower mode's "approval-required" disposition can only be redeemed by an actual
  // matching claim, never by deferring unconditionally (that would let a routine local edit skip
  // human confirmation entirely in "Ask for approval" mode). `approval` is the SAME claim the
  // caller already parsed from its own request body; `approvalBinding` names the exact operation +
  // command it is bound to. Both are required together; either omitted leaves "approval-required" a
  // hard refusal. The check is a non-consuming peek (`GitDeliveryApprovalStore.matches`) — the
  // caller's own subsequent `resolveGitDeliveryApprovalRequirement` call is what actually consumes
  // the claim once, so it is never spent twice on the same request.
  readonly approval?: ParsedGitDeliveryApprovalRequest | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly approvalBinding?: GitDeliveryApprovalBindingHint | undefined;
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
// mode/resource-scope/risk matrix resolves "approval-required" for a lower mode (per
// `resolveModeDecision`'s own contract in runBoundAuthority.ts). Two independent mechanisms, never
// combined for one call:
//
//   1. `deliveryApprovalDeferred` — the delivery-scope path (commit/push/pr/merge/pr-mark-ready/
//      pr-description-apply). These operations already enforce a mandatory, mode-independent
//      approval consumption at their OWN execute layer, so admission simply defers to it instead of
//      demanding a second claim of its own — exactly like `autonomous-delivery` already bypasses
//      this same matrix cell.
//   2. `approval` + `approvalStore` + `approvalBinding` — the workspace-contained path (local
//      mutations). A non-consuming peek (`GitDeliveryApprovalStore.matches`) against the SAME claim
//      the caller already parsed from its own request body, bound to the exact operation + command
//      it names. Never `.consume()`s the record: the caller's own subsequent
//      `resolveGitDeliveryApprovalRequirement` call performs the single real consumption, so the
//      claim is spent exactly once even though it is checked here first.
//
// Returns undefined when the caller set neither, so a route that has not been threaded through this
// seam is unaffected: "approval-required" stays a hard refusal (fail-closed).
function gitDeliveryApprovalRedemption(
  projectId: string,
  audit: GitDeliveryAuthorityAuditSeams,
): GitDeliveryApprovalRedemption | undefined {
  if (audit.deliveryApprovalDeferred === true) {
    return (): boolean => true;
  }
  if (audit.approval?.kind !== "claim" || audit.approvalBinding === undefined) return undefined;
  const claim = audit.approval.claim;
  const { operation, command } = audit.approvalBinding;
  const store = audit.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
  const nowMs = Date.parse(audit.nowIso ?? new Date().toISOString());
  return (active: ActiveGitDeliveryRunAuthority): boolean =>
    store.matches({
      approval: claim,
      binding: {
        projectId,
        operation,
        command,
        runId: active.runId,
        envelopeDigest: active.envelopeDigest,
      },
      nowMs,
    });
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
