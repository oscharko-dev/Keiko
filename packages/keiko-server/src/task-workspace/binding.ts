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
  type WorkspaceBinding,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";

export function buildBinding(instance: WorkspaceInstance): WorkspaceBinding {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    activeRoot: instance.managedWorktreePath,
    boundSurfaces: TASK_WORKSPACE_SURFACES,
    gitDeliveryRoot: instance.managedWorktreePath,
    editorProjectRoot: instance.managedWorktreePath,
  };
}
