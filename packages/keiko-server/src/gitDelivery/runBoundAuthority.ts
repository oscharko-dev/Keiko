import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchPolicyResourceScope,
  GitRepositoryAgentOperationKind,
} from "@oscharko-dev/keiko-contracts";
// Runtime values live behind the explicit runtime/<domain> subpath (see keiko-contracts/src/index.ts's
// own header comment) — the bare package specifier is a type-only surface.
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  gitOperationRequirement,
  type GitOperationRequirement,
} from "../coding-runtime/gitOperationRequirements.js";

// The Git delivery routes must never derive authority from a deployment-wide default. This is the
// server-private projection of the one accepted runtime that currently owns delivery authority.
// Raw workspace values remain inside the server process; callers receive only an allow/deny result.
export interface ActiveGitDeliveryRunAuthority {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly branch: {
    readonly headRef: string;
    readonly baseRef: string;
    readonly allowedPrefixes: readonly string[];
  };
  readonly authority: CodingWorkbenchAuthorityEnvelope;
}

export interface GitDeliveryRunAuthorityPort {
  current(nowIso: string): ActiveGitDeliveryRunAuthority | undefined;
}

// #3399 (epic #3384 correction 4): the server-minted, bounded description authority that admits
// description generation and the "pull-request" body-only apply outside a running Code task.
// Produced and revalidated exclusively by `runtimeAuthorityService.ts` (the owner of this and
// `ActiveGitDeliveryRunAuthority` alike); this module only consults it at admission.
export interface GitDeliveryDescriptionAuthorityPrIdentity {
  readonly ownerAndRepo: string;
  readonly prNumber: number;
}
export interface GitDeliveryDescriptionAuthorityBaseHead {
  readonly baseRef: string;
  readonly headRef: string;
}
export interface GitDeliveryDescriptionAuthorityScope {
  readonly remoteDigest: string;
  readonly pr: GitDeliveryDescriptionAuthorityPrIdentity | GitDeliveryDescriptionAuthorityBaseHead;
  readonly snapshotDigest: string;
}
export interface ActiveGitDeliveryDescriptionAuthority {
  readonly scope: GitDeliveryDescriptionAuthorityScope;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly expiresAt: string;
}
export interface GitDeliveryDescriptionAuthorityPort {
  current(
    scope: GitDeliveryDescriptionAuthorityScope,
    nowIso: string,
  ): ActiveGitDeliveryDescriptionAuthority | undefined;
}
// The two effects the description authority may admit — deliberately a SMALL, LOCAL union rather
// than a `GitRepositoryAgentOperationKind` member: "model-egress" is not a Git operation at all
// (there is no argv, no adapter, no branch target), and reusing that broader vocabulary here would
// force every unrelated switch/table over it (`gitOperationRequirements.ts`'s per-kind connector
// scopes, the action-sheet preview projection) to grow a case that means something structurally
// different. "pull-request" reuses the SAME string the run-bound admission already uses for both
// pr-create and pr-update, since the apply is scoped by policy (KEIKO_DEFAULT_PR_POLICY_PACK's
// dedicated `pr-description-apply` rule) and by the approval binding, not by this operation tag.
export type GitDeliveryDescriptionAuthorityOperation = "model-egress" | "pull-request";
// A fixed, non-secret run identity so the description authority can be threaded through the SAME
// `runId`/`envelopeDigest`-bound approval binding shape every other Git delivery approval uses,
// without a real Code task run. `envelopeDigest` is the scope's own content digest, so an approval
// minted against a stale scope cannot be redeemed once the scope changes underneath it.
export const DESCRIPTION_AUTHORITY_RUN_ID = "description-authority";

export type GitDeliveryAuthorityDenial =
  | "accepted-run-unavailable"
  | "authority-expired"
  | "workspace-out-of-envelope"
  | "mode-denied"
  // ADR-0138 D2: a delivery effect is approval-required in every mode, never mode-denied. This
  // reason is returned when the mode/resource-scope/risk matrix (codingWorkbenchPolicyEffectFor)
  // resolves "approval-required" and no redeemable claim was presented (see `redeemApproval`
  // below). It is never returned for `autonomous-delivery` at this admission layer: Full access
  // already proceeds here, and the operation's own execute path (e.g. the commit route) carries
  // the actual mandatory-approval enforcement for that mode, matching how `merge` already does.
  | "approval-required"
  | "permission-scope-missing"
  | "branch-out-of-envelope";

export interface GitDeliveryAuthorityRequest {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly operation: GitRepositoryAgentOperationKind;
  readonly headBranchName?: string | undefined;
  readonly baseBranchName?: string | undefined;
  // A push's remote ref is the remote counterpart of the head, never the repository base.
  readonly remoteBranchName?: string | undefined;
}

// Invoked only when the matrix resolves "approval-required" for a lower mode. Returns true when the
// caller redeemed a one-use claim bound to this exact run's identity, in which case admission
// proceeds as allowed. Kept as an injected predicate (rather than an approvalStore import here) so
// this module stays a pure function of its active-run port and the caller's own store choice — see
// `gitDeliveryAuthorityGate` in requestPreparation.ts for the production wiring.
export type GitDeliveryApprovalRedemption = (
  active: ActiveGitDeliveryRunAuthority,
  request: GitDeliveryAuthorityRequest,
) => boolean;

export type GitDeliveryAuthorityDecision =
  | {
      readonly allowed: true;
      readonly runId: string;
      readonly envelopeDigest: string;
    }
  | { readonly allowed: false; readonly reason: GitDeliveryAuthorityDenial };

function expired(nowIso: string, expiresAt: string): boolean {
  const nowMs = Date.parse(nowIso);
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(nowMs) || Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs;
}

function branchAllowed(branch: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => branch === prefix || branch.startsWith(prefix));
}

function withinBranchEnvelope(
  request: GitDeliveryAuthorityRequest,
  active: ActiveGitDeliveryRunAuthority,
): boolean {
  const head = request.headBranchName;
  const base = request.baseBranchName;
  const remote = request.remoteBranchName;
  if (head !== undefined && head !== active.branch.headRef) return false;
  if (base !== undefined && base !== active.branch.baseRef) return false;
  if (remote !== undefined && remote !== active.branch.headRef) return false;
  return branchAllowed(active.branch.headRef, active.branch.allowedPrefixes);
}

function hasRequiredScopes(
  active: ActiveGitDeliveryRunAuthority,
  requirement: GitOperationRequirement,
): boolean {
  const authority = active.authority;
  if (
    !requirement.actionClasses.every((actionClass) => authority.actionClasses.includes(actionClass))
  ) {
    return false;
  }
  if (!requirement.connectorScopes.every((scope) => authority.connectorScopes.includes(scope))) {
    return false;
  }
  if (!requirement.needsNetwork) return true;
  if (authority.networkPolicy.mode === "deny-all") return false;
  return requirement.connectorScopes.every((scope) =>
    authority.networkPolicy.connectorScopes.includes(scope),
  );
}

// A network-reaching requirement (fetch/pull/push/pull-request/merge, and a local commit's own
// delivery-substrate class) carries ADR-0138 D2's "delivery" resource scope; every other Git
// operation (status/diff/branch-list/branch-create/branch-switch/stage/unstage) is
// "workspace-contained". "medium" is used uniformly for the risk dimension: the "delivery" row is
// approval-required at every risk tier, and the "workspace-contained" row's low/medium cells agree
// with the fixed threshold this gate has always applied to local, non-network Git work.
function gitDeliveryPolicyScope(
  requirement: GitOperationRequirement,
): CodingWorkbenchPolicyResourceScope {
  return requirement.needsNetwork || requirement.actionClasses.includes("delivery-substrate")
    ? "delivery"
    : "workspace-contained";
}

// ADR-0138 D2 / #3386 contract correction 1 ("Scope and network checks stay as stricter-wins gates
// but cannot be the mode signal"): `source-control.write`, `delivery-substrate` and a
// connector-scoped network policy are minted only for `autonomous-delivery`
// (productionRuntimeWorkspaceAuthority.ts's `runtimeActionClasses`/`connectorScopes`/
// `runtimeNetworkPolicy`, ~lines 63-100 — that module is out of this item's write scope). A "delivery"
// effect is designed to be approval-required, never scope-eligible, in every lower mode, so gating on
// that absent, by-design-withheld scope ahead of the matrix would make the approval-required /
// redemption path structurally unreachable for every real authority envelope below
// `autonomous-delivery` — exactly the gap a prior pass's fully-permissive test fixture hid. This
// classifies only; it grants no capability the matrix (and, when consulted, the redeemed claim) did
// not already decide. `autonomous-delivery` itself keeps the scope/network gate as a genuine,
// stricter-wins check: an envelope that reaches this admission under-scoped is still refused there.
function deliveryScopeCheckDeferredToModeDecision(
  active: ActiveGitDeliveryRunAuthority,
  requirement: GitOperationRequirement,
): boolean {
  return (
    active.authority.effectiveMode !== "autonomous-delivery" &&
    gitDeliveryPolicyScope(requirement) === "delivery"
  );
}

type GitDeliveryModeDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "mode-denied" | "approval-required" };

// ADR-0138 D2 at this enforcement point. `autonomous-delivery` (Full access) is resolved outright:
// the matrix's "delivery" row is approval-required at every risk tier in every mode, including Full
// access, but this coarse admission layer is not where that approval is redeemed for an operation
// whose own execute path already carries mandatory, mode-independent approval enforcement (commit,
// merge, push, pr, pr-mark-ready, pr-description-apply — `deliveryApprovalDeferred` in
// requestPreparation.ts) — re-deriving it here would double-gate those operations against a store
// this function cannot see into. A lower mode's approval-required delivery effect still needs to
// clear HERE for the two operations with no such downstream enforcement of their own: fetch/pull
// (no `GitDeliveryActionKind` / kernel policy pack at all — syncRoutes.ts) and local mutations (the
// pack decides per command). Both redeem via the SAME non-consuming-peek mechanism instead
// (`approval`/`approvalStore`/`approvalBinding` below), final-audit F1/F2 (#3390).
function modeDecision(
  active: ActiveGitDeliveryRunAuthority,
  requirement: GitOperationRequirement,
): GitDeliveryModeDecision {
  if (active.authority.effectiveMode === "autonomous-delivery") return { ok: true };
  const scope = gitDeliveryPolicyScope(requirement);
  const effect = codingWorkbenchPolicyEffectFor(active.authority.effectiveMode, scope, "medium");
  if (effect === "allowed") return { ok: true };
  if (effect === "denied") return { ok: false, reason: "mode-denied" };
  return { ok: false, reason: "approval-required" };
}

// Resolves the mode/resource-scope/risk matrix outcome into the final decision, consulting
// `redeemApproval` only when the matrix itself did not already admit the operation. Split out of
// `authorizeGitDelivery` purely to keep that function's cyclomatic complexity under the repo's bar
// (AGENTS.md §6) — no behavioral seam of its own.
function resolveModeDecision(
  active: ActiveGitDeliveryRunAuthority,
  request: GitDeliveryAuthorityRequest,
  requirement: GitOperationRequirement,
  redeemApproval: GitDeliveryApprovalRedemption | undefined,
): GitDeliveryAuthorityDecision {
  const decision = modeDecision(active, requirement);
  if (decision.ok) {
    return { allowed: true, runId: active.runId, envelopeDigest: active.envelopeDigest };
  }
  // Final-audit F2: redemption is consulted ONLY for "approval-required" — matching
  // `GitDeliveryApprovalRedemption`'s own documented contract ("Invoked only when the matrix
  // resolves 'approval-required'"), which this line previously did not enforce (it consulted
  // redemption for ANY non-ok reason, "mode-denied" included). A hard "mode-denied" stays
  // mode-independent and non-redeemable, matching AGENTS.md's fail-closed posture for a genuine
  // denial versus a disposition a human can still clear.
  if (decision.reason === "approval-required" && redeemApproval?.(active, request) === true) {
    return { allowed: true, runId: active.runId, envelopeDigest: active.envelopeDigest };
  }
  return { allowed: false, reason: decision.reason };
}

// #3399: the caller-supplied admission the description authority offers ONLY for the
// "pull-request" body-only apply, consulted exclusively when no running accepted run exists (a
// run, when present, remains the sole authority for every operation — the description authority
// never widens what an active run already decides). Bound to the exact scope the caller re-derives
// immediately before the effect; a stale re-check, a different PR, or a moved base/head simply
// finds no live record at the port, which falls through to the SAME `accepted-run-unavailable`
// closed reason a missing run produces — this admission source never introduces a new "reason".
export interface GitDeliveryDescriptionAuthorityAdmission {
  readonly port: GitDeliveryDescriptionAuthorityPort;
  readonly scope: GitDeliveryDescriptionAuthorityScope;
}

function descriptionAuthorityEnvelopeDigest(scope: GitDeliveryDescriptionAuthorityScope): string {
  return sha256Hex(canonicalise(scope));
}

function admitByDescriptionAuthority(
  request: GitDeliveryAuthorityRequest,
  admission: GitDeliveryDescriptionAuthorityAdmission | undefined,
  nowIso: string,
): GitDeliveryAuthorityDecision | undefined {
  if (admission === undefined || request.operation !== "pull-request") return undefined;
  const active = admission.port.current(admission.scope, nowIso);
  if (active === undefined) return undefined;
  return {
    allowed: true,
    runId: DESCRIPTION_AUTHORITY_RUN_ID,
    envelopeDigest: descriptionAuthorityEnvelopeDigest(admission.scope),
  };
}

/**
 * Single server-owned admission decision for every state-changing Git delivery operation. It is
 * deliberately pure over a server-private active-run port, so a browser checkbox, CSRF header, or
 * static deployment ceiling can never stand in for the accepted run's Authority Envelope.
 *
 * `redeemApproval`, when supplied, is consulted only when the mode/resource-scope/risk matrix
 * resolves "approval-required" for a lower mode: it lets the caller admit the operation over a
 * one-use claim bound to this exact accepted run instead of failing closed outright.
 *
 * `descriptionAuthority`, when supplied, is consulted only when no running accepted run exists AND
 * `request.operation === "pull-request"` — the body-only description apply's admission outside a
 * Code task (#3399, epic #3384 correction 4). Every other operation keeps requiring a running
 * accepted run; this parameter has no effect on any other operation.
 */
export function authorizeGitDelivery(
  authorityPort: GitDeliveryRunAuthorityPort | undefined,
  request: GitDeliveryAuthorityRequest,
  nowIso: string,
  redeemApproval?: GitDeliveryApprovalRedemption,
  descriptionAuthority?: GitDeliveryDescriptionAuthorityAdmission,
): GitDeliveryAuthorityDecision {
  const active = authorityPort?.current(nowIso);
  if (active === undefined) {
    return (
      admitByDescriptionAuthority(request, descriptionAuthority, nowIso) ?? {
        allowed: false,
        reason: "accepted-run-unavailable",
      }
    );
  }
  if (expired(nowIso, active.authority.expiresAt))
    return { allowed: false, reason: "authority-expired" };
  if (active.projectId !== request.projectId || active.workspaceRoot !== request.workspaceRoot) {
    return { allowed: false, reason: "workspace-out-of-envelope" };
  }
  const requirement = gitOperationRequirement(request.operation);
  if (
    !deliveryScopeCheckDeferredToModeDecision(active, requirement) &&
    !hasRequiredScopes(active, requirement)
  )
    return { allowed: false, reason: "permission-scope-missing" };
  if (!withinBranchEnvelope(request, active))
    return { allowed: false, reason: "branch-out-of-envelope" };
  return resolveModeDecision(active, request, requirement, redeemApproval);
}

/**
 * #3399: the description authority's second admitted effect — model egress of snapshot content
 * through the Model Gateway for description generation. Not a Git operation (no argv, adapter, or
 * branch target), so it is a sibling check rather than a `GitDeliveryAuthorityRequest.operation`
 * value. Returns the admitted effective mode (never workspace-write or command capable) or
 * `undefined` when no live record matches the exact scope.
 */
export function authorizeGitDeliveryModelEgress(
  port: GitDeliveryDescriptionAuthorityPort,
  scope: GitDeliveryDescriptionAuthorityScope,
  nowIso: string,
): CodingWorkbenchMode | undefined {
  return port.current(scope, nowIso)?.effectiveMode;
}
