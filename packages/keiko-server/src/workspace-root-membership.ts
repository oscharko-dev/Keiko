import { realpathSync } from "node:fs";
import type {
  WorkspaceRootDescriptor,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isProjectAvailable, type Project, type UiStore } from "./store/index.js";
import { WorkspaceManifestService } from "./workspace-manifests.js";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";

export type WorkspaceRootMembershipFailure =
  "ROOT_UNRESOLVED" | "IDENTITY_UNREADABLE" | "IDENTITY_DRIFT" | "NOT_A_MEMBER";

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

function unavailable(failure: WorkspaceRootMembershipFailure): never {
  throw new WorkspaceRootMembershipError(failure);
}

function storedObjectIdentity(store: UiStore, rootRef: WorkspaceRootRef): string | undefined {
  const value = store
    .findWorkspaceManifestRecordByRoot(rootRef)
    ?.rootProjects.find(
      (candidate): boolean => candidate.rootRef === rootRef,
    )?.objectIdentityDigest;
  return typeof value === "string" ? value : undefined;
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

/**
 * The single membership and identity decision for user-connected workspace roots. Files may still
 * browse an arbitrary folder, but governed workspace capabilities and recovery protection consume
 * this closed decision so a project row alone can never masquerade as current membership.
 */
export function resolveCurrentWorkspaceRootMembership(
  store: UiStore,
  rootInput: string,
): CurrentWorkspaceRootMembership {
  let realRoot: string;
  let manifests: ReturnType<WorkspaceManifestService["list"]>;
  try {
    realRoot = realpathSync(rootInput);
    manifests = new WorkspaceManifestService(store).list();
  } catch {
    return unavailable("ROOT_UNRESOLVED");
  }
  for (const manifest of manifests) {
    const root = manifest.roots.find((candidate): boolean => candidate.canonicalRoot === realRoot);
    if (root === undefined) continue;
    let inspected: ReturnType<typeof inspectWorkspaceRootIdentity>;
    try {
      inspected = inspectWorkspaceRootIdentity(realRoot);
    } catch {
      return unavailable("IDENTITY_UNREADABLE");
    }
    if (!rootIdentityMatches(inspected, root, storedObjectIdentity(store, root.rootRef))) {
      return unavailable("IDENTITY_DRIFT");
    }
    return {
      workspaceId: manifest.workspaceId,
      rootRef: root.rootRef,
      rootIdentityDigest: root.identityDigest,
      objectIdentityDigest: inspected.objectIdentityDigest,
      realRoot,
    };
  }
  return unavailable("NOT_A_MEMBER");
}

export function hasCurrentWorkspaceRootMembership(store: UiStore, rootInput: string): boolean {
  try {
    resolveCurrentWorkspaceRootMembership(store, rootInput);
    return true;
  } catch {
    return false;
  }
}

export function projectWithWorkspaceAvailability(
  store: UiStore,
  project: Project,
): ProjectWithAvailability {
  return {
    ...project,
    available: isProjectAvailable(project),
    workspaceAvailable: hasCurrentWorkspaceRootMembership(store, project.path),
  };
}
