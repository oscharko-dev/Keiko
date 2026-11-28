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
): "recorded" | "replaced" | undefined {
  if (verifiedBaseObjectId(facts) === receipt.baseSha) return "recorded";
  const selfBased =
    context.baseRef === context.headRef &&
    facts.head.kind === "born" &&
    receipt.baseSha === receipt.parentSha;
  return selfBased ? "replaced" : undefined;
}

type RecoveredIdentity = Awaited<ReturnType<typeof readGitCommitIdentity>>;

// A base that replaced the recorded one is compared to the recovered commit itself, never to nothing.
function baseIsRecovered(
  base: "recorded" | "replaced",
  facts: VerifiedCommitFacts,
  identity: RecoveredIdentity,
): boolean {
  return base === "recorded" || verifiedBaseObjectId(facts) === identity.headSha;
}

function identityMatchesReceipt(
  identity: RecoveredIdentity,
  receipt: VerifiedCommitResult,
  baseRecovered: boolean,
): boolean {
  // The root commit of an unborn branch records the all-zero parent and has no parent at all.
  const parents = isGitZeroObjectId(receipt.parentSha) ? [] : [receipt.parentSha];
  return [
    baseRecovered,
    identity.parentShas.length === parents.length,
    identity.parentShas.every((sha, index) => sha === parents[index]),
    identity.treeDigest === receipt.stagedTreeDigest,
    identity.messageDigest === receipt.messageDigest,
  ].every(Boolean);
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
  const base = baseReconciles(facts, receipt, context);
  if (base === undefined || facts.repositoryDigest !== receipt.repositoryDigest) return receipt;
  const identity = await readGitCommitIdentity(
    {
      workspace: context.workspace,
      signal: context.signal,
      onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
    },
    context.headRef,
  );
  const matched = identityMatchesReceipt(identity, receipt, baseIsRecovered(base, facts, identity));
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
