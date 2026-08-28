import type {
  CodingWorkbenchAuthorityEnvelope,
  GitRepositoryAgentOperationKind,
} from "@oscharko-dev/keiko-contracts";
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

function modeAllows(
  active: ActiveGitDeliveryRunAuthority,
  requirement: GitOperationRequirement,
): boolean {
  if (active.authority.effectiveMode === "governed-assist") return false;
  return !requirement.needsNetwork || active.authority.effectiveMode === "autonomous-delivery";
}

/**
 * Single server-owned admission decision for every state-changing Git delivery operation. It is
 * deliberately pure over a server-private active-run port, so a browser checkbox, CSRF header, or
 * static deployment ceiling can never stand in for the accepted run's Authority Envelope.
 */
export function authorizeGitDelivery(
  authorityPort: GitDeliveryRunAuthorityPort | undefined,
  request: GitDeliveryAuthorityRequest,
  nowIso: string,
): GitDeliveryAuthorityDecision {
  const active = authorityPort?.current(nowIso);
  if (active === undefined) return { allowed: false, reason: "accepted-run-unavailable" };
  if (expired(nowIso, active.authority.expiresAt))
    return { allowed: false, reason: "authority-expired" };
  if (active.projectId !== request.projectId || active.workspaceRoot !== request.workspaceRoot) {
    return { allowed: false, reason: "workspace-out-of-envelope" };
  }
  const requirement = gitOperationRequirement(request.operation);
  if (!modeAllows(active, requirement)) return { allowed: false, reason: "mode-denied" };
  if (!hasRequiredScopes(active, requirement))
    return { allowed: false, reason: "permission-scope-missing" };
  if (!withinBranchEnvelope(request, active))
    return { allowed: false, reason: "branch-out-of-envelope" };
  return { allowed: true, runId: active.runId, envelopeDigest: active.envelopeDigest };
}
