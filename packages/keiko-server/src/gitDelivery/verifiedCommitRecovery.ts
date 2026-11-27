import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import {
  isGitZeroObjectId,
  readGitCommitIdentity,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { readVerifiedCommitFacts, verifiedBaseObjectId } from "./verifiedCommitFacts.js";
import type { VerifiedCommitFacts, VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";

// The base the receipt recorded, or the commit that has since replaced it: a branch that is its own
// base (an unborn branch, or a local checkout of the task branch) has the new commit as its base
// once the interrupted commit landed, so the receipt's earlier base is the parent it recorded.
function baseReconciles(
  facts: VerifiedCommitFacts,
  receipt: VerifiedCommitResult,
  context: VerifiedCommitRunContext,
): boolean {
  if (verifiedBaseObjectId(facts) === receipt.baseSha) return true;
  return (
    context.baseRef === context.headRef &&
    facts.head.kind === "born" &&
    receipt.baseSha === receipt.parentSha
  );
}

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
  if (
    !baseReconciles(facts, receipt, context) ||
    facts.repositoryDigest !== receipt.repositoryDigest
  )
    return receipt;
  const identity = await readGitCommitIdentity(
    {
      workspace: context.workspace,
      signal: context.signal,
      onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
    },
    context.headRef,
  );
  // The root commit of an unborn branch records the all-zero parent and has no parent at all.
  const parents = isGitZeroObjectId(receipt.parentSha) ? [] : [receipt.parentSha];
  const matched = [
    identity.parentShas.length === parents.length,
    identity.parentShas.every((sha, index) => sha === parents[index]),
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
