import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";
import { containsPath } from "@oscharko-dev/keiko-git";
import { pathIsDeniedAsync } from "./files-deny.js";
import { isProjectAvailable, type Project, type UiStore } from "./store/index.js";
import { parseWorkspaceManifestRecord } from "./workspace-manifests.js";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";

export type WorkspaceRootMembershipFailure =
  | "ROOT_UNRESOLVED"
  | "IDENTITY_UNREADABLE"
  | "FILESYSTEM_IDENTITY_UNSUPPORTED"
  | "IDENTITY_DRIFT"
  | "NOT_A_MEMBER";

export class WorkspaceRootMembershipError extends Error {
  public constructor(public readonly failure: WorkspaceRootMembershipFailure) {
    super("Workspace root membership is unavailable.");
    this.name = "WorkspaceRootMembershipError";
  }
}

export interface CurrentWorkspaceRootMembership {
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly objectIdentityDigest: string;
  readonly realRoot: string;
}

interface IndexedWorkspaceRoot {
  readonly workspaceId: string;
  readonly root: WorkspaceRootDescriptor;
  readonly objectIdentityDigest: string | undefined;
}

type WorkspaceRootMembershipSnapshot = ReadonlyMap<string, IndexedWorkspaceRoot>;

function unavailable(failure: WorkspaceRootMembershipFailure): never {
  throw new WorkspaceRootMembershipError(failure);
}

function canonicalRoot(rootInput: string): string {
  try {
    return realpathSync(rootInput);
  } catch {
    return unavailable("ROOT_UNRESOLVED");
  }
}

function membershipSnapshot(store: UiStore): WorkspaceRootMembershipSnapshot {
  const roots = new Map<string, IndexedWorkspaceRoot>();
  for (const record of store.listWorkspaceManifestRecords()) {
    const manifest: WorkspaceManifest = parseWorkspaceManifestRecord(record);
    for (const root of manifest.roots) {
      const value = record.rootProjects.find(
        (candidate): boolean => candidate.rootRef === root.rootRef,
      )?.objectIdentityDigest;
      roots.set(root.canonicalRoot, {
        workspaceId: manifest.workspaceId,
        root,
        objectIdentityDigest: typeof value === "string" ? value : undefined,
      });
    }
  }
  return roots;
}

type DurableWorkspaceRootIdentity = ReturnType<typeof inspectWorkspaceRootIdentity> & {
  readonly objectIdentityDigest: string;
};

function rootIdentityMatches(
  inspected: ReturnType<typeof inspectWorkspaceRootIdentity>,
  root: WorkspaceRootDescriptor,
  storedObjectIdentityDigest: string | undefined,
): inspected is DurableWorkspaceRootIdentity {
  return (
    inspected.rootRef === root.rootRef &&
    inspected.identityDigest === root.identityDigest &&
    inspected.objectIdentityDigest !== undefined &&
    inspected.objectIdentityDigest === storedObjectIdentityDigest
  );
}

function resolveCanonicalWorkspaceRootMembership(
  realRoot: string,
  snapshot: WorkspaceRootMembershipSnapshot,
): CurrentWorkspaceRootMembership {
  const indexed = snapshot.get(realRoot);
  if (indexed === undefined) return unavailable("NOT_A_MEMBER");
  let inspected: ReturnType<typeof inspectWorkspaceRootIdentity>;
  try {
    inspected = inspectWorkspaceRootIdentity(realRoot);
  } catch {
    return unavailable("IDENTITY_UNREADABLE");
  }
  if (inspected.objectIdentityUnsupported) {
    return unavailable("FILESYSTEM_IDENTITY_UNSUPPORTED");
  }
  if (!rootIdentityMatches(inspected, indexed.root, indexed.objectIdentityDigest)) {
    return unavailable("IDENTITY_DRIFT");
  }
  return {
    workspaceId: indexed.workspaceId,
    rootRef: indexed.root.rootRef,
    rootIdentityDigest: indexed.root.identityDigest,
    objectIdentityDigest: inspected.objectIdentityDigest,
    realRoot,
  };
}

function hasMembershipInSnapshot(
  rootInput: string,
  snapshot: WorkspaceRootMembershipSnapshot,
): boolean {
  try {
    resolveCanonicalWorkspaceRootMembership(canonicalRoot(rootInput), snapshot);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single membership and identity decision for user-connected workspace roots. Files may still
 * browse an arbitrary folder, but governed workspace capabilities and recovery protection consume
 * this closed decision so a project row alone can never masquerade as current membership.
 */
export function resolveCurrentWorkspaceRootMembership(
  store: UiStore,
  rootInput: string,
): CurrentWorkspaceRootMembership {
  const realRoot = canonicalRoot(rootInput);
  let snapshot: WorkspaceRootMembershipSnapshot;
  try {
    snapshot = membershipSnapshot(store);
  } catch {
    return unavailable("ROOT_UNRESOLVED");
  }
  return resolveCanonicalWorkspaceRootMembership(realRoot, snapshot);
}

export function hasCurrentWorkspaceRootMembership(store: UiStore, rootInput: string): boolean {
  try {
    resolveCurrentWorkspaceRootMembership(store, rootInput);
    return true;
  } catch {
    return false;
  }
}

/** Whether the Files and Git routes would read this folder; the project is listed either way. */
export async function projectReadable(project: Project): Promise<boolean> {
  return !(await pathIsDeniedAsync(project.path));
}

export async function projectWithWorkspaceAvailability(
  store: UiStore,
  project: Project,
): Promise<ProjectWithAvailability> {
  return {
    ...project,
    available: isProjectAvailable(project),
    readable: await projectReadable(project),
    workspaceAvailable: hasCurrentWorkspaceRootMembership(store, project.path),
  };
}

export async function projectsWithWorkspaceAvailability(
  store: UiStore,
  projects: readonly Project[],
): Promise<readonly ProjectWithAvailability[]> {
  // A folder whose readability cannot be settled is listed unreadable, never readable.
  const readable = await Promise.all(projects.map((project) => projectReadable(project)));
  let snapshot: WorkspaceRootMembershipSnapshot;
  try {
    snapshot = membershipSnapshot(store);
  } catch {
    return projects.map((project, index): ProjectWithAvailability => ({
      ...project,
      available: isProjectAvailable(project),
      readable: readable[index] ?? false,
      workspaceAvailable: false,
    }));
  }
  return projects.map((project, index): ProjectWithAvailability => {
    const workspaceAvailable = hasMembershipInSnapshot(project.path, snapshot);
    return {
      ...project,
      available: isProjectAvailable(project),
      readable: readable[index] ?? false,
      workspaceAvailable,
    };
  });
}

/**
 * Internal managed worktrees need durable project records for exact-root trust and verification,
 * but they are not human-selected project-catalog entries.
 */
export function userFacingProjects(
  projects: readonly Project[],
  managedTaskWorkspaceRoot: string | undefined,
): readonly Project[] {
  if (managedTaskWorkspaceRoot === undefined) return projects;
  const managedRoot = resolve(managedTaskWorkspaceRoot);
  return projects.filter((project) => !containsPath(managedRoot, resolve(project.path)));
}
