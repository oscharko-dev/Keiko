import {
  GitRawWorktreeReadError,
  readGitRawChanges,
  readGitRemoteAliases,
  readGitRevision,
  gitCommitMessageDigest,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { readVerifiedRepositoryIdentity } from "./verifiedRepositoryIdentity.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";
import { logDeniedPathExclusion } from "./runtimeGitRead.js";
import {
  VERIFIED_COMMIT_BLOCKING_PATHS_MAX,
  type VerifiedCommitBlockingPaths,
  type VerifiedCommitFacts,
  type VerifiedCommitRunContext,
} from "./verifiedCommitTypes.js";
type RawChangedFiles = Awaited<ReturnType<typeof readGitRawChanges>>["changes"];

function cleanCandidate(context: VerifiedCommitRunContext, changes: RawChangedFiles): boolean {
  return (
    context.buffersClean() &&
    !changes.some((file) => file.unstaged || file.untracked) &&
    context.stillAuthorized()
  );
}

// The paths that keep the candidate from being clean. The two lists are cut at
// VERIFIED_COMMIT_BLOCKING_PATHS_MAX; the counts stay exact.
function blockingPathsOf(changes: RawChangedFiles): VerifiedCommitBlockingPaths {
  const unstaged = changes.filter((file) => file.unstaged && !file.untracked);
  const untracked = changes.filter((file) => file.untracked);
  return {
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    unstaged: unstaged.slice(0, VERIFIED_COMMIT_BLOCKING_PATHS_MAX).map((file) => file.path),
    untracked: untracked.slice(0, VERIFIED_COMMIT_BLOCKING_PATHS_MAX).map((file) => file.path),
  };
}

// Full access commits the staged candidate while untracked files lie outside it, as a plain `git
// commit` does (owner decision 2026-10-30, #3907): the parity lane's own `npm install` had left an
// untracked package-lock.json, and the model, which rightly kept it out of the commit, read
// candidate-not-staged until the run's deadline. Unstaged changes and unsaved buffers still refuse.
// The push of that commit re-reads the same facts and admits the same files (lab T17, round I).
export function untrackedOutsideCandidate(
  context: VerifiedCommitRunContext,
  facts: VerifiedCommitFacts,
): boolean {
  const blocking = facts.blocking;
  return (
    !facts.clean &&
    blocking?.unstagedCount === 0 &&
    blocking.untrackedCount > 0 &&
    context.buffersClean()
  );
}

export function verifiedCommitMessageDigest(message: string): string {
  return gitCommitMessageDigest(message);
}

export async function readVerifiedCommitFacts(
  context: VerifiedCommitRunContext,
  seams: GitDeliveryExecutionSeams,
): Promise<VerifiedCommitFacts> {
  if (!context.stillAuthorized() || context.signal?.aborted === true)
    throw new Error("verified-commit-authority-unavailable");
  const deps = {
    workspace: context.workspace,
    processEnv: seams.processEnv,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
  };
  // ONE raw read supplies the facts AND an unclean candidate's blocking paths, so the paths can never
  // contradict the refusal they ride on. They used to come from a second read taken after this one,
  // with no cross-check (review finding on PR #3452).
  const raw = await readGitRawChanges(deps);
  if (raw.truncated) throw new GitRawWorktreeReadError("git-raw-snapshot-incomplete");
  logDeniedPathExclusion(seams, context.correlationId, raw.deniedPathCount);
  const baseSha = await readGitRevision(deps, context.baseRef);
  if (raw.branch !== context.headRef) throw new Error("verified-commit-repository-drift");
  const { digest: repositoryDigest } = await readVerifiedRepositoryIdentity(
    deps,
    context.workspaceDigest,
    await readGitRemoteAliases(deps),
  );
  if (repositoryDigest !== context.repositoryDigest)
    throw new Error("verified-commit-repository-drift");
  const clean = cleanCandidate(context, raw.changes);
  return {
    headSha: raw.headSha,
    baseSha,
    stagedTreeDigest: raw.stagedTreeDigest,
    repositoryDigest,
    clean,
    ...(clean ? {} : { blocking: blockingPathsOf(raw.changes) }),
  };
}

export function sameVerifiedCommitFacts(a: VerifiedCommitFacts, b: VerifiedCommitFacts): boolean {
  return (
    a.clean &&
    b.clean &&
    a.headSha === b.headSha &&
    a.baseSha === b.baseSha &&
    a.stagedTreeDigest === b.stagedTreeDigest &&
    a.repositoryDigest === b.repositoryDigest
  );
}
