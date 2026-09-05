import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchPolicyResourceScope,
  GitRepositoryAgentOperationKind,
} from "@oscharko-dev/keiko-contracts";
// Runtime values live behind the explicit runtime/<domain> subpath (see keiko-contracts/src/index.ts's
// own header comment) — the bare package specifier is a type-only surface.
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
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
// whose own execute path already carries mandatory, mode-independent approval enforcement (merge
// today, the commit route as of this change) — re-deriving it here would double-gate those
// operations against a store this function cannot see into. A lower mode's approval-required
// delivery effect DOES need to clear here, because — unlike merge/commit — push/pull-request/fetch
// carry no such execute-path enforcement yet (ADR-0138 D4; #3387 owns their mint routes).
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
  if (redeemApproval?.(active, request) === true) {
    return { allowed: true, runId: active.runId, envelopeDigest: active.envelopeDigest };
  }
  return { allowed: false, reason: decision.reason };
}

/**
 * Single server-owned admission decision for every state-changing Git delivery operation. It is
 * deliberately pure over a server-private active-run port, so a browser checkbox, CSRF header, or
 * static deployment ceiling can never stand in for the accepted run's Authority Envelope.
 *
 * `redeemApproval`, when supplied, is consulted only when the mode/resource-scope/risk matrix
 * resolves "approval-required" for a lower mode: it lets the caller admit the operation over a
 * one-use claim bound to this exact accepted run instead of failing closed outright.
 */
export function authorizeGitDelivery(
  authorityPort: GitDeliveryRunAuthorityPort | undefined,
  request: GitDeliveryAuthorityRequest,
  nowIso: string,
  redeemApproval?: GitDeliveryApprovalRedemption,
): GitDeliveryAuthorityDecision {
  const active = authorityPort?.current(nowIso);
  if (active === undefined) return { allowed: false, reason: "accepted-run-unavailable" };
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
