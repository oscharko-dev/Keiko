import type { GitPublishExecResult, GitPrExecResult } from "@oscharko-dev/keiko-tools";
import type { GitDeliveryApprovalRequirement } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { readGitRawWorktreeSnapshot } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  DraftDeliveryFailure,
  type DraftDeliveryRunContext,
  type DraftDeliveryServiceOptions,
  type PreparedDraftDelivery,
} from "./draftDeliveryTypes.js";
import {
  assertDraftAuthority,
  assertDraftLocalCandidate,
  assertKnownDraftIdentity,
  readDraftRemoteState,
  prTargetMatches,
  resolveDraftRepository,
} from "./draftDeliveryFacts.js";
import { advanceDraft, currentDraft, retainedRemoteIdentity } from "./draftDeliveryLedger.js";
import { executeGovernedPublish } from "./pushExecution.js";
import { executeGovernedPullRequest } from "./prExecution.js";
import { runtimeGitReadDeps } from "./runtimeGitRead.js";
import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";

interface EffectContext {
  readonly options: DraftDeliveryServiceOptions;
  readonly context: DraftDeliveryRunContext;
  readonly record: DraftDeliveryRecord;
  readonly proposal: PreparedDraftDelivery;
  readonly claim: GitDeliveryApprovalRequirement;
}
function assertCurrentAttempt(effect: EffectContext): void {
  assertDraftAuthority(effect.context);
  const current = currentDraft(effect.options, effect.context);
  if (
    current?.proposalId !== effect.record.proposalId ||
    current.revision !== effect.record.revision ||
    current.proposalDigest !== effect.record.proposalDigest ||
    current.phase !== effect.record.phase
  )
    throw new DraftDeliveryFailure("approval-invalid");
}
async function assertBeforeEffect(effect: EffectContext): Promise<void> {
  assertCurrentAttempt(effect);
  await resolveDraftRepository(effect.options, effect.context);
  await assertDraftLocalCandidate(effect.options, effect.context, effect.record.binding);
  const remote = await readDraftRemoteState(effect.options, effect.context, effect.record.binding);
  assertKnownDraftIdentity(effect.record, remote);
  if (
    remote.headSha !== effect.proposal.expectedRemoteHead ||
    (remote.pullRequest !== undefined && remote.pullRequest.headSha !== remote.headSha)
  )
    throw new DraftDeliveryFailure("remote-drift");
  assertCurrentAttempt(effect);
}
function snapshot(effect: EffectContext): ReturnType<typeof readGitRawWorktreeSnapshot> {
  return readGitRawWorktreeSnapshot(
    runtimeGitReadDeps(effect.context, effect.options.execution ?? {}),
  );
}
function issueBoundPrDefault(record: DraftDeliveryRecord): GitDeliveryTrustedPolicyPacks {
  return {
    repoPack: {
      schemaVersion: "1",
      repoId: "issue-bound-draft",
      rules: [
        {
          actionKind: "pr-create",
          decision: "constrained",
          constraints: [
            { kind: "risk-class-ceiling", maxRiskClass: "protected-or-merge" },
            {
              kind: "branch-pattern",
              patterns: [{ matchKind: "exact", value: record.binding.baseRef }],
            },
          ],
        },
      ],
      defaultRule: { decision: "blocked" },
    },
  };
}
export async function executeDraftDeliveryEffect(
  options: DraftDeliveryServiceOptions,
  context: DraftDeliveryRunContext,
  record: DraftDeliveryRecord,
  proposal: PreparedDraftDelivery,
  claim: GitDeliveryApprovalRequirement,
): Promise<DraftDeliveryRecord> {
  const effect = { options, context, record, proposal, claim };
  await assertBeforeEffect(effect);
  return proposal.command.kind === "push" ? push(effect) : createPullRequest(effect);
}
async function push(effect: EffectContext): Promise<DraftDeliveryRecord> {
  const { options, context, record, proposal } = effect;
  if (proposal.command.kind !== "push") throw new DraftDeliveryFailure("payload-changed");
  const seams = options.publishSeams(context);
  const adapter = seams.publishAdapterFactory?.(context.workspace);
  if (adapter === undefined) throw new DraftDeliveryFailure("provider-failed");
  const result = await executeGovernedPublish(
    proposal.command,
    effect.claim,
    context.workspace,
    options.mutationDeps,
    {
      ...seams,
      snapshotReader: () => snapshot(effect),
      beforeRemoteDispatch: () => context.stillAuthorized() && context.signal?.aborted !== true,
      publishAdapterFactory: () => ({
        publish: async (request): Promise<GitPublishExecResult> => {
          await assertBeforeEffect(effect);
          return adapter.publish(request);
        },
      }),
    },
    context.correlationId,
  );
  if (result.lifecycle.outcome.status !== "succeeded")
    throw new DraftDeliveryFailure(
      result.lifecycle.outcome.status === "blocked" ? "preflight-failed" : "provider-failed",
    );
  const remote = await readDraftRemoteState(options, context, record.binding);
  assertKnownDraftIdentity(record, remote);
  if (remote.headSha !== record.binding.headSha) throw new DraftDeliveryFailure("remote-drift");
  return advanceDraft(
    options,
    context,
    record,
    "pushed",
    "completed",
    retainedRemoteIdentity(record, remote.pullRequest),
  );
}
async function createPullRequest(effect: EffectContext): Promise<DraftDeliveryRecord> {
  const { options, context, record, proposal } = effect;
  if (proposal.command.kind !== "pr-create") throw new DraftDeliveryFailure("payload-changed");
  const seams = options.pullRequestSeams(context);
  const adapter = seams.prAdapterFactory?.(context.workspace);
  if (adapter === undefined) throw new DraftDeliveryFailure("provider-failed");
  const result = await executeGovernedPullRequest(
    proposal.command,
    effect.claim,
    context.workspace,
    options.mutationDeps,
    {
      ...seams,
      policyPacks: seams.policyPacks ?? issueBoundPrDefault(record),
      snapshotReader: () => snapshot(effect),
      beforeRemoteDispatch: () => context.stillAuthorized() && context.signal?.aborted !== true,
      prAdapterFactory: () => ({
        updatePullRequest: (request): Promise<GitPrExecResult> =>
          adapter.updatePullRequest(request),
        createPullRequest: async (request): Promise<GitPrExecResult> => {
          await assertBeforeEffect(effect);
          return adapter.createPullRequest(request);
        },
      }),
    },
    context.correlationId,
  );
  const identity = result.createdPrIdentity;
  if (identity === undefined)
    throw new DraftDeliveryFailure(
      result.lifecycle.outcome.status === "blocked" ? "preflight-failed" : "ambiguous-remote",
    );
  if (!prTargetMatches(identity, record.binding) || identity.headSha !== record.binding.headSha)
    throw new DraftDeliveryFailure("ambiguous-remote");
  return retainCreatedIdentity(effect, identity);
}
async function confirmCreated(
  effect: EffectContext,
  identity: GitPullRequestIdentity,
): Promise<DraftDeliveryRecord> {
  const { options, context, record } = effect;
  const adapter = options.inspectionAdapter(context);
  if (adapter === undefined) throw new DraftDeliveryFailure("provider-failed");
  const read = await adapter.readPullRequest({
    ownerAndRepo: record.binding.repository,
    prExternalId: String(identity.number),
  });
  const retained = { ...record, pullRequest: identity };
  if (
    !read.ok ||
    read.value.externalId !== identity.externalId ||
    read.value.number !== identity.number
  )
    return advanceDraft(
      options,
      context,
      retained,
      "recovery-required",
      "ambiguous-remote",
      identity,
    );
  const remote = await readDraftRemoteState(options, context, record.binding);
  assertKnownDraftIdentity(retained, remote);
  if (
    !prTargetMatches(read.value, record.binding) ||
    remote.headSha !== record.binding.headSha ||
    read.value.headSha !== record.binding.headSha
  )
    return advanceDraft(options, context, retained, "recovery-required", "remote-drift", identity);
  assertDraftAuthority(context);
  return advanceDraft(options, context, retained, "draft-created", "completed", read.value);
}

async function retainCreatedIdentity(
  effect: EffectContext,
  identity: GitPullRequestIdentity,
): Promise<DraftDeliveryRecord> {
  try {
    return await confirmCreated(effect, identity);
  } catch (error) {
    throw new DraftDeliveryFailure(
      error instanceof DraftDeliveryFailure ? error.reason : "provider-failed",
      identity,
      { cause: error },
    );
  }
}
