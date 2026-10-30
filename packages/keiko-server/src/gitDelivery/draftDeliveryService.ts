import type {
  CodingRuntimeDeliveryResult,
  CodingRuntimeDeliveryReview,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import {
  isDraftDeliveryBranchBinding,
  isDraftDeliveryIssueBinding,
  isDraftDeliveryPullRequestBinding,
  isDraftDeliveryRepositoryBinding,
  type DraftDeliveryBinding,
  type DraftDeliveryBranchBinding,
  type DraftDeliveryIssueBinding,
  type DraftDeliveryPullRequestBinding,
  type DraftDeliveryRecord,
  type DraftDeliveryRepositoryBinding,
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
  isGitHubOriginContext,
  isIssueBoundContext,
  type IssueBoundDraftDeliveryRunContext,
  type PreparedDraftDelivery,
  type DraftDeliveryRunContext,
  type DraftDeliveryService,
  type DraftDeliveryServiceOptions,
} from "./draftDeliveryTypes.js";
import {
  assertDraftAuthority,
  assertDraftBranchTarget,
  assertDraftLocalCandidate,
  assertKnownDraftIdentity,
  initialBranchBinding,
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
  logDraftDeliveryActivity,
  type DraftDeliveryCommand,
} from "./draftDeliveryLedger.js";
import { resolveDraftDeliveryTemplate } from "./draftDeliveryTemplate.js";
import { readDraftDeliveryChecks } from "./draftDeliveryChecks.js";
import { executeDraftDeliveryEffect } from "./draftDeliveryEffects.js";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorKindOf } from "@oscharko-dev/keiko-activity-log";
import { gitDeliveryActivityErrorKind } from "./execution.js";
import { logDraftRelatedIssues } from "./draftRelatedIssuesActivity.js";
import { correlationIdOrUnknown, UNKNOWN_CORRELATION_ID } from "../correlation.js";

type DeliveryUnavailableReason = Extract<
  CodingRuntimeDeliveryResult,
  { status: "unavailable" }
>["reason"];

interface DeliveryGuard {
  readonly check: () => boolean;
  readonly intent?: "push" | "pull-request" | undefined;
  readonly signal?: AbortSignal | undefined;
}
function recorded(record: DraftDeliveryRecord): CodingRuntimeDeliveryResult {
  return { status: "recorded", record };
}
function unavailable(reason: DeliveryUnavailableReason): CodingRuntimeDeliveryResult {
  return { status: "unavailable", reason };
}
// A binding of the other delivery kind than the run's own never carries over: an issue-bound run
// opens a pull request for its issue, an issue-free run on a github.com origin opens one for its
// task branch, and an issue-free run on any other remote pushes its branch only.
function issueBindingOf(binding: DraftDeliveryBinding): DraftDeliveryIssueBinding {
  if (!isDraftDeliveryIssueBinding(binding)) throw new DraftDeliveryFailure("remote-drift");
  return binding;
}
function pullRequestBindingOf(binding: DraftDeliveryBinding): DraftDeliveryPullRequestBinding {
  if (!isDraftDeliveryPullRequestBinding(binding)) throw new DraftDeliveryFailure("remote-drift");
  return binding;
}
function branchBindingOf(
  binding: DraftDeliveryBinding,
): DraftDeliveryBranchBinding | DraftDeliveryRepositoryBinding {
  if (isDraftDeliveryIssueBinding(binding)) throw new DraftDeliveryFailure("remote-drift");
  return binding;
}
// An issue-free run's pull request needs a forge: no `origin` at all and a foreign `origin` are
// different truths, and neither is "no issue" (ADR-0086 D13).
function pullRequestOriginRefusal(
  context: DraftDeliveryRunContext,
): "remote-required" | "github-origin-required" | undefined {
  if (isIssueBoundContext(context) || isGitHubOriginContext(context)) return undefined;
  return context.repositoryKind === "local" ? "remote-required" : "github-origin-required";
}
// The remote phases of an issue-free GitHub run (a pull request proposed, created or delivered) are
// reconciled against the provider like an issue-bound run's; its push phases carry no remote fact.
function carriesPullRequest(record: DraftDeliveryRecord | undefined): boolean {
  return (
    record !== undefined &&
    isDraftDeliveryRepositoryBinding(record.binding) &&
    (record.pullRequest !== undefined ||
      record.phase === "pr-proposed" ||
      record.phase === "creating-pr" ||
      record.phase === "draft-created")
  );
}
// A new proposal on an existing record keeps that record's recovery identity.
function withPriorRecovery(
  source: DraftDeliveryBinding,
  prior: DraftDeliveryRecord | undefined,
): DraftDeliveryBinding {
  return prior === undefined ? source : { ...source, recoveryId: prior.binding.recoveryId };
}
function deliveryAction(proposal: PreparedDraftDelivery): "push" | "pull-request" {
  return proposal.command.kind === "push" ? "push" : "pull-request";
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
  public reconcileForObservation(): Promise<CodingRuntimeDeliveryResult> {
    return this.run((context) => this.reconcileObservationCurrent(context));
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
    if (context === undefined) return this.contextRefusal();
    if (this.busy) return this.busyRefusal(context);
    this.busy = true;
    try {
      assertDraftAuthority(context);
      return this.loggedRefusal(context, await work(context));
    } catch (error) {
      return this.failure(context, error);
    } finally {
      this.busy = false;
    }
  }
  // The run has no verified delivery context (`repository-required`), or the caller's guard no
  // longer holds (`authority-denied`). Both used to answer one bare refusal with no log line, so the
  // model saw no cause and invented one (Coding Workbench live lab, 2026-10-30).
  private contextRefusal(): CodingRuntimeDeliveryResult {
    const live = this.options.context();
    const reason = live === undefined ? "repository-required" : "authority-denied";
    this.logRefusal(
      live?.correlationId ?? correlationIdOrUnknown(this.options.runId),
      live?.runId ?? this.options.runId ?? UNKNOWN_CORRELATION_ID,
      reason,
    );
    return unavailable(reason);
  }
  private loggedRefusal(
    context: DraftDeliveryRunContext,
    result: CodingRuntimeDeliveryResult,
  ): CodingRuntimeDeliveryResult {
    if (result.status === "unavailable")
      this.logRefusal(context.correlationId, context.runId, result.reason);
    return result;
  }
  private logRefusal(
    correlationId: string,
    runId: string,
    reason: DeliveryUnavailableReason,
  ): void {
    logDraftDeliveryActivity(
      this.options,
      correlationId,
      { runId, phase: "refused", reason },
      { errorKind: reason === "authority-denied" ? "authority-denied" : "unavailable" },
    );
  }
  private busyRefusal(context: DraftDeliveryRunContext): CodingRuntimeDeliveryResult {
    logDraftDeliveryActivity(
      this.options,
      context.correlationId,
      { runId: context.runId, phase: "refused", reason: "operation-in-flight" },
      { errorKind: "conflict" },
    );
    return unavailable("operation-in-flight");
  }
  private failure(context: DraftDeliveryRunContext, error: unknown): CodingRuntimeDeliveryResult {
    this.proposal = undefined;
    const reason = error instanceof DraftDeliveryFailure ? error.reason : "provider-failed";
    const failureKind = errorKindOf(error);
    const detail = describeError(error);
    logDraftDeliveryActivity(
      this.options,
      context.correlationId,
      {
        runId: context.runId,
        phase: "failed",
        reason,
        failureKind,
        errorClass: detail.errorClass,
        ...(detail.code === undefined ? {} : { code: detail.code }),
        ...(detail.frames === undefined ? {} : { frames: detail.frames }),
        ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
      },
      { errorKind: gitDeliveryActivityErrorKind(failureKind) },
    );
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
  private preparePush(context: DraftDeliveryRunContext): Promise<CodingRuntimeDeliveryResult> {
    return isIssueBoundContext(context)
      ? this.prepareIssuePush(context)
      : this.prepareBranchPush(context);
  }
  private async prepareIssuePush(
    context: IssueBoundDraftDeliveryRunContext,
  ): Promise<CodingRuntimeDeliveryResult> {
    const repository = await resolveDraftRepository(this.options, context);
    const prior = this.getOrAdopt(context);
    if (prior?.phase === "pushing" || prior?.phase === "creating-pr")
      return this.reconcileCurrent(context);
    const source = initialDraftBinding(this.options, context, repository) ?? prior?.binding;
    if (source === undefined) return unavailable("verified-commit-required");
    return this.proposeVerifiedPush(
      context,
      issueBindingOf(withPriorRecovery(source, prior)),
      prior,
    );
  }
  // An issue-free run pushes its verified commit to its own task branch on `origin`, which may be
  // any Git remote (ADR-0085 D1b). No GitHub fact is read for the push: the only remote evidence is
  // the non-force push itself; `origin` is re-verified here and again right before the effect. On a
  // verified github.com origin the binding also names the repository, so the pull request that may
  // follow shares this record (ADR-0086 D13).
  private async prepareBranchPush(
    context: DraftDeliveryRunContext,
  ): Promise<CodingRuntimeDeliveryResult> {
    if (context.repositoryKind === "local") return unavailable("remote-required");
    const live = await assertDraftBranchTarget(this.options, context);
    const prior = this.getOrAdopt(context);
    if (prior?.phase === "pushing") return this.reconcileCurrent(context);
    const repository = this.branchRepository(context, live, prior);
    const source = initialBranchBinding(this.options, context, repository) ?? prior?.binding;
    if (source === undefined) return unavailable("verified-commit-required");
    return this.proposeVerifiedPush(
      context,
      branchBindingOf(withPriorRecovery(source, prior)),
      prior,
    );
  }
  // The shared tail of both push kinds: the exact local candidate, then a retained or a new proposal.
  private async proposeVerifiedPush(
    context: DraftDeliveryRunContext,
    binding: DraftDeliveryBinding,
    prior: DraftDeliveryRecord | undefined,
  ): Promise<CodingRuntimeDeliveryResult> {
    await assertDraftLocalCandidate(this.options, context, binding);
    const retained = this.retainedPushProposal(context, binding, prior);
    if (retained !== undefined) return retained;
    return this.pushProposal(context, binding, prior);
  }
  // A stored target never changes kind, so a record that already exists keeps the kind it was born
  // with; a new one is bound to the repository exactly when `origin` is a verified github.com one.
  private branchRepository(
    context: DraftDeliveryRunContext,
    live: string | undefined,
    prior: DraftDeliveryRecord | undefined,
  ): string | undefined {
    if (prior !== undefined)
      return isDraftDeliveryRepositoryBinding(prior.binding) ? prior.binding.repository : undefined;
    if (context.repositoryKind !== "github-origin") return undefined;
    if (live === undefined) throw new DraftDeliveryFailure("remote-drift");
    return live;
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
    if (!isDraftDeliveryIssueBinding(binding))
      return this.acceptProposal(context, record, command, { record }, undefined);
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
    // A pull request needs a verified GitHub repository, never an issue: an accepted issue only
    // links it (ADR-0086 D13). Its head is the run's task branch and its base the branch the task was
    // cut from; an issue-bound run additionally takes its closing line from the accepted issue.
    const refusal = pullRequestOriginRefusal(context);
    if (refusal !== undefined) return unavailable(refusal);
    await resolveDraftRepository(this.options, context);
    const current = this.getOrAdopt(context);
    if (current === undefined) return unavailable("verified-commit-required");
    // A branch-push record was bound before this run's origin was known to be GitHub (it predates
    // repository bindings) and cannot become a pull request's record without changing its target.
    if (isDraftDeliveryBranchBinding(current.binding)) return unavailable("proposal-unavailable");
    const binding = pullRequestBindingOf(current.binding);
    await assertDraftLocalCandidate(this.options, context, binding);
    if (this.samePrProposal(current, title)) return recorded(current);
    if (current.phase !== "pushed") return this.reconcileCurrent(context);
    const remote = await readDraftRemoteState(this.options, context, binding);
    assertKnownDraftIdentity(current, remote);
    if (remote.headSha !== binding.headSha) throw new DraftDeliveryFailure("remote-drift");
    if (remote.pullRequest !== undefined) return this.reconcileCurrent(context);
    const template = await this.composeTemplate(context, current, title);
    if (template.status !== "ready") throw new DraftDeliveryFailure("payload-changed");
    return this.pullRequestProposal(context, current, binding, template.title, template.body);
  }
  // The server-owned body: the authored template, the closing line for the bound issue (an
  // issue-free run has none), the epic's resolved children as a non-closing related-issue line (run
  // 19, 2026-09-10) and the checks the run's verification evidence records for the committed change
  // (F57, run 28).
  private async composeTemplate(
    context: DraftDeliveryRunContext,
    record: DraftDeliveryRecord,
    title: string,
  ): Promise<ReturnType<typeof resolveDraftDeliveryTemplate>> {
    const relatedIssueNumbers = isIssueBoundContext(context)
      ? await this.relatedIssues(context)
      : [];
    const activityLog = this.options.execution?.activityLog;
    const verificationChecks = readDraftDeliveryChecks({
      snapshots: this.options.snapshots,
      evidenceStore: this.options.mutationDeps.evidenceStore,
      record,
      correlationId: context.correlationId,
      activityLog: activityLog ?? processServerLogSink(),
    });
    return resolveDraftDeliveryTemplate({
      workspace: context.workspace,
      issueBinding: context.issueBinding,
      relatedIssueNumbers,
      verificationChecks,
      title,
      correlationId: context.correlationId,
      ...(activityLog === undefined ? {} : { activityLog }),
    });
  }
  // Best effort by the port's contract: a resolver that rejects omits the related-issue line and
  // never refuses the delivery. Enforced here, at the one boundary every composition passes
  // (CodeRabbit review on PR #3452); the failure is logged body-free under the resolver's own op.
  private async relatedIssues(
    context: IssueBoundDraftDeliveryRunContext,
  ): Promise<readonly number[]> {
    try {
      return (await this.options.resolveRelatedIssues?.(context)) ?? [];
    } catch (error) {
      const failureKind = errorKindOf(error);
      const detail = describeError(error);
      logDraftRelatedIssues(
        this.options.execution?.activityLog ?? processServerLogSink(),
        context,
        {
          state: "unavailable",
          count: 0,
          errorKind: gitDeliveryActivityErrorKind(failureKind),
          failureKind,
          errorClass: detail.errorClass,
          ...(detail.code === undefined ? {} : { code: detail.code }),
          ...(detail.frames === undefined ? {} : { frames: detail.frames }),
          ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
        },
      );
      return [];
    }
  }
  private samePrProposal(record: DraftDeliveryRecord, title: string): boolean {
    if (record.phase !== "pr-proposed") return false;
    const proposal = this.review(record.proposalId);
    return proposal?.command.kind === "pr-create" && proposal.command.title === title;
  }
  private pullRequestProposal(
    context: DraftDeliveryRunContext,
    current: DraftDeliveryRecord,
    binding: DraftDeliveryPullRequestBinding,
    title: string,
    body: string,
  ): CodingRuntimeDeliveryResult {
    const command: GitPrCreateCommand = {
      kind: "pr-create",
      ownerAndRepo: binding.repository,
      headBranchName: binding.headRef,
      baseBranchName: binding.baseRef,
      title,
      body,
      isDraft: true,
      canonicalGitHubIdentity: true,
      // #3394 review, finding 2 / §0.2: `verifiedCommitSha` is now mandatory on `GitPrCreateCommand`.
      // By the time this runs, `preparePullRequest` has already asserted `current.phase === "pushed"`
      // and `remote.headSha === current.binding.headSha` (throwing `DraftDeliveryFailure` otherwise a
      // few lines above), so `current.binding.headSha` is already the live, drift-checked head of the
      // branch this PR proposes to open — safe and correct to pin here.
      verifiedCommitSha: binding.headSha,
    };
    const record = proposalRecord(this.options, binding, command, current);
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
    if (
      !claim.required &&
      this.options.policyAllowsWithoutApproval?.(deliveryAction(proposal)) !== true
    )
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
    if (this.options.policyAllowsWithoutApproval?.(deliveryAction(proposal)) !== true)
      throw new DraftDeliveryFailure("approval-invalid");
    logDraftDeliveryActivity(this.options, context.correlationId, {
      runId: context.runId,
      phase: "approval",
      reason: "policy-authorized",
      proposalId: proposal.record.proposalId,
    });
    return { required: false };
  }
  private async reconcileCurrent(
    context: DraftDeliveryRunContext,
  ): Promise<CodingRuntimeDeliveryResult> {
    if (!isIssueBoundContext(context) && !carriesPullRequest(currentDraft(this.options, context)))
      return this.reconcileBranch(context);
    await resolveDraftRepository(this.options, context);
    const adopted = this.getOrAdopt(context);
    if (adopted === undefined) return unavailable("verified-commit-required");
    return this.reconcileRecord(context, adopted);
  }
  // A branch push has no remote record to read back: the pinned, non-force push is the only effect
  // and it either exited 0 or did not. An attempt that was interrupted is settled as recovery, and a
  // fresh proposal re-pushes the same exact commit, which Git answers as already up to date.
  private reconcileBranch(context: DraftDeliveryRunContext): CodingRuntimeDeliveryResult {
    const adopted = this.getOrAdopt(context);
    if (adopted === undefined) return unavailable("verified-commit-required");
    branchBindingOf(adopted.binding);
    this.proposal = undefined;
    if (adopted.phase === "pushed" || adopted.phase === "recovery-required")
      return recorded(adopted);
    return recorded(
      advanceDraft(this.options, context, adopted, "recovery-required", "restart-reconciliation"),
    );
  }
  private async reconcileObservationCurrent(
    context: DraftDeliveryRunContext,
  ): Promise<CodingRuntimeDeliveryResult> {
    // CI observation follows a delivered pull request of an issue-bound run: its journey, readiness
    // and repair budget are keyed to the accepted issue. A pull request opened without one is
    // delivered but not observed (ADR-0086 D13).
    if (!isIssueBoundContext(context)) return unavailable("issue-binding-required");
    const existing = currentDraft(this.options, context);
    if (existing !== undefined && existing.phase !== "recovery-required")
      return unavailable("proposal-unavailable");
    const adopted = existing ?? adoptDraftPredecessor(this.options, context);
    if (adopted === undefined) return unavailable("verified-commit-required");
    const stillAdopted = (): boolean =>
      sameDraftRecord(currentDraft(this.options, context), adopted);
    try {
      await resolveDraftRepository(this.options, context);
      return await this.reconcileRecord(context, adopted, stillAdopted);
    } catch (error) {
      if (!stillAdopted()) return unavailable("proposal-unavailable");
      throw error;
    }
  }
  private async reconcileRecord(
    context: DraftDeliveryRunContext,
    adopted: DraftDeliveryRecord,
    stillCurrent: () => boolean = (): boolean => true,
  ): Promise<CodingRuntimeDeliveryResult> {
    if (!stillCurrent()) return unavailable("proposal-unavailable");
    let current = adopted;
    // Reconciliation observes an already bound remote effect. Local repairs may be ahead or
    // uncommitted; proposal and execution paths still verify their exact local candidate.
    const remote = await readDraftRemoteState(
      this.options,
      context,
      pullRequestBindingOf(current.binding),
    );
    if (!stillCurrent()) return unavailable("proposal-unavailable");
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

function sameDraftRecord(
  current: DraftDeliveryRecord | undefined,
  expected: DraftDeliveryRecord,
): boolean {
  return (
    current?.revision === expected.revision &&
    current.proposalId === expected.proposalId &&
    current.proposalDigest === expected.proposalDigest &&
    current.phase === expected.phase
  );
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
