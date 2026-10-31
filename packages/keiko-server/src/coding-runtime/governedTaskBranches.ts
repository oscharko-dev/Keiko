/**
 * The task branches Keiko's own `keiko_git_branch` moved a run onto (#3907, owner decision
 * 2026-10-31).
 *
 * A run's Authority Envelope is immutable: it names the branch the run started on. A Local checkout
 * on `main` therefore starts with task branch equal to base branch, and the governed commit refuses
 * it as a protected branch. When the model asks Keiko to create a task branch and Keiko, through the
 * Git kernel, creates it and switches to it, the run keeps its envelope and this record states the
 * one fact that changed: this run, in this workspace, now stands on that branch, with its base
 * branch unchanged. The workspace authority accepts the branch exactly as it accepts the head a
 * governed fast-forward wrote (governedSyncHeads.ts): this run, this workspace, and the live state
 * itself. Only RuntimeGitService records it, after Keiko's own successful switch; a branch anyone
 * else switched to is never recorded and keeps failing closed.
 *
 * The record lives as long as the server process; a run does not outlive it, and a run started
 * later binds to the branch the workspace instance holds when it starts.
 */
export interface GovernedTaskBranch {
  readonly runId: string;
  /** The branch the run stands on now (the one Keiko created). */
  readonly taskBranch: string;
  /** The base branch the run started from; unchanged by the switch. */
  readonly baseBranch: string;
  /** The commit both branches pointed at when the switch happened. */
  readonly headSha: string;
  readonly workspaceDigest: string;
}

export interface GovernedTaskBranches {
  readonly record: (branch: GovernedTaskBranch) => void;
  /** The branch Keiko last moved this run onto. */
  readonly latest: (runId: string) => GovernedTaskBranch | undefined;
  /** Forgets a record whose adoption failed, so a half-made switch never authorizes anything. */
  readonly clear: (runId: string) => void;
}

/** Runs remembered at once; the run least recently rebound is forgotten first. */
export const GOVERNED_TASK_BRANCHES_MAX_RUNS = 256;

export function createGovernedTaskBranches(): GovernedTaskBranches {
  const branches = new Map<string, GovernedTaskBranch>();
  return {
    record: (branch): void => {
      branches.delete(branch.runId);
      branches.set(branch.runId, Object.freeze({ ...branch }));
      if (branches.size <= GOVERNED_TASK_BRANCHES_MAX_RUNS) return;
      const oldest = branches.keys().next().value;
      if (oldest !== undefined) branches.delete(oldest);
    },
    latest: (runId): GovernedTaskBranch | undefined => branches.get(runId),
    clear: (runId): void => {
      branches.delete(runId);
    },
  };
}
