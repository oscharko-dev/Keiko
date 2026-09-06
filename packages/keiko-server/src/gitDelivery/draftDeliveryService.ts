import type {
  CodingRuntimeDeliveryResult,
  CodingRuntimeDeliveryReview,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type {
  DraftDeliveryBinding,
  DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitDeliveryApprovalRequirement } from "@oscharko-dev/keiko-contracts";
import type { GitPrCreateCommand, GitPushCommand } from "@oscharko-dev/keiko-tools";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  type GitDeliveryIssuedApproval,
} from "./approvalStore.js";
import {
  DraftDeliveryFailure,
  type PreparedDraftDelivery,
  type DraftDeliveryRunContext,
  type DraftDeliveryService,
  type DraftDeliveryServiceOptions,
} from "./draftDeliveryTypes.js";
import {
  assertDraftAuthority,
  assertDraftLocalCandidate,
  assertKnownDraftIdentity,
  initialDraftBinding,
  readDraftRemoteState,
  resolveDraftRepository,
} from "./draftDeliveryFacts.js";
import {
  adoptDraftPredecessor,
  advanceDraft,
  currentDraft,
  draftNow,
  draftProposalDigest,
  proposalRecord,
  storeDraft,
  draftApprovalChanged,
  type DraftDeliveryCommand,
} from "./draftDeliveryLedger.js";
import { resolveDraftDeliveryTemplate } from "./draftDeliveryTemplate.js";
import { executeDraftDeliveryEffect } from "./draftDeliveryEffects.js";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";

interface DeliveryGuard {
  readonly check: () => boolean;
  readonly intent?: "push" | "pull-request" | undefined;
  readonly signal?: AbortSignal | undefined;
}
function recorded(record: DraftDeliveryRecord): CodingRuntimeDeliveryResult {
  return { status: "recorded", record };
}
function unavailable(
  reason: Extract<CodingRuntimeDeliveryResult, { status: "unavailable" }>["reason"],
): CodingRuntimeDeliveryResult {
  return { status: "unavailable", reason };
}

export class DraftDeliveryController implements DraftDeliveryService {
  private generation = 0;
  private busy = false;
  private proposal: PreparedDraftDelivery | undefined;
  private leases = new WeakMap<
    object,
    { proposal: PreparedDraftDelivery; claim: GitDeliveryApprovalRequirement }
  >();
  public constructor(private readonly options: DraftDeliveryServiceOptions) {}
  private store(): typeof DEFAULT_GIT_DELIVERY_APPROVAL_STORE {
    return this.options.execution?.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
  }
  public invalidate(): void {
    this.generation += 1;
    this.proposal = undefined;
    this.leases = new WeakMap();
  }
  public review(id: string): PreparedDraftDelivery | undefined {
    const value = this.proposal;
    const context = this.options.context();
    if (value?.record.proposalId !== id || context?.runId !== value.record.binding.runId)
      return undefined;
    if (value.expiresAtMs <= draftNow(this.options) || !context.stillAuthorized()) return undefined;
    const current = currentDraft(this.options, context);
    return sameProposal(current, value) ? value : undefined;
  }
  public issueApproval(id: string): GitDeliveryIssuedApproval | undefined {
    const proposal = this.review(id);
    if (proposal === undefined) return undefined;
    const issued = this.store().issue({
      binding: proposal.approvalBinding,
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: draftNow(this.options),
      ttlMs: proposal.expiresAtMs - draftNow(this.options),
    });
    draftApprovalChanged(this.options, proposal, "approval-issued");
    return issued;
  }
  public matchesApproval(id: string): boolean {
    const proposal = this.review(id);
    return (
      proposal !== undefined &&
      this.store().matchesDeliveryBinding?.(proposal.approvalBinding, draftNow(this.options)) ===
        true
    );
  }
  public consumeApproval(id: string): object | undefined {
    const proposal = this.review(id);
    if (proposal === undefined) return undefined;
    const claim = this.store().consumeDeliveryBinding?.(
      proposal.approvalBinding,
      draftNow(this.options),
    );
    if (claim === undefined) return undefined;
    const lease = Object.freeze({});
    this.leases.set(lease, { proposal, claim });
    draftApprovalChanged(this.options, proposal, "approval-consumed");
    return lease;
  }
  public proposePush(): Promise<CodingRuntimeDeliveryResult> {
    return this.run((context) => this.preparePush(context));
  }
  public proposePullRequest(title: string): Promise<CodingRuntimeDeliveryResult> {
    return this.run((context) => this.preparePullRequest(context, title));
  }
  public reconcile(): Promise<CodingRuntimeDeliveryResult> {
    return this.run((context) => this.reconcileCurrent(context));
  }
  public executeApproved(
    id: string,
    lease: object | undefined,
    guard: DeliveryGuard,
  ): Promise<CodingRuntimeDeliveryResult> {
    return this.run((context) => this.executeCurrent(context, id, lease, guard.intent), guard);
  }
  private context(guard?: DeliveryGuard): DraftDeliveryRunContext | undefined {
    const context = this.options.context();
    if (context === undefined || guard?.check() === false) return undefined;
    const generation = this.generation;
    const signals = [context.signal, guard?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    return {
      ...context,
      signal: AbortSignal.any(signals),
      stillAuthorized: () =>
        generation === this.generation && context.stillAuthorized() && guard?.check() !== false,
    };
  }
  private async run(
    work: (context: DraftDeliveryRunContext) => Promise<CodingRuntimeDeliveryResult>,
    guard?: DeliveryGuard,
  ): Promise<CodingRuntimeDeliveryResult> {
    const context = this.context(guard);
    if (context === undefined) return unavailable("authority-denied");
    if (this.busy) return this.busyRefusal(context);
    this.busy = true;
    try {
      assertDraftAuthority(context);
      return await work(context);
    } catch (error) {
      return this.failure(context, error);
    } finally {
      this.busy = false;
    }
  }
  private busyRefusal(context: DraftDeliveryRunContext): CodingRuntimeDeliveryResult {
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.draft-delivery",
      correlationId: context.correlationId,
      level: "warn",
      extra: { runId: context.runId, phase: "refused", reason: "operation-in-flight" },
    });
    return unavailable("operation-in-flight");
  }
  private failure(context: DraftDeliveryRunContext, error: unknown): CodingRuntimeDeliveryResult {
    this.proposal = undefined;
    const reason = error instanceof DraftDeliveryFailure ? error.reason : "provider-failed";
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.draft-delivery",
      correlationId: context.correlationId,
      level: "warn",
      errorKind: "internal",
      extra: { runId: context.runId, phase: "failed", reason, ...describeError(error) },
    });
    const current = currentDraft(this.options, context);
    if (current === undefined) return unavailable("provider-unavailable");
    const pullRequest =
      error instanceof DraftDeliveryFailure
        ? (error.pullRequest ?? current.pullRequest)
        : current.pullRequest;
    return recorded(
      advanceDraft(this.options, context, current, "recovery-required", reason, pullRequest),
    );
  }
  private getOrAdopt(context: DraftDeliveryRunContext): DraftDeliveryRecord | undefined {
    return currentDraft(this.options, context) ?? adoptDraftPredecessor(this.options, context);
  }
  private async preparePush(
    context: DraftDeliveryRunContext,
  ): Promise<CodingRuntimeDeliveryResult> {
    const repository = await resolveDraftRepository(this.options, context);
    const prior = this.getOrAdopt(context);
    if (prior?.phase === "pushing" || prior?.phase === "creating-pr")
      return this.reconcileCurrent(context);
    const source = initialDraftBinding(this.options, context, repository) ?? prior?.binding;
    if (source === undefined) return unavailable("verified-commit-required");
    const binding =
      prior === undefined ? source : { ...source, recoveryId: prior.binding.recoveryId };
    await assertDraftLocalCandidate(this.options, context, binding);
    const retained = this.retainedPushProposal(context, binding, prior);
    if (retained !== undefined) return retained;
    return this.pushProposal(context, binding, prior);
  }
  private retainedPushProposal(
    context: DraftDeliveryRunContext,
    binding: DraftDeliveryBinding,
    prior: DraftDeliveryRecord | undefined,
  ): Promise<CodingRuntimeDeliveryResult> | undefined {
    if (prior?.binding.headSha !== binding.headSha || prior.phase === "recovery-required")
      return undefined;
    return prior.phase !== "push-proposed" || this.review(prior.proposalId) !== undefined
      ? Promise.resolve(recorded(prior))
      : this.reconcileCurrent(context);
  }
  private async pushProposal(
    context: DraftDeliveryRunContext,
    binding: DraftDeliveryBinding,
    prior: DraftDeliveryRecord | undefined,
  ): Promise<CodingRuntimeDeliveryResult> {
    const command: GitPushCommand = {
      kind: "push",
      verifiedCommitSha: binding.headSha,
      sourceBranchName: binding.headRef,
      remoteAlias: "origin",
      remoteBranchName: binding.headRef,
      forcePush: false,
      setUpstreamTracking: false,
    };
    const record = proposalRecord(this.options, binding, command, prior);
    storeDraft(this.options, context, record, prior?.revision ?? null);
    const remote = await readDraftRemoteState(this.options, context, binding);
    assertKnownDraftIdentity(record, remote);
    if (
      remote.headSha !== undefined &&
      remote.headSha !== binding.headSha &&
      remote.headSha !== prior?.binding.headSha
    )
      throw new DraftDeliveryFailure("remote-drift");
    return this.acceptProposal(context, record, command, { record }, remote.headSha);
  }
  private async preparePullRequest(
    context: DraftDeliveryRunContext,
    title: string,
  ): Promise<CodingRuntimeDeliveryResult> {
    await resolveDraftRepository(this.options, context);
    const current = this.getOrAdopt(context);
    if (current === undefined) return unavailable("verified-commit-required");
    await assertDraftLocalCandidate(this.options, context, current.binding);
    if (this.samePrProposal(current, title)) return recorded(current);
    if (current.phase !== "pushed") return this.reconcileCurrent(context);
    const remote = await readDraftRemoteState(this.options, context, current.binding);
    assertKnownDraftIdentity(current, remote);
    if (remote.headSha !== current.binding.headSha) throw new DraftDeliveryFailure("remote-drift");
    if (remote.pullRequest !== undefined) return this.reconcileCurrent(context);
    const template = resolveDraftDeliveryTemplate({
      workspace: context.workspace,
      issueBinding: context.issueBinding,
      title,
      correlationId: context.correlationId,
      ...(this.options.execution?.activityLog === undefined
        ? {}
        : { activityLog: this.options.execution.activityLog }),
    });
    if (template.status !== "ready") throw new DraftDeliveryFailure("payload-changed");
    return this.pullRequestProposal(context, current, template.title, template.body);
  }
  private samePrProposal(record: DraftDeliveryRecord, title: string): boolean {
    if (record.phase !== "pr-proposed") return false;
    const proposal = this.review(record.proposalId);
    return proposal?.command.kind === "pr-create" && proposal.command.title === title;
  }
  private pullRequestProposal(
    context: DraftDeliveryRunContext,
    current: DraftDeliveryRecord,
    title: string,
    body: string,
  ): CodingRuntimeDeliveryResult {
    const command: GitPrCreateCommand = {
      kind: "pr-create",
      ownerAndRepo: current.binding.repository,
      headBranchName: current.binding.headRef,
      baseBranchName: current.binding.baseRef,
      title,
      body,
      isDraft: true,
      canonicalGitHubIdentity: true,
    };
    const record = proposalRecord(this.options, current.binding, command, current);
    storeDraft(this.options, context, record, current.revision);
    return this.acceptProposal(
      context,
      record,
      command,
      { record, title, body },
      record.binding.headSha,
    );
  }
  private acceptProposal(
    context: DraftDeliveryRunContext,
    record: DraftDeliveryRecord,
    command: DraftDeliveryCommand,
    review: CodingRuntimeDeliveryReview,
    expectedRemoteHead: string | undefined,
  ): CodingRuntimeDeliveryResult {
    assertDraftAuthority(context);
    this.proposal = Object.freeze({
      record,
      command: Object.freeze(command),
      review: Object.freeze(review),
      expectedRemoteHead,
      expiresAtMs: draftNow(this.options) + 300_000,
      approvalBinding: {
        projectId: context.workspace.root,
        operation: command.kind === "push" ? ("push" as const) : ("pr" as const),
        command: { binding: record.binding, command },
        runId: context.runId,
        envelopeDigest: context.envelopeDigest,
        workspaceDigest: context.workspaceDigest,
        repositoryDigest: context.repositoryDigest,
        headSha: record.binding.headSha,
        baseSha: record.binding.baseSha,
        proposalId: record.proposalId,
      },
    });
    return recorded(record);
  }
  private async executeCurrent(
    context: DraftDeliveryRunContext,
    id: string,
    lease: object | undefined,
    intent: "push" | "pull-request" | undefined,
  ): Promise<CodingRuntimeDeliveryResult> {
    const proposal = this.review(id);
    if (proposal === undefined) return unavailable("proposal-unavailable");
    if (
      intent !== undefined &&
      (proposal.command.kind === "push" ? "push" : "pull-request") !== intent
    )
      throw new DraftDeliveryFailure("approval-invalid");
    const claim = this.executionClaim(context, proposal, lease);
    if (
      draftProposalDigest(proposal.record.binding, proposal.command) !==
      proposal.record.proposalDigest
    )
      throw new DraftDeliveryFailure("payload-changed");
    if (claim.required === false && this.options.policyAllowsWithoutApproval?.() !== true)
      throw new DraftDeliveryFailure("approval-invalid");
    const current = advanceDraft(
      this.options,
      context,
      proposal.record,
      proposal.command.kind === "push" ? "pushing" : "creating-pr",
      "in-flight",
    );
    this.proposal = undefined;
    return recorded(
      await executeDraftDeliveryEffect(this.options, context, current, proposal, claim),
    );
  }
  private executionClaim(
    context: DraftDeliveryRunContext,
    proposal: PreparedDraftDelivery,
    lease: object | undefined,
  ): GitDeliveryApprovalRequirement {
    const approved = lease === undefined ? undefined : this.leases.get(lease);
    if (lease !== undefined) this.leases.delete(lease);
    if (approved?.proposal === proposal) return approved.claim;
    if (this.options.policyAllowsWithoutApproval?.() !== true)
      throw new DraftDeliveryFailure("approval-invalid");
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.draft-delivery",
      correlationId: context.correlationId,
      extra: {
        runId: context.runId,
        phase: "approval",
        reason: "policy-authorized",
        proposalId: proposal.record.proposalId,
      },
    });
    return { required: false };
  }
  private async reconcileCurrent(
    context: DraftDeliveryRunContext,
  ): Promise<CodingRuntimeDeliveryResult> {
    await resolveDraftRepository(this.options, context);
    const adopted = this.getOrAdopt(context);
    if (adopted === undefined) return unavailable("verified-commit-required");
    let current: DraftDeliveryRecord = adopted;
    await assertDraftLocalCandidate(this.options, context, current.binding);
    const remote = await readDraftRemoteState(this.options, context, current.binding);
    assertKnownDraftIdentity(current, remote);
    this.proposal = undefined;
    if (current.phase !== "recovery-required")
      current = advanceDraft(
        this.options,
        context,
        current,
        "recovery-required",
        "restart-reconciliation",
      );
    if (remote.headSha !== current.binding.headSha) return recorded(current);
    if (remote.pullRequest !== undefined && remote.pullRequest.headSha !== current.binding.headSha)
      throw new DraftDeliveryFailure("remote-drift");
    return recorded(
      advanceDraft(
        this.options,
        context,
        current,
        remote.pullRequest === undefined ? "pushed" : "draft-created",
        "completed",
        remote.pullRequest,
      ),
    );
  }
}

function sameProposal(
  current: DraftDeliveryRecord | undefined,
  value: PreparedDraftDelivery,
): boolean {
  return (
    current?.proposalId === value.record.proposalId &&
    current.proposalDigest === value.record.proposalDigest &&
    current.phase === value.record.phase
  );
}
