import {
  readGitRawWorktreeSnapshot,
  readGitRevision,
  gitCommitMessageDigest,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { readVerifiedRepositoryIdentity } from "./verifiedRepositoryIdentity.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";
import type { VerifiedCommitFacts, VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
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
