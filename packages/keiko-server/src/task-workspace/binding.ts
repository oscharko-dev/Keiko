// Derive the authoritative active-workspace binding from a persisted instance (Issue #446, Epic #443).
//
// The #444 contract makes the WorkspaceBinding the single source of truth surfaces consume, with the
// invariant gitDeliveryRoot === activeRoot === editorProjectRoot enforced by validateWorkspaceBinding.
// #445 first computed this binding privately inside provisioning; #446 promotes it to a shared helper
// so BOTH the provisioning/activation path AND the #446 lifecycle/active-pointer path derive the same
// binding from a stored instance — there is exactly one derivation, never a recomputed second one.
//
// The active root is the managed worktree path: every bound surface (editor/runtime/git-delivery/
// terminal/files/...) operates on the task's isolated worktree, never the bare repository root.

import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  TASK_WORKSPACE_SURFACES,
  WORKSPACE_BINDING_V2_SCHEMA_VERSION,
  type WorkspaceBinding,
  type WorkspaceBindingV2,
  type WorkspaceInstance,
  type WorkspaceManifest,
} from "@oscharko-dev/keiko-contracts";

export function buildBinding(instance: WorkspaceInstance): WorkspaceBinding;
export function buildBinding(manifest: WorkspaceManifest, taskId: string): WorkspaceBindingV2;
export function buildBinding(
  source: WorkspaceInstance | WorkspaceManifest,
  taskId?: string,
): WorkspaceBinding | WorkspaceBindingV2 {
  if ("managedWorktreePath" in source) {
    return {
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      workspaceId: source.workspaceId,
      taskId: source.taskId,
      activeRoot: source.managedWorktreePath,
      boundSurfaces: TASK_WORKSPACE_SURFACES,
      gitDeliveryRoot: source.managedWorktreePath,
      editorProjectRoot: source.managedWorktreePath,
    };
  }
  if (taskId === undefined || taskId.length === 0) throw new Error("WORKSPACE_TASK_ID_REQUIRED");
  return {
    schemaVersion: WORKSPACE_BINDING_V2_SCHEMA_VERSION,
    workspaceId: source.workspaceId,
    taskId,
    manifestRef: source.manifestRef,
    manifestRevision: source.revision,
    manifestDigest: source.manifestDigest,
    roots: source.roots.map((root) => ({
      rootRef: root.rootRef,
      rootIdentityDigest: root.identityDigest,
      rootPath: root.canonicalRoot,
      boundSurfaces: TASK_WORKSPACE_SURFACES,
      gitDeliveryRoot: root.canonicalRoot,
      editorProjectRoot: root.canonicalRoot,
    })),
    focusedRootRef: source.focusedRootRef,
  };
}
