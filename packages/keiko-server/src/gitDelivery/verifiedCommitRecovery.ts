import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { readGitCommitIdentity } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { readVerifiedCommitFacts } from "./verifiedCommitFacts.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";

/** Reconciliation reads live objects only: it never retries a mutation or restores an approval. */
export async function reconcileVerifiedCommit(
  receipt: VerifiedCommitResult,
  context: VerifiedCommitRunContext,
  seams: GitDeliveryExecutionSeams,
): Promise<VerifiedCommitResult> {
  if (
    !context.stillAuthorized() ||
    context.workspaceDigest !== receipt.workspaceDigest ||
    context.repositoryDigest !== receipt.repositoryDigest
  )
    return receipt;
  const facts = await readVerifiedCommitFacts(context, seams);
  if (facts.baseSha !== receipt.baseSha || facts.repositoryDigest !== receipt.repositoryDigest)
    return receipt;
  const identity = await readGitCommitIdentity(
    {
      workspace: context.workspace,
      signal: context.signal,
      onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
    },
    context.headRef,
  );
  const matched = [
    identity.parentShas.length === 1,
    identity.parentShas[0] === receipt.parentSha,
    identity.treeDigest === receipt.stagedTreeDigest,
    identity.messageDigest === receipt.messageDigest,
  ].every(Boolean);
  if (!matched || !context.stillAuthorized()) return receipt;
  return {
    ...receipt,
    status: "succeeded",
    reason: "completed",
    recordedAt: new Date((seams.now ?? Date.now)()).toISOString(),
    headSha: identity.headSha,
    committedTreeDigest: identity.treeDigest,
  };
}
