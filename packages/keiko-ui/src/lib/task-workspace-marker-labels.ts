// One typed map from every persisted task-workspace drift marker to its operator-facing label,
// shared by the Task Workspace manager and the Coding Workbench setup card so both surfaces name
// the same finding with the same words. `Record<TaskWorkspaceDriftMarker, MessageKey>` turns a
// marker the contract adds later into a typecheck failure here instead of an unlabeled badge.

import type { TaskWorkspaceDriftMarker } from "@oscharko-dev/keiko-contracts";
import type { MessageKey } from "./i18n-messages.en";

export const TASK_WORKSPACE_MARKER_MESSAGE_KEYS: Readonly<
  Record<TaskWorkspaceDriftMarker, MessageKey>
> = {
  "worktree-missing": "taskWorkspace.marker.worktree-missing",
  "gitdir-mismatch": "taskWorkspace.marker.gitdir-mismatch",
  "pointer-stale": "taskWorkspace.marker.pointer-stale",
  "identity-schema-retired": "taskWorkspace.marker.identity-schema-retired",
  "identity-unsupported": "taskWorkspace.marker.identity-unsupported",
  "head-moved": "taskWorkspace.marker.head-moved",
  "branch-deleted": "taskWorkspace.marker.branch-deleted",
  "uncommitted-changes": "taskWorkspace.marker.uncommitted-changes",
  "lock-stale": "taskWorkspace.marker.lock-stale",
  "path-escape": "taskWorkspace.marker.path-escape",
};
