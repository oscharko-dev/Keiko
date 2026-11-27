import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import { LOCAL_CHECKOUT_WORKSPACE_ID_PREFIX } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

/** The branch an open local task belongs to, and the branch its next message would run on. */
export interface TaskBranchMove {
  readonly taskBranch: string;
  readonly nextBranch: string;
}

/**
 * A task that works in place on a local checkout belongs to the branch it began on: the server
 * admits its next message only there (`taskIn`). When the checkout moved to another branch, in Git
 * for example, and no other branch is chosen, that message is refused with no way out the person
 * can read. This names both branches before the start, so the person can choose the task's branch
 * again (the start switches the checkout back) or begin a new task (#4491).
 *
 * `null` while a run is active, for a task that is closed, imported or not local, for another
 * repository, and while the checkout's branch is unknown.
 */
export function movedTaskBranch(
  detail: CodingHistoryDetail | null,
  input: {
    readonly repositoryRoot: string | null;
    readonly checkoutBranch: string | null;
    readonly selectedBranch: string | undefined;
    readonly runIsActive: boolean;
  },
): TaskBranchMove | null {
  if (detail === null || input.runIsActive) return null;
  const { task } = detail;
  if (task.status !== "active" || task.origin === "imported") return null;
  if (!task.workspaceId.startsWith(LOCAL_CHECKOUT_WORKSPACE_ID_PREFIX)) return null;
  if (task.projectPath !== input.repositoryRoot) return null;
  const nextBranch = input.selectedBranch ?? input.checkoutBranch;
  if (nextBranch === null || nextBranch === task.branch) return null;
  return { taskBranch: task.branch, nextBranch };
}
