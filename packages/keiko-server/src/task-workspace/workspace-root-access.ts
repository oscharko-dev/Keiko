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
import { createServerLogger, errorKindOf, type ServerLogSink } from "../observability/index.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import {
  resolveManagedTaskWorkspaceInstanceFromLookup,
  type ManagedTaskWorkspaceLookup,
} from "./authorization.js";
import { isManagedRootOwned } from "./managed-root.js";
import { deriveManagedWorktreePath } from "./naming.js";
import { inspectManagedGitdirIdentity } from "./gitdir-identity.js";

export interface WorkspaceRootAccess {
  readonly kind: "ordinary" | "managed-task";
  readonly canonicalRoot: string;
  readonly fs: WorkspaceFs;
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

function managedIdentityMatches(
  instance: WorkspaceInstance,
  canonicalManagedRoot: string,
  canonicalRoot: string,
): boolean {
  const expectedCanonicalRoot = deriveManagedWorktreePath({
    managedRoot: canonicalManagedRoot,
    repositoryId: instance.repositoryId,
    workspaceId: instance.workspaceId,
  });
  const stat = nodeWorkspaceFs.stat(canonicalRoot);
  // Proves gitdir identity against the CANONICAL root just verified above, never the persisted
  // lexical instance.managedWorktreePath: the capability this returns must be bound to the identity
  // actually re-checked this call, not re-derived from a potentially-stale persisted string (#3347
  // cursor finding).
  const gitdir = inspectManagedGitdirIdentity(canonicalRoot, instance.repositoryRoot);
  return (
    canonicalRoot === expectedCanonicalRoot &&
    stat.isDirectory &&
    !stat.isSymbolicLink &&
    gitdir?.identity === instance.gitdirIdentity
  );
}

function canonicalManagedRootAccess(
  lookup: ManagedTaskWorkspaceLookup,
  requestedRoot: string,
  purpose: ManagedAccessPurpose,
): WorkspaceRootAccess | undefined {
  const managedRoot = lookup.managedRoot;
  if (managedRoot === undefined || !isManagedRootOwned(managedRoot)) return undefined;
  const instance = resolveManagedTaskWorkspaceInstanceFromLookup(lookup, requestedRoot);
  if (instance === undefined || !lifecyclePermits(instance, purpose)) return undefined;
  const canonicalManagedRoot = nodeWorkspaceFs.realPath(managedRoot);
  const canonicalRoot = nodeWorkspaceFs.realPath(instance.managedWorktreePath);
  if (!managedIdentityMatches(instance, canonicalManagedRoot, canonicalRoot)) return undefined;
  return {
    kind: "managed-task",
    canonicalRoot,
    fs: workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, canonicalRoot),
  };
}

// Mirrors workspace-root-denial-log.ts's recordWorkspaceRootDenial op/category/redaction shape,
// generalized to any caught failure rather than a typed PathDeniedError: everything this catch can
// see (a vanished worktree, a stat race against cleanup, a malformed pointer that bubbled past
// inspectManagedGitdirIdentity's own fail-closed wrapper) is a managed-root re-proof that failed —
// exactly as security-relevant as a denied path, and it must never disappear into a bare
// `undefined` with no activity-log evidence (#3347 cursor finding: "the empty catch/diagnostic
// path").
function recordManagedRootResolutionFailure(
  error: unknown,
  logging: WorkspaceRootAccessDenialLogging | undefined,
): void {
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  createServerLogger({
    sink: logging?.activityLog ?? processServerLogSink(),
    level: "debug",
  }).warn({
    category: "security",
    op: "workspace.root.denied",
    correlationId: correlationIdOrUnknown(logging?.correlationId),
    errorKind: errorKindOf(error),
    extra: {
      decision: "denied",
      reason: "managed-root-resolution-failed",
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
    );
  } catch (error) {
    recordManagedRootResolutionFailure(error, logging);
    return undefined;
  }
}

export function resolveLifecycleManagedWorkspaceRootAccess(
  deps: LifecycleManagedAccessDeps,
  requestedRoot: string,
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
    );
  } catch {
    return undefined;
  }
}

function workspaceInfo(root: string): WorkspaceInfo {
  return {
    root,
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

export function resolveRegisteredOrManagedWorkspaceRoot(
  deps: RegisteredOrManagedRootDeps,
  root: string,
  logging?: WorkspaceRootAccessDenialLogging,
): WorkspaceInfo | undefined {
  for (const project of deps.store.listProjects()) {
    if (project.path === root) return workspaceInfo(project.path);
  }
  return resolveManagedTaskWorkspaceRoot(deps, root, logging);
}
