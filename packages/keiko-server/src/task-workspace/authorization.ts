// Authorization helpers for task-bound execution roots (Epic #443).
//
// Legacy BFF routes authorize `projectId` / `workspaceRoot` against the UI project store. A bound task
// workspace intentionally points those surfaces at a managed worktree instead, so the route boundary
// must accept that root only when it can be re-proven from the persisted WorkspaceInstance and the
// Keiko-owned managed root. This does not grant arbitrary filesystem authority: the leaf id, persisted
// path, derived managed path, realpath containment, and on-disk presence must all agree.

import { basename } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { UiHandlerDeps } from "../deps.js";
import { isManagedTargetContained, managedTargetExists } from "./managed-root.js";
import { deriveManagedWorktreePath } from "./naming.js";

type ManagedRootDeps = Pick<
  UiHandlerDeps,
  "managedTaskWorkspaceRoot" | "store" | "workspaceProvisioning"
>;

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

function pathLeaf(path: string): string {
  return basename(path.replace(/[/\\]+$/u, ""));
}

export function resolveManagedTaskWorkspaceRoot(
  deps: Pick<ManagedRootDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">,
  root: string,
): WorkspaceInfo | undefined {
  const managedRoot = deps.managedTaskWorkspaceRoot;
  const provisioning = deps.workspaceProvisioning;
  if (managedRoot === undefined || provisioning === undefined || root.length === 0) {
    return undefined;
  }
  const instance = provisioning.getInstance(pathLeaf(root));
  if (instance === undefined) return undefined;
  const expected = deriveManagedWorktreePath({
    managedRoot,
    repositoryId: instance.repositoryId,
    workspaceId: instance.workspaceId,
  });
  if (root !== expected || instance.managedWorktreePath !== expected) return undefined;
  if (!isManagedTargetContained(managedRoot, instance.managedWorktreePath)) return undefined;
  if (!managedTargetExists(instance.managedWorktreePath)) return undefined;
  return workspaceInfo(instance.managedWorktreePath);
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
