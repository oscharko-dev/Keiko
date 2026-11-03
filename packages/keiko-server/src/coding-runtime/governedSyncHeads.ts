import { createBoundedRunRecords } from "./boundedRunRecords.js";

/**
 * The heads a governed fast-forward pull moved a run's own branch to (#3902 AC2, PR #4064 review
 * 4373825976).
 *
 * A run's authority is bound to the head it started on, or to a head Keiko's own verified commit
 * wrote (productionRuntimeWorkspaceAuthority.ts `trustedHeadMatches`). A fast-forward the Git sync
 * owner performed for the run, after the run's authority was proven immediately before the remote
 * dispatch, is the same kind of head: Keiko wrote it. RuntimeGitService records it here, and the
 * workspace authority accepts it exactly as it accepts the verified commit's receipt: this run, this
 * workspace, and the live head itself. A head anyone else wrote is never recorded.
 *
 * The record lives as long as the server process; a run does not outlive it, and a run started
 * later binds to the head it starts on.
 */
export interface GovernedSyncHead {
  readonly runId: string;
  readonly headSha: string;
  readonly workspaceDigest: string;
}

export interface GovernedSyncHeads {
  readonly record: (head: GovernedSyncHead) => void;
  /** The last head a governed fast-forward of this run wrote. */
  readonly latest: (runId: string) => GovernedSyncHead | undefined;
}

/** Runs remembered at once; the run least recently synchronized is forgotten first. */
export const GOVERNED_SYNC_HEADS_MAX_RUNS = 256;

export function createGovernedSyncHeads(): GovernedSyncHeads {
  const heads = createBoundedRunRecords<GovernedSyncHead>(GOVERNED_SYNC_HEADS_MAX_RUNS);
  return { record: heads.record, latest: heads.latest };
}
