import { isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceFsWithOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";
import { containsPath } from "@oscharko-dev/keiko-git";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { pathIsDenied } from "../files-deny.js";
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

type ManagedAccessDeps = Pick<UiHandlerDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">;
type ConfiguredManagedRootDeps = Pick<UiHandlerDeps, "managedTaskWorkspaceRoot">;
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
  const gitdir = inspectManagedGitdirIdentity(
    instance.managedWorktreePath,
    instance.repositoryRoot,
  );
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

/**
 * Re-proves one persisted managed workspace and returns authority scoped to this operation only.
 * Every call re-reads lifecycle ownership and canonical identity; no process-global grant survives
 * revocation and no path-shape rule can manufacture this capability.
 */
export function resolveManagedWorkspaceRootAccess(
  deps: ManagedAccessDeps,
  requestedRoot: string,
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
  } catch {
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
