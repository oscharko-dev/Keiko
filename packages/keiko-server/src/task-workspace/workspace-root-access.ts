import { isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceFsWithOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";
import { containsPath } from "@oscharko-dev/keiko-git";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { pathIsDenied } from "../files-deny.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  createServerLogger,
  errorKindOf,
  type ServerLogger,
  type ServerLogSink,
} from "../observability/index.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import {
  resolveManagedTaskWorkspaceInstanceFromLookup,
  type ManagedTaskWorkspaceLookup,
} from "./authorization.js";
import { isManagedRootOwned } from "./managed-root.js";
import { deriveManagedWorktreePath } from "./naming.js";
import {
  inspectManagedGitdirIdentityOutcome,
  managedIdentityDriftFor,
  type ManagedIdentityDrift,
} from "./gitdir-identity.js";

/**
 * A proven capability over ONE workspace root.
 *
 * A DISCRIMINATED UNION, not a flat record with an optional field: only a managed task worktree has a
 * repository behind it, and it ALWAYS has one — `canonicalManagedRootAccess` reads `repositoryRoot`
 * off the persisted instance it just re-proved, so a granted managed access without a repository is
 * unconstructable in production. While the field was optional on both branches, every consumer that
 * needs the repository (script trust, the verification runner, the command runner) carried a
 * "managed access with no repository" branch that could never run, and each of those branches had to
 * invent its own fail-closed answer to a configuration that does not exist (PR #3381 review). The
 * union deletes the question: an ordinary root cannot name a repository, a managed one cannot omit
 * it, and the compiler enforces both.
 */
export type WorkspaceRootAccess =
  | {
      readonly kind: "ordinary";
      readonly canonicalRoot: string;
      readonly fs: WorkspaceFs;
    }
  | {
      readonly kind: "managed-task";
      readonly canonicalRoot: string;
      readonly fs: WorkspaceFs;
      // The repository this managed task worktree was bound from. A worktree is not a registered
      // project of its own: standing decisions about its repository — workspace script trust — apply
      // to it.
      readonly repositoryRoot: string;
    };

/**
 * The typed outcome of resolving one requested workspace root. A resolution failure is not one
 * thing: a DENIED root is a policy refusal the HTTP surfaces above must answer 403, while a MISSING
 * or unreadable root is an ordinary not-found they must answer 404. Collapsing both into a bare
 * `undefined` made the terminal surface report every failure as CWD_DENIED and left its
 * PROJECT_NOT_FOUND branch unreachable in production (#3347) — the distinction now leaves the
 * resolver in the return type instead of only reaching its activity-log line.
 */
export type WorkspaceRootAccessOutcome =
  | { readonly decision: "granted"; readonly access: WorkspaceRootAccess }
  | { readonly decision: "denied" }
  | { readonly decision: "unresolved" };

export function grantedWorkspaceRootAccess(
  access: WorkspaceRootAccess,
): WorkspaceRootAccessOutcome {
  return { decision: "granted", access };
}

/**
 * Collapses an outcome for the callers that genuinely answer "denied" and "unresolved" the same
 * way. Every such collapse is an explicit, reviewable decision AT the consumer that owns the
 * mapping — never a resolver that throws the distinction away before its caller can map it.
 */
export function workspaceRootAccessOrUndefined(
  outcome: WorkspaceRootAccessOutcome | undefined,
): WorkspaceRootAccess | undefined {
  return outcome?.decision === "granted" ? outcome.access : undefined;
}

// Optional logging seam for a managed-root resolution failure. Every production caller reaches this
// resolver through UiHandlerDeps composition, so the seam mirrors the same activityLog/correlationId
// shape workspace-root-denial-log.ts's recordWorkspaceRootDenial already uses for the ordinary-root
// path — one denial-logging vocabulary, not two.
export interface WorkspaceRootAccessDenialLogging {
  readonly activityLog?: ServerLogSink | undefined;
  readonly correlationId?: string | undefined;
}

type ManagedAccessDeps = Pick<UiHandlerDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">;
type ConfiguredManagedRootDeps = Pick<UiHandlerDeps, "managedTaskWorkspaceRoot">;
type RegisteredOrManagedRootDeps = ManagedAccessDeps & Pick<UiHandlerDeps, "store">;
interface LifecycleManagedAccessDeps {
  readonly managedRoot: string;
  readonly store: { readonly getById: (workspaceId: string) => WorkspaceInstance | undefined };
}
type ManagedAccessPurpose = "interactive" | "lifecycle-maintenance";

function rootRelativePath(root: string, candidate: string): string {
  const path = relative(root, candidate);
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

export function requiresManagedRootAuthority(managedRoot: string, candidateRoot: string): boolean {
  if (containsPath(managedRoot, candidateRoot)) return true;
  if (!containsPath(candidateRoot, managedRoot)) return false;
  return !pathIsDenied(rootRelativePath(candidateRoot, managedRoot));
}

function canonicalPath(path: string): string | undefined {
  try {
    return nodeWorkspaceFs.realPath(path);
  } catch {
    return undefined;
  }
}

/** Classifies lexical roots and canonical aliases without granting filesystem authority. */
export function requiresConfiguredManagedWorkspaceAuthority(
  deps: ConfiguredManagedRootDeps,
  candidateRoot: string,
): boolean {
  const configuredRoot = deps.managedTaskWorkspaceRoot;
  if (configuredRoot === undefined || !isAbsolute(candidateRoot)) return false;
  const managedRoot = resolve(configuredRoot);
  const candidate = resolve(candidateRoot);
  if (requiresManagedRootAuthority(managedRoot, candidate)) return true;
  const canonicalManagedRoot = canonicalPath(managedRoot);
  if (canonicalManagedRoot === undefined) return false;
  const canonicalCandidate = canonicalPath(candidate);
  return (
    canonicalCandidate !== undefined &&
    requiresManagedRootAuthority(canonicalManagedRoot, canonicalCandidate)
  );
}

export function createOrdinaryWorkspaceRootAccess(canonicalRoot: string): WorkspaceRootAccess {
  return { kind: "ordinary", canonicalRoot, fs: nodeWorkspaceFs };
}

function lifecyclePermits(instance: WorkspaceInstance, purpose: ManagedAccessPurpose): boolean {
  return (
    purpose === "lifecycle-maintenance" ||
    instance.lifecycleState === "active" ||
    instance.lifecycleState === "handoff-ready"
  );
}

// Every identity denial refuses. This only decides WHICH denial an operator is told about, so a
// workspace that merely predates the current identity rule is not reported as a possible
// replacement — the two need different operator actions and are different incidents.
// ONE full proof, returning what failed. A second, independent inspection run only to explain a
// refusal could observe a different filesystem state than the one that was refused, and it could
// not tell a path or directory-kind failure from an identity failure at all — both were reported as
// identity findings (review). `matched` is the grant; every other value is the exact reason.
type ManagedIdentityVerdict =
  | { readonly kind: "matched" }
  | { readonly kind: "path" }
  | { readonly kind: "not-a-directory" }
  | { readonly kind: "identity"; readonly drift: ManagedIdentityDrift }
  | { readonly kind: "failed"; readonly cause: unknown };

function proveManagedIdentity(
  instance: WorkspaceInstance,
  canonicalManagedRoot: string,
  canonicalRoot: string,
): ManagedIdentityVerdict {
  const expectedCanonicalRoot = deriveManagedWorktreePath({
    managedRoot: canonicalManagedRoot,
    repositoryId: instance.repositoryId,
    workspaceId: instance.workspaceId,
  });
  if (canonicalRoot !== expectedCanonicalRoot) return { kind: "path" };
  const stat = nodeWorkspaceFs.stat(canonicalRoot);
  if (!stat.isDirectory || stat.isSymbolicLink) return { kind: "not-a-directory" };
  // Proves gitdir identity against the CANONICAL root just verified above, never the persisted
  // lexical instance.managedWorktreePath: the capability this returns must be bound to the identity
  // actually re-checked this call, not re-derived from a potentially-stale persisted string (#3347
  // cursor finding).
  const outcome = inspectManagedGitdirIdentityOutcome(canonicalRoot, instance.repositoryRoot);
  if (outcome.kind === "failed") return { kind: "failed", cause: outcome.cause };
  const drift = managedIdentityDriftFor(outcome, instance.gitdirIdentity);
  return drift === "matches" ? { kind: "matched" } : { kind: "identity", drift };
}

function denialReasonFor(
  verdict: Exclude<ManagedIdentityVerdict, { kind: "matched" }>,
): ManagedRootDenialReason {
  if (verdict.kind === "identity" && verdict.drift === "schema-retired") {
    return "managed-root-identity-schema-retired";
  }
  if (verdict.kind === "identity" && verdict.drift === "unsupported") {
    return "managed-root-identity-unsupported";
  }
  return "managed-root-identity";
}

// ONE denial-logging vocabulary for the managed-root boundary — same `op`, same category, same
// redaction as workspace-root-denial-log.ts's recordWorkspaceRootDenial, distinguished only by the
// `reason` discriminator. Two shapes share it: a classified POLICY denial (this root was refused by
// a guard) and a caught RESOLUTION FAILURE (the re-proof itself threw). Neither may collapse into a
// bare `undefined`, because a route that answers 403 must leave something correlated behind that
// says why (#3347 owner P2 + cursor).
type ManagedRootDenialReason =
  // The configured managed root is absent or no longer carries Keiko's ownership marker.
  | "managed-root-ownership"
  // The requested root is under managed authority but is not a persisted managed workspace.
  | "managed-root-not-registered"
  // The instance exists but its lifecycle state does not permit binding for this purpose.
  | "managed-root-lifecycle"
  // Canonical path, directory kind, or re-verified gitdir identity disagrees with the instance.
  | "managed-root-identity"
  // The instance's identity was persisted under the retired v2 composition, which bound only the
  // inode and so could not tell an authentic worktree from a same-path replacement that won the
  // inode back. Distinct from `managed-root-identity` because nothing is wrong with the worktree:
  // it needs an operator-approved re-registration, not an incident response. The old value is
  // never accepted, since accepting a forgeable identity once would mint a trusted v3 one from it.
  | "managed-root-identity-schema-retired"
  // This filesystem reports no creation time, so no identity can be derived at all — an ext4 volume
  // formatted with 128-byte inodes is a real example. The outcome ADR-0155 names
  // FILESYSTEM_IDENTITY_UNSUPPORTED at the workspace-root boundary; a separate reason here so an
  // operator sees a platform limitation instead of a replaced worktree.
  | "managed-root-identity-unsupported"
  // The interactive re-proof threw (vanished worktree, stat race, exotic IO fault).
  | "managed-root-resolution-failed"
  // The same throw on the lifecycle-maintenance twin. A distinct reason on purpose: a background
  // sweep that cannot re-prove a worktree fails a health/cleanup decision, not a user request, and
  // an operator must be able to tell those two blast radii apart in one grep of the activity log.
  | "managed-root-lifecycle-resolution-failed";

interface ManagedRootDenialContext {
  readonly managedRoot: string | undefined;
  readonly requestedRoot: string;
  readonly logging: WorkspaceRootAccessDenialLogging | undefined;
}

function managedRootDenialLogger(
  logging: WorkspaceRootAccessDenialLogging | undefined,
): ServerLogger {
  return createServerLogger({
    sink: logging?.activityLog ?? processServerLogSink(),
    level: "debug",
  });
}

// Reports one classified denial for a guard that refused the root, so the caller's `return
// undefined` is never the only trace of the decision.
//
// The emit is GATED on the requested root actually being classified as requiring managed authority.
// deps.ts asks this resolver about EVERY requested root before falling back to ordinary admission,
// so an ungated emit would label each ordinary workspace resolution a managed-authority denial and
// bury the real ones. The gate reuses requiresConfiguredManagedWorkspaceAuthority — the same
// classifier the callers use — rather than a second path-shape rule.
function recordManagedRootDenial(
  reason: ManagedRootDenialReason,
  context: ManagedRootDenialContext,
): void {
  const requiresManagedAuthority = requiresConfiguredManagedWorkspaceAuthority(
    { managedTaskWorkspaceRoot: context.managedRoot },
    context.requestedRoot,
  );
  if (!requiresManagedAuthority) return;
  managedRootDenialLogger(context.logging).warn({
    category: "security",
    op: "workspace.root.denied",
    correlationId: correlationIdOrUnknown(context.logging?.correlationId),
    errorKind: "WORKSPACE_MANAGED_AUTHORITY_DENIED",
    extra: { decision: "denied", reason },
  });
}

// The thrown-failure catches below choose the same reason per purpose; the in-proof `failed`
// outcome must land on the identical activity-log vocabulary so one purpose has one failure op.
function resolutionFailureReasonFor(purpose: ManagedAccessPurpose): ManagedRootDenialReason {
  return purpose === "lifecycle-maintenance"
    ? "managed-root-lifecycle-resolution-failed"
    : "managed-root-resolution-failed";
}

function canonicalManagedRootAccess(
  lookup: ManagedTaskWorkspaceLookup,
  requestedRoot: string,
  purpose: ManagedAccessPurpose,
  logging?: WorkspaceRootAccessDenialLogging,
): WorkspaceRootAccess | undefined {
  const managedRoot = lookup.managedRoot;
  const denial: ManagedRootDenialContext = { managedRoot, requestedRoot, logging };
  if (managedRoot === undefined || !isManagedRootOwned(managedRoot)) {
    recordManagedRootDenial("managed-root-ownership", denial);
    return undefined;
  }
  const instance = resolveManagedTaskWorkspaceInstanceFromLookup(lookup, requestedRoot);
  if (instance === undefined) {
    recordManagedRootDenial("managed-root-not-registered", denial);
    return undefined;
  }
  if (!lifecyclePermits(instance, purpose)) {
    recordManagedRootDenial("managed-root-lifecycle", denial);
    return undefined;
  }
  const canonicalManagedRoot = nodeWorkspaceFs.realPath(managedRoot);
  const canonicalRoot = nodeWorkspaceFs.realPath(instance.managedWorktreePath);
  const verdict = proveManagedIdentity(instance, canonicalManagedRoot, canonicalRoot);
  if (verdict.kind === "failed") {
    // An I/O failure inside the proof is a resolution failure, with its cause and frames, not an
    // identity finding dressed up as one.
    recordManagedRootResolutionFailure(
      verdict.cause,
      denial.logging,
      resolutionFailureReasonFor(purpose),
    );
    return undefined;
  }
  if (verdict.kind !== "matched") {
    recordManagedRootDenial(denialReasonFor(verdict), denial);
    return undefined;
  }
  return {
    kind: "managed-task",
    canonicalRoot,
    fs: workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, canonicalRoot),
    repositoryRoot: instance.repositoryRoot,
  };
}

// The caught-failure half of the same vocabulary, generalized to any thrown value rather than a
// typed PathDeniedError: everything these catches can see (a vanished worktree, a stat race against
// cleanup, a malformed pointer that bubbled past inspectManagedGitdirIdentity's own fail-closed
// wrapper) is a managed-root re-proof that failed — exactly as security-relevant as a denied path,
// and it must never disappear into a bare `undefined` with no activity-log evidence (#3347 cursor
// finding: "the empty catch/diagnostic path"). Unlike a policy denial this is NOT gated on
// classification: a throw means the classification itself could not be completed, so suppressing it
// would discard the one record that the re-proof was attempted at all.
function recordManagedRootResolutionFailure(
  error: unknown,
  logging: WorkspaceRootAccessDenialLogging | undefined,
  reason: ManagedRootDenialReason,
): void {
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  managedRootDenialLogger(logging).warn({
    category: "security",
    op: "workspace.root.denied",
    correlationId: correlationIdOrUnknown(logging?.correlationId),
    errorKind: errorKindOf(error),
    extra: {
      decision: "denied",
      reason,
      ...(frames.length === 0 ? {} : { frames }),
      ...(causes.length === 0 ? {} : { causeChain: causes }),
    },
  });
}

/**
 * Re-proves one persisted managed workspace and returns authority scoped to this operation only.
 * Every call re-reads lifecycle ownership and canonical identity; no process-global grant survives
 * revocation and no path-shape rule can manufacture this capability. `logging` is optional so every
 * existing single/two-argument caller keeps compiling unchanged; when a resolution failure IS
 * caught, it is now always reported (to the supplied sink, or the shared process activity log by
 * default) instead of silently collapsing to `undefined`.
 */
export function resolveManagedWorkspaceRootAccess(
  deps: ManagedAccessDeps,
  requestedRoot: string,
  logging?: WorkspaceRootAccessDenialLogging,
): WorkspaceRootAccess | undefined {
  const provisioning = deps.workspaceProvisioning;
  if (provisioning === undefined) return undefined;
  try {
    return canonicalManagedRootAccess(
      {
        managedRoot: deps.managedTaskWorkspaceRoot,
        getInstance: (workspaceId): WorkspaceInstance | undefined =>
          provisioning.getInstance(workspaceId),
      },
      requestedRoot,
      "interactive",
      logging,
    );
  } catch (error) {
    recordManagedRootResolutionFailure(error, logging, "managed-root-resolution-failed");
    return undefined;
  }
}

/**
 * The lifecycle-maintenance twin: same prover, same denial vocabulary, `lifecycle-maintenance`
 * purpose so a sweep may still re-prove an archived workspace it is about to clean up. Its catch
 * reports through the SAME recorder as the interactive twin (#3347 cursor finding) — a background
 * sweep that cannot re-prove a worktree fails a health or cleanup decision closed, which is exactly
 * as reconstructable a fact as an interactive denial. The reason discriminator keeps the two lanes
 * apart; `logging` is optional so the existing two-argument health/cleanup callers keep compiling
 * and report under the shared process activity log until they thread a correlation id.
 */
export function resolveLifecycleManagedWorkspaceRootAccess(
  deps: LifecycleManagedAccessDeps,
  requestedRoot: string,
  logging?: WorkspaceRootAccessDenialLogging,
): WorkspaceRootAccess | undefined {
  try {
    return canonicalManagedRootAccess(
      {
        managedRoot: deps.managedRoot,
        getInstance: (workspaceId): WorkspaceInstance | undefined =>
          deps.store.getById(workspaceId),
      },
      requestedRoot,
      "lifecycle-maintenance",
      logging,
    );
  } catch (error) {
    recordManagedRootResolutionFailure(error, logging, "managed-root-lifecycle-resolution-failed");
    return undefined;
  }
}

function workspaceInfo(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

/**
 * Re-derives a WorkspaceInfo for a legacy BFF route boundary from the SAME strong proof interactive
 * admission uses (ownership marker, lifecycle state, and re-verified gitdir identity) — never from
 * path shape, containment, and existence alone. Epic #443 originally authorized this surface
 * straight off resolveManagedTaskWorkspaceInstanceFromLookup's weaker check; #3347 review found that
 * gate could still admit an archived or identity-replaced worktree whose directory happens to still
 * exist, so run-handlers.ts's apply path and gitDelivery/execution.ts could diverge from what
 * interactive admission denies. There is exactly one managed-root prover now
 * (resolveManagedWorkspaceRootAccess) — this is a thin WorkspaceInfo projection over it, not a
 * second, weaker gate.
 */
export function resolveManagedTaskWorkspaceRoot(
  deps: ManagedAccessDeps,
  root: string,
  logging?: WorkspaceRootAccessDenialLogging,
): WorkspaceInfo | undefined {
  const access = resolveManagedWorkspaceRootAccess(deps, root, logging);
  return access === undefined ? undefined : workspaceInfo(access.canonicalRoot);
}

/**
 * Registered-project OR managed-worktree admission for the legacy BFF route boundary.
 *
 * CLASSIFY FIRST, then admit (#3347 owner P1). Production registers a managed worktree in `UiStore`
 * like any other project — the Files/Composer surfaces add it so a user can open it — so a store
 * loop reached FIRST returns a `WorkspaceInfo` for a root the strong managed prover denies. That
 * store hit bypassed the ownership-marker, lifecycle and gitdir-identity proof entirely, and the
 * run/apply/git-delivery callers built on this helper could therefore keep acting on an archived or
 * identity-replaced managed root after managed authority was revoked. A managed-classified root now
 * has exactly ONE admission path — resolveManagedTaskWorkspaceRoot, which fails closed — and the
 * project store can never widen it. Ordinary roots keep the previous order and outcome.
 */
export function resolveRegisteredOrManagedWorkspaceRoot(
  deps: RegisteredOrManagedRootDeps,
  root: string,
  logging?: WorkspaceRootAccessDenialLogging,
): WorkspaceInfo | undefined {
  if (requiresConfiguredManagedWorkspaceAuthority(deps, root)) {
    return resolveManagedTaskWorkspaceRoot(deps, root, logging);
  }
  for (const project of deps.store.listProjects()) {
    if (project.path === root) return workspaceInfo(project.path);
  }
  return resolveManagedTaskWorkspaceRoot(deps, root, logging);
}
