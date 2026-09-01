// Authorization helpers for task-bound execution roots (Epic #443).
//
// Legacy BFF routes authorize `projectId` / `workspaceRoot` against the UI project store. A bound task
// workspace intentionally points those surfaces at a managed worktree instead, so the route boundary
// must accept that root only when it can be re-proven from the persisted WorkspaceInstance and the
// Keiko-owned managed root. This does not grant arbitrary filesystem authority: the leaf id, persisted
// path, derived managed path, realpath containment, and on-disk presence must all agree.

import { basename } from "node:path";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { UiHandlerDeps } from "../deps.js";
import { isManagedTargetContained, managedTargetExists } from "./managed-root.js";
import { deriveManagedWorktreePath } from "./naming.js";

type ManagedRootDeps = Pick<
  UiHandlerDeps,
  "managedTaskWorkspaceRoot" | "store" | "workspaceProvisioning"
>;

export interface ManagedTaskWorkspaceLookup {
  readonly managedRoot: string | undefined;
  readonly getInstance: (workspaceId: string) => WorkspaceInstance | undefined;
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

// Trims trailing path separators without a regex: `/[/\\]+$/` pairs an unbounded quantifier with
// an unanchored search, a shape SonarCloud (S8786) flags on sight even though this particular class
// has no ambiguity of its own. A plain backward scan can't backtrack at all.
function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end--;
  return path.slice(0, end);
}

function pathLeaf(path: string): string {
  return basename(trimTrailingSeparators(path));
}

export function resolveManagedTaskWorkspaceInstanceFromLookup(
  lookup: ManagedTaskWorkspaceLookup,
  root: string,
): WorkspaceInstance | undefined {
  const managedRoot = lookup.managedRoot;
  if (managedRoot === undefined || root.length === 0) return undefined;
  const instance = lookup.getInstance(pathLeaf(root));
  if (instance === undefined) return undefined;
  const expected = deriveManagedWorktreePath({
    managedRoot,
    repositoryId: instance.repositoryId,
    workspaceId: instance.workspaceId,
  });
  if (root !== expected || instance.managedWorktreePath !== expected) return undefined;
  if (!isManagedTargetContained(managedRoot, instance.managedWorktreePath)) return undefined;
  if (!managedTargetExists(instance.managedWorktreePath)) return undefined;
  return instance;
}

export function resolveManagedTaskWorkspaceInstance(
  deps: Pick<ManagedRootDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">,
  root: string,
): WorkspaceInstance | undefined {
  const provisioning = deps.workspaceProvisioning;
  if (provisioning === undefined) return undefined;
  return resolveManagedTaskWorkspaceInstanceFromLookup(
    {
      managedRoot: deps.managedTaskWorkspaceRoot,
      getInstance: (workspaceId): WorkspaceInstance | undefined =>
        provisioning.getInstance(workspaceId),
    },
    root,
  );
}

export function resolveManagedTaskWorkspaceRoot(
  deps: Pick<ManagedRootDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">,
  root: string,
): WorkspaceInfo | undefined {
  const instance = resolveManagedTaskWorkspaceInstance(deps, root);
  return instance === undefined ? undefined : workspaceInfo(instance.managedWorktreePath);
}

export function resolveRegisteredOrManagedWorkspaceRoot(
  deps: ManagedRootDeps,
  root: string,
): WorkspaceInfo | undefined {
  for (const project of deps.store.listProjects()) {
    if (project.path === root) return workspaceInfo(project.path);
  }
  return resolveManagedTaskWorkspaceRoot(deps, root);
}
