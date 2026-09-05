import type {
  DraftDeliveryBinding,
  DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  isVerifiedCommitResult,
  type VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import {
  isGitPullRequestIdentity,
  type GitPullRequestIdentity,
} from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { sameGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { readGitTreeDigest } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import { readVerifiedCommitFacts } from "./verifiedCommitFacts.js";
import { runtimeGitReadDeps } from "./runtimeGitRead.js";
import { mintProposalId } from "./proposalId.js";
import {
  DraftDeliveryFailure,
  type DraftDeliveryDependencies,
  type DraftDeliveryRunContext,
} from "./draftDeliveryTypes.js";

export function draftDeliveryId(prefix: "delivery" | "recovery"): string {
  return mintProposalId(prefix);
}

export function assertDraftAuthority(context: DraftDeliveryRunContext): void {
  if (!context.stillAuthorized() || context.signal?.aborted === true)
    throw new DraftDeliveryFailure("authority-denied");
}

export async function resolveDraftRepository(
  options: DraftDeliveryDependencies,
  context: DraftDeliveryRunContext,
): Promise<string> {
  assertDraftAuthority(context);
  const target = await options.resolveTarget(context);
  assertDraftAuthority(context);
  if (!target.ok) throw new DraftDeliveryFailure(target.reason);
  if (
    codingWorkbenchRemoteDigest(target.repository) !== context.issueBinding.remoteDigest ||
    context.repositoryDigest !== context.issueBinding.remoteDigest ||
    context.baseRef !== context.issueBinding.defaultBaseRef ||
    context.headRef === context.baseRef
  )
    throw new DraftDeliveryFailure("remote-drift");
  return target.repository.toLowerCase();
}

export function initialDraftBinding(
  options: DraftDeliveryDependencies,
  context: DraftDeliveryRunContext,
  repository: string,
): DraftDeliveryBinding | undefined {
  const commit = options.snapshots.get(context.runId)?.verifiedCommitResult;
  if (
    !isVerifiedCommitResult(commit) ||
    commit.status !== "succeeded" ||
    commit.headSha === undefined
  )
    return undefined;
  if (!commitContextMatches(commit, context)) return undefined;
  return {
    runId: context.runId,
    workspaceDigest: context.workspaceDigest,
    runtimeAuthorityDigest: context.runtimeAuthorityDigest,
    envelopeDigest: context.envelopeDigest,
    remoteDigest: context.repositoryDigest,
    issueBindingDigest: context.issueBinding.bindingDigest,
    issueIdDigest: context.issueBinding.issueIdDigest,
    issueNumber: context.issueBinding.issueNumber,
    repository,
    remoteAlias: "origin",
    baseRef: context.baseRef,
    baseSha: commit.baseSha,
    headRef: context.headRef,
    headSha: commit.headSha,
    verifiedCommitProposalId: commit.proposalId,
    recoveryId: draftDeliveryId("recovery"),
  };
}

export async function assertDraftLocalCandidate(
  options: DraftDeliveryDependencies,
  context: DraftDeliveryRunContext,
  binding: DraftDeliveryBinding,
): Promise<void> {
  const execution = options.execution ?? {};
  const facts = await readVerifiedCommitFacts(context, execution);
  const tree = await readGitTreeDigest(runtimeGitReadDeps(context, execution), binding.headSha);
  assertDraftAuthority(context);
  if (
    !facts.clean ||
    facts.headSha !== binding.headSha ||
    facts.baseSha !== binding.baseSha ||
    facts.stagedTreeDigest !== tree
  )
    throw new DraftDeliveryFailure("remote-drift");
}

export interface DraftRemoteState {
  readonly headSha: string | undefined;
  readonly pullRequest: GitPullRequestIdentity | undefined;
}

export async function readDraftRemoteState(
  options: DraftDeliveryDependencies,
  context: DraftDeliveryRunContext,
  binding: DraftDeliveryBinding,
): Promise<DraftRemoteState> {
  assertDraftAuthority(context);
  const adapter = options.inspectionAdapter(context);
  if (adapter === undefined) throw new DraftDeliveryFailure("provider-failed");
  const input = { ownerAndRepo: binding.repository, headBranchName: binding.headRef };
  const base = await adapter.readBranchHead({ ...input, headBranchName: binding.baseRef });
  if (!base.ok || base.value !== binding.baseSha) throw new DraftDeliveryFailure("remote-drift");
  const head = await adapter.readBranchHead(input);
  if (!head.ok && head.reason !== "not-found") throw new DraftDeliveryFailure("provider-failed");
  const list = await adapter.findPullRequestsByHead(input);
  assertDraftAuthority(context);
  if (!list.ok) throw new DraftDeliveryFailure("provider-failed");
  const pullRequest = resolveListedIdentity(list.value, binding);
  return { headSha: head.ok ? head.value : undefined, pullRequest };
}

export function prTargetMatches(
  pr: GitPullRequestIdentity,
  binding: DraftDeliveryBinding,
): boolean {
  return (
    isGitPullRequestIdentity(pr) &&
    sameGitHubOwnerAndRepo(pr.repository, binding.repository) &&
    sameGitHubOwnerAndRepo(pr.headRepository, binding.repository) &&
    pr.headRef === binding.headRef &&
    pr.baseRef === binding.baseRef &&
    pr.baseSha === binding.baseSha &&
    pr.state === "open" &&
    pr.isDraft
  );
}

/** An unknown PR is never adopted from a matching branch name after an ambiguous create. */
export function assertKnownDraftIdentity(
  record: DraftDeliveryRecord,
  remote: DraftRemoteState,
): void {
  if (record.pullRequest === undefined && remote.pullRequest !== undefined)
    throw new DraftDeliveryFailure("ambiguous-remote");
  if (
    record.pullRequest !== undefined &&
    (remote.pullRequest?.externalId !== record.pullRequest.externalId ||
      remote.pullRequest.number !== record.pullRequest.number)
  )
    throw new DraftDeliveryFailure("remote-drift");
}

function commitContextMatches(
  commit: VerifiedCommitResult,
  context: DraftDeliveryRunContext,
): boolean {
  return (
    commit.runId === context.runId &&
    commit.envelopeDigest === context.envelopeDigest &&
    commit.runtimeAuthorityDigest === context.runtimeAuthorityDigest &&
    commit.workspaceDigest === context.workspaceDigest &&
    commit.repositoryDigest === context.repositoryDigest &&
    commit.issueBindingDigest === context.issueBinding.bindingDigest
  );
}

function resolveListedIdentity(
  list: readonly GitPullRequestIdentity[],
  binding: DraftDeliveryBinding,
): GitPullRequestIdentity | undefined {
  if (list.length > 1) throw new DraftDeliveryFailure("ambiguous-remote");
  const pr = list[0];
  if (pr !== undefined && !prTargetMatches(pr, binding))
    throw new DraftDeliveryFailure("remote-drift");
  return pr;
}
