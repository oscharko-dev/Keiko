import {
  readGitRawChanges,
  readGitRawWorktreeSnapshot,
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
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";

function cleanCandidate(context: VerifiedCommitRunContext, snapshot: GitWorktreeSnapshot): boolean {
  return (
    context.buffersClean() &&
    snapshot.unstagedFileCount === 0 &&
    snapshot.untrackedFileCount === 0 &&
    context.stillAuthorized()
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
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
  };
  const snapshot = await readGitRawWorktreeSnapshot(deps);
  logDeniedPathExclusion(seams, context.correlationId, snapshot.deniedPathCount);
  const baseSha = await readGitRevision(deps, context.baseRef);
  if (
    snapshot.headSha === undefined ||
    snapshot.stagedTreeDigest === undefined ||
    snapshot.currentBranchName !== context.headRef
  )
    throw new Error("verified-commit-repository-drift");
  const { digest: repositoryDigest } = await readVerifiedRepositoryIdentity(
    deps,
    context.workspaceDigest,
    snapshot.remoteAliases,
  );
  if (repositoryDigest !== context.repositoryDigest)
    throw new Error("verified-commit-repository-drift");
  return {
    headSha: snapshot.headSha,
    baseSha,
    stagedTreeDigest: snapshot.stagedTreeDigest,
    repositoryDigest,
    clean: cleanCandidate(context, snapshot),
  };
}

// The paths that keep the candidate from being clean, read from the same raw change list the
// snapshot's counts come from — only on the refusal path, so the proof path pays nothing. The two
// lists are cut at VERIFIED_COMMIT_BLOCKING_PATHS_MAX; the counts stay exact.
export async function readVerifiedCommitBlockingPaths(
  context: VerifiedCommitRunContext,
  seams: GitDeliveryExecutionSeams,
): Promise<VerifiedCommitBlockingPaths> {
  const raw = await readGitRawChanges({
    workspace: context.workspace,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
  });
  const unstaged = raw.changes.filter((file) => file.unstaged && !file.untracked);
  const untracked = raw.changes.filter((file) => file.untracked);
  return {
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    unstaged: unstaged.slice(0, VERIFIED_COMMIT_BLOCKING_PATHS_MAX).map((file) => file.path),
    untracked: untracked.slice(0, VERIFIED_COMMIT_BLOCKING_PATHS_MAX).map((file) => file.path),
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
