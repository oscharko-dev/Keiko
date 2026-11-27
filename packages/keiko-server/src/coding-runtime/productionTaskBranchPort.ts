import type { RuntimeGitTaskBranchPort } from "../gitDelivery/runtimeGitBranch.js";
import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { GovernedTaskBranches } from "./governedTaskBranches.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";

/**
 * The workspace side of a governed task branch (`keiko_git_branch`, #3907), composed for one run.
 *
 * Creating and switching the branch is the Git kernel's job (runtimeGitBranch.ts); this port is
 * what makes the result the run's own without touching its immutable Authority Envelope. Three
 * server-owned records move together, in an order where the one step that can refuse comes first
 * and every later failure undoes the earlier ones:
 *
 *  1. the run's Git delivery authority follows the run to the new branch (its base is unchanged);
 *  2. the per-run record (governedTaskBranches.ts) states that this run stands on that branch,
 *     which is what the workspace authority and the verified-commit context read;
 *  3. the Local checkout's workspace instance takes the branch as its task branch and keeps the
 *     old one as its base branch.
 *
 * After those, the run's Coding History task follows the branch, so its next message is admitted on
 * the branch the workspace now stands on (#4491). That step never refuses and needs no undo.
 */
export interface ProductionTaskBranchBinding {
  readonly workspaceId: string;
  readonly lifecycle: Pick<WorkspaceLifecycleService, "admitTaskBranch" | "adoptTaskBranch">;
  readonly branches: Pick<GovernedTaskBranches, "record" | "clear">;
  readonly authority: Pick<CodingRuntimeAuthorityService, "rebindGitDeliveryBranch">;
  readonly followHistory?: (runId: string, branch: string) => void;
}

export function createProductionTaskBranchPort(
  binding: ProductionTaskBranchBinding,
): RuntimeGitTaskBranchPort | undefined {
  const { admitTaskBranch, adoptTaskBranch } = binding.lifecycle;
  if (admitTaskBranch === undefined || adoptTaskBranch === undefined) return undefined;
  return {
    admit: () => admitTaskBranch(binding.workspaceId),
    adopt: (adoption): boolean => {
      const undoAuthority = binding.authority.rebindGitDeliveryBranch(adoption.runId, {
        headRef: adoption.branch,
        baseRef: adoption.baseBranch,
      });
      if (undoAuthority === undefined) return false;
      binding.branches.record({
        runId: adoption.runId,
        taskBranch: adoption.branch,
        baseBranch: adoption.baseBranch,
        headSha: adoption.headSha,
        workspaceDigest: adoption.workspaceDigest,
      });
      try {
        adoptTaskBranch({
          workspaceId: binding.workspaceId,
          branch: adoption.branch,
          baseBranch: adoption.baseBranch,
        });
      } catch (error) {
        binding.branches.clear(adoption.runId);
        undoAuthority();
        throw error;
      }
      binding.followHistory?.(adoption.runId, adoption.branch);
      return true;
    },
  };
}
