import { hasIssueClosingDirective } from "@oscharko-dev/keiko-contracts/runtime/issue-closing-directive";
import { readGitRawWorktreeSnapshot } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { runtimeGitReadDeps } from "./runtimeGitRead.js";
import { readVerifiedCommitReview } from "./verifiedCommitReview.js";
import { mintProposalId } from "./proposalId.js";
import type {
  VerificationReport,
  GitDeliveryApprovalClaim,
  GitDeliveryApprovalRequirement,
  GitCommitMessageValidation,
} from "@oscharko-dev/keiko-contracts";
import type {
  VerifiedCommitBinding,
  VerifiedCommitReason,
  VerifiedCommitResult,
  VerifiedCommitStatus,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { GitMutationLifecycleResult } from "@oscharko-dev/keiko-tools";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  type GitDeliveryApprovalBinding,
  type GitDeliveryIssuedApproval,
} from "./approvalStore.js";
import { executeGovernedMutation, readStagedConflictMarkerFileCountFor } from "./execution.js";
import {
  readVerifiedCommitFacts,
  sameVerifiedCommitFacts,
  verifiedCommitMessageDigest,
} from "./verifiedCommitFacts.js";
import { reconcileVerifiedCommit } from "./verifiedCommitRecovery.js";
import { commitVerificationReportPassed } from "./verifiedCommitVerification.js";
import type {
  VerifiedCommitFacts,
  VerifiedCommitProposal,
  VerifiedCommitRunContext,
  VerifiedCommitService,
  VerifiedCommitServiceOptions,
} from "./verifiedCommitTypes.js";

const TTL_MS = 5 * 60 * 1000;
interface VerificationTicket {
  readonly context: VerifiedCommitRunContext;
  readonly facts: VerifiedCommitFacts;
  readonly startedAtMs: number;
}
interface VerificationProof extends VerificationTicket {
  readonly evidenceId: string;
  readonly passed: boolean;
}

function verificationPassed(
  before: VerificationTicket,
  after: VerifiedCommitFacts,
  report: VerificationReport,
  now: number,
): boolean {
  return (
    report.workspaceRoot === before.context.workspace.root &&
    commitVerificationReportPassed(report, before.startedAtMs, now) &&
    sameVerifiedCommitFacts(before.facts, after) &&
    now - before.startedAtMs < TTL_MS
  );
}

function approvalBinding(proposal: VerifiedCommitProposal): GitDeliveryApprovalBinding {
  const b = proposal.binding;
  return {
    projectId: proposal.context.workspace.root,
    operation: "commit",
    command: proposal.command,
    ...b,
    headSha: b.parentSha,
  };
}

function contextMatches(a: VerifiedCommitRunContext, b: VerifiedCommitRunContext): boolean {
  return [
    a.runId === b.runId,
    a.envelopeDigest === b.envelopeDigest,
    a.runtimeAuthorityDigest === b.runtimeAuthorityDigest,
    a.workspace.root === b.workspace.root,
    a.baseRef === b.baseRef,
    a.headRef === b.headRef,
    a.workspaceDigest === b.workspaceDigest,
    a.repositoryDigest === b.repositoryDigest,
    a.issueBindingDigest === b.issueBindingDigest,
    a.stillAuthorized(),
    b.stillAuthorized(),
  ].every(Boolean);
}

function kernelReason(result: GitMutationLifecycleResult): VerifiedCommitReason {
  switch (result.outcome.status) {
    case "succeeded":
      return "completed";
    case "approval-required":
      return "approval-required";
    case "blocked":
      return result.outcome.category;
    case "failed":
      return "execution-failed";
    case "recovery-required":
      return "execution-uncertain";
  }
}

function kernelDetails(
  result: GitMutationLifecycleResult,
): Pick<VerifiedCommitResult, "blockReason" | "preflightFindings"> {
  if (result.outcome.status !== "blocked") return {};
  return result.outcome.category === "policy-block"
    ? { blockReason: result.outcome.blockReason }
    : { preflightFindings: result.outcome.findings };
}

// #3390: `messageAllowed` accepts a plain boolean (existing wiring) or the full validation the
// pure git-commit-policy validator already computes; only the latter carries closed violation
// codes the model can self-correct against instead of asking the operator.
function messagePolicyAllowed(value: boolean | GitCommitMessageValidation): boolean {
  return typeof value === "boolean" ? value : value.ok;
}

function messagePolicyViolationDetails(
  value: boolean | GitCommitMessageValidation,
): Pick<VerifiedCommitResult, "violations"> {
  return typeof value === "boolean" || value.ok ? {} : { violations: value.violations };
}

function guardedProposal(
  proposal: VerifiedCommitProposal,
  guard: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined } | undefined,
): VerifiedCommitProposal {
  if (guard === undefined) return proposal;
  const signals = [proposal.context.signal, guard.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return {
    ...proposal,
    context: {
      ...proposal.context,
      signal: AbortSignal.any(signals),
      stillAuthorized: () => proposal.context.stillAuthorized() && guard.check(),
    },
  };
}

function guardedVerificationContext(
  context: VerifiedCommitRunContext,
  guard: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined } | undefined,
): VerifiedCommitRunContext {
  if (guard === undefined) return context;
  const signals = [context.signal, guard.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return {
    ...context,
    signal: AbortSignal.any(signals),
    stillAuthorized: () => context.stillAuthorized() && guard.check(),
  };
}

function verificationGuardLive(
  context: VerifiedCommitRunContext,
  guard: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined } | undefined,
): boolean {
  return (
    context.stillAuthorized() &&
    context.signal?.aborted !== true &&
    guard?.signal?.aborted !== true &&
    (guard?.check() ?? true)
  );
}

class VerifiedCommitController implements VerifiedCommitService {
  private generation = 0;
  private tickets = new WeakMap<object, VerificationTicket>();
  private proof: VerificationProof | undefined;
  private readonly proposals = new Map<string, VerifiedCommitProposal>();
  private executing = false;
  private executionLeases = new WeakMap<
    object,
    { readonly proposalId: string; readonly claim: GitDeliveryApprovalRequirement }
  >();
  public constructor(private readonly options: VerifiedCommitServiceOptions) {}

  private now(): number {
    return (this.options.execution?.now ?? Date.now)();
  }
  private context(): VerifiedCommitRunContext | undefined {
    const context = this.options.context();
    const generation = this.generation;
    return context?.stillAuthorized() === true && context.signal?.aborted !== true
      ? {
          ...context,
          stillAuthorized: () => this.generation === generation && context.stillAuthorized(),
        }
      : undefined;
  }
  private facts(context: VerifiedCommitRunContext): Promise<VerifiedCommitFacts> {
    return readVerifiedCommitFacts(context, this.options.execution ?? {});
  }

  public async beginVerification(): Promise<object | undefined> {
    this.invalidate();
    const context = this.context();
    if (context === undefined) return undefined;
    const facts = await this.facts(context);
    if (!facts.clean) return undefined;
    const ticket = {};
    this.tickets.set(ticket, { context, facts, startedAtMs: this.now() });
    return ticket;
  }

  private verificationGuardLive(
    context: VerifiedCommitRunContext,
    guard: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined } | undefined,
  ): boolean {
    const live = verificationGuardLive(context, guard);
    if (!live) this.log(context, "verification-discarded", { reason: "authority-denied" });
    return live;
  }

  public async completeVerification(
    ticket: object,
    report: VerificationReport,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
  ): Promise<boolean> {
    const before = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    const context = this.context();
    if (before === undefined || context === undefined || !contextMatches(context, before.context))
      return false;
    if (!this.verificationGuardLive(context, guard)) return false;
    let after: VerifiedCommitFacts;
    try {
      after = await this.facts(guardedVerificationContext(context, guard));
    } catch (error) {
      if (!this.verificationGuardLive(context, guard)) return false;
      throw error;
    }
    if (!this.verificationGuardLive(context, guard)) return false;
    const passed = verificationPassed(before, after, report, this.now());
    const evidenceId = this.recordVerificationEvidence(context, before.facts, report);
    this.proof = { ...before, passed, evidenceId };
    this.log(context, "verification", { passed, verificationEvidenceId: evidenceId });
    return passed;
  }

  private recordVerificationEvidence(
    context: VerifiedCommitRunContext,
    facts: VerifiedCommitFacts,
    report: VerificationReport,
  ): string {
    const evidence = {
      schemaVersion: "1",
      runId: context.runId,
      workspaceDigest: context.workspaceDigest,
      candidate: facts,
      startedAtMs: report.startedAtMs,
      durationMs: report.durationMs,
      status: report.overallStatus,
      commands: report.results.map((result) => ({
        kind: result.kind,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        outputDigest: sha256Hex(result.outputSummary),
        commandDigest: sha256Hex(canonicalise([result.command, result.args])),
      })),
    };
    const evidenceId = `verification-${sha256Hex(canonicalise(evidence)).slice(0, 40)}`;
    this.options.mutationDeps.evidenceStore.put(evidenceId, JSON.stringify(evidence));
    return evidenceId;
  }

  public async propose(message: string): Promise<VerifiedCommitResult | undefined> {
    const context = this.context();
    if (context === undefined) return undefined;
    const facts = await this.facts(context);
    const binding = this.binding(context, facts, message);
    const verification = this.proof;
    if (verification?.passed !== true)
      return this.record(context, binding, "verification-failed", "verification-missing");
    if (
      !contextMatches(context, verification.context) ||
      !sameVerifiedCommitFacts(verification.facts, facts) ||
      this.now() - verification.startedAtMs >= TTL_MS
    )
      return this.record(context, binding, "drift", "verification-stale");
    const messagePolicy = await this.options.messageAllowed(message, context.workspace);
    if (!messagePolicyAllowed(messagePolicy))
      return this.record(
        context,
        binding,
        "blocked",
        "message-policy",
        undefined,
        messagePolicyViolationDetails(messagePolicy),
      );
    if (hasIssueClosingDirective(message))
      return this.record(context, binding, "blocked", "issue-directive");
    return this.prepareProposal(context, facts, binding, message);
  }

  private async prepareProposal(
    context: VerifiedCommitRunContext,
    facts: VerifiedCommitFacts,
    binding: VerifiedCommitBinding,
    message: string,
  ): Promise<VerifiedCommitResult> {
    const awaiting = this.result(binding, "approval-required", "approval-required");
    const review = await readVerifiedCommitReview(
      context,
      awaiting,
      message,
      this.options.execution ?? {},
    );
    if (review === undefined) return this.record(context, binding, "blocked", "review-incomplete");
    const afterReview = await this.facts(context);
    if (!sameVerifiedCommitFacts(facts, afterReview))
      return this.record(context, binding, "drift", "candidate-drift");
    const proposal: VerifiedCommitProposal = {
      binding,
      review,
      context,
      expiresAtMs: this.now() + TTL_MS,
      command: {
        kind: "commit",
        message,
        allowEmpty: false,
        verified: {
          headSha: facts.headSha,
          stagedTreeDigest: facts.stagedTreeDigest,
          branchName: context.headRef,
          baseRef: context.baseRef,
          baseSha: facts.baseSha,
        },
      },
    };
    this.proposals.clear();
    this.proposals.set(binding.proposalId, proposal);
    return this.record(context, binding, "approval-required", "approval-required");
  }

  private binding(
    context: VerifiedCommitRunContext,
    facts: VerifiedCommitFacts,
    message: string,
  ): VerifiedCommitBinding {
    return {
      proposalId: mintProposalId("commit"),
      runId: context.runId,
      envelopeDigest: context.envelopeDigest,
      runtimeAuthorityDigest: context.runtimeAuthorityDigest,
      workspaceDigest: context.workspaceDigest,
      repositoryDigest: facts.repositoryDigest,
      baseSha: facts.baseSha,
      parentSha: facts.headSha,
      stagedTreeDigest: facts.stagedTreeDigest,
      verificationEvidenceId: this.proof?.evidenceId ?? "verification-unavailable",
      messageDigest: verifiedCommitMessageDigest(message),
      ...(context.issueBindingDigest === undefined
        ? {}
        : { issueBindingDigest: context.issueBindingDigest }),
    };
  }

  public review(proposalId: string): VerifiedCommitProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    const context = this.context();
    return proposal !== undefined &&
      context !== undefined &&
      this.now() < proposal.expiresAtMs &&
      contextMatches(context, proposal.context)
      ? proposal
      : undefined;
  }

  public async approve(proposalId: string): Promise<GitDeliveryApprovalClaim | undefined> {
    const proposal = this.review(proposalId);
    if (proposal === undefined || !(await this.current(proposal))) return undefined;
    return this.issueApproval(proposalId)?.approval;
  }

  public issueApproval(proposalId: string): GitDeliveryIssuedApproval | undefined {
    const proposal = this.review(proposalId);
    if (proposal === undefined) return undefined;
    const issued = (
      this.options.execution?.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE
    ).issue({
      binding: approvalBinding(proposal),
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: this.now(),
      ttlMs: proposal.expiresAtMs - this.now(),
    });
    this.log(proposal.context, "approval", { proposalId, state: "issued" });
    return issued;
  }

  public matchesApproval(proposalId: string, approval?: GitDeliveryApprovalClaim): boolean {
    const proposal = this.review(proposalId);
    if (proposal === undefined) return false;
    const store = this.options.execution?.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    return approval === undefined
      ? store.matchesCommitBinding(approvalBinding(proposal), this.now())
      : store.matches({ approval, binding: approvalBinding(proposal), nowMs: this.now() });
  }

  public consumeApproval(
    proposalId: string,
    approval?: GitDeliveryApprovalClaim,
  ): object | undefined {
    const proposal = this.review(proposalId);
    if (proposal === undefined) return undefined;
    const store = this.options.execution?.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    const claim =
      approval === undefined
        ? store.consumeCommitBinding(approvalBinding(proposal), this.now())
        : store.consume({ approval, binding: approvalBinding(proposal), nowMs: this.now() });
    if (claim?.required !== true) return undefined;
    const lease = {};
    this.executionLeases.set(lease, { proposalId, claim });
    this.log(proposal.context, "approval", { proposalId, state: "consumed" });
    return lease;
  }

  public async executeApproved(
    proposalId: string,
    lease: object,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
  ): Promise<VerifiedCommitResult | undefined> {
    const consumed = this.executionLeases.get(lease);
    this.executionLeases.delete(lease);
    const proposal = this.review(proposalId);
    if (consumed?.proposalId !== proposalId || proposal === undefined || this.executing)
      return undefined;
    this.executing = true;
    const governed = guardedProposal(proposal, guard);
    try {
      return await this.executeConsumed(governed, consumed.claim);
    } catch (error) {
      return this.admissionFailure(governed, error);
    } finally {
      this.executing = false;
    }
  }

  private async current(proposal: VerifiedCommitProposal): Promise<boolean> {
    const facts = await this.facts(proposal.context);
    return (
      facts.clean &&
      facts.headSha === proposal.binding.parentSha &&
      facts.baseSha === proposal.binding.baseSha &&
      facts.stagedTreeDigest === proposal.binding.stagedTreeDigest &&
      facts.repositoryDigest === proposal.binding.repositoryDigest
    );
  }

  public async execute(
    proposalId: string,
    approval: GitDeliveryApprovalClaim | undefined,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal | undefined },
  ): Promise<VerifiedCommitResult | undefined> {
    const proposal = this.review(proposalId);
    if (proposal === undefined || this.executing) return undefined;
    this.executing = true;
    const governed = guardedProposal(proposal, guard);
    try {
      return await this.executeOne(governed, approval);
    } catch (error) {
      return this.admissionFailure(governed, error);
    } finally {
      this.executing = false;
    }
  }

  private admissionFailure(proposal: VerifiedCommitProposal, error: unknown): VerifiedCommitResult {
    this.log(proposal.context, "execute", { state: "failed", ...describeError(error) }, true);
    return this.contextIsCurrent(proposal.context)
      ? this.record(proposal.context, proposal.binding, "failed", "execution-failed")
      : this.record(proposal.context, proposal.binding, "blocked", "authority-denied");
  }

  // #3384 audit batch 5 item 4 / security review (head 02785dbd): every pre-commit validation that
  // can legitimately BLOCK the commit (staged-tree digest match/drift, unresolved conflict
  // markers) must run before the one-use commit approval is spent — mirrors commitRoutes.ts's own
  // HTTP execute route (message policy, then `conflictMarkerBlockResult`, only THEN
  // `resolveGitDeliveryApprovalRequirement` consumes). A block found here leaves the approval, and
  // the proposal, untouched so the SAME approval can still redeem the SAME proposal once the
  // legitimate blocker clears — no forced re-propose/re-approve round trip for a false block.
  private async preflightBlock(
    proposal: VerifiedCommitProposal,
  ): Promise<VerifiedCommitResult | undefined> {
    const { context, binding } = proposal;
    if (!(await this.current(proposal)))
      return this.record(context, binding, "drift", "candidate-drift");
    const seams = this.options.execution ?? {};
    const markers = await readStagedConflictMarkerFileCountFor(
      context.workspace,
      seams,
      () => this.now(),
      context.correlationId,
    );
    return markers > 0 ? this.record(context, binding, "blocked", "conflict-markers") : undefined;
  }

  private async executeOne(
    proposal: VerifiedCommitProposal,
    approval: GitDeliveryApprovalClaim | undefined,
  ): Promise<VerifiedCommitResult> {
    const { context, binding } = proposal;
    const blocked = await this.preflightBlock(proposal);
    if (blocked !== undefined) return blocked;
    const lease = this.consumeApproval(binding.proposalId, approval);
    const claim = lease === undefined ? undefined : this.executionLeases.get(lease)?.claim;
    if (lease !== undefined) this.executionLeases.delete(lease);
    if (claim === undefined) return this.record(context, binding, "blocked", "approval-invalid");
    return this.executeConsumed(proposal, claim);
  }

  private async executeConsumed(
    proposal: VerifiedCommitProposal,
    claim: GitDeliveryApprovalRequirement,
  ): Promise<VerifiedCommitResult> {
    const { context, binding } = proposal;
    // Re-checked here (not only in executeOne) because executeApproved's already-consumed lease
    // reaches this method directly — this is that path's only preflight, and a race between the
    // caller's own checks and this call still gets one last live look before the effect.
    const blocked = await this.preflightBlock(proposal);
    if (blocked !== undefined) return blocked;
    this.proposals.delete(binding.proposalId);
    this.proof = undefined;
    // Review finding (comment 3941793530, #3384 audit): the write-ahead recovery-required marker
    // is a hard PRECONDITION of the Git mutation, not a best-effort log line. Previously this
    // called `record()` and discarded its result, so a persistence failure here still fell through
    // to `mutate()` — the commit could land with no durable recovery-required receipt for
    // `reconcile()` to find after a crash. Now a failed write-ahead persist stops before the
    // effect and returns the closed result directly; the approval stays spent, same as any other
    // post-preflight block (no restore/re-issue — it is already a one-use claim).
    const notRecorded = this.recordWriteAhead(context, binding);
    if (notRecorded !== undefined) return notRecorded;
    return await this.mutate(proposal, claim);
  }

  private recordWriteAhead(
    context: VerifiedCommitRunContext,
    binding: VerifiedCommitBinding,
  ): VerifiedCommitResult | undefined {
    const result = this.result(binding, "recovery-required", "execution-uncertain");
    if (
      !this.persist(
        context,
        binding,
        "recovery-required",
        "execution-uncertain",
        result,
        "pre-effect",
      )
    )
      return result;
    this.log(context, "result", {
      state: "recovery-required",
      reason: "execution-uncertain",
      proposalId: binding.proposalId,
      stagedTreeDigest: binding.stagedTreeDigest,
    });
    return undefined;
  }

  private async mutate(
    proposal: VerifiedCommitProposal,
    claim: GitDeliveryApprovalRequirement,
  ): Promise<VerifiedCommitResult> {
    const { context, binding } = proposal;
    try {
      const result = await executeGovernedMutation(
        proposal.command,
        claim,
        context.workspace,
        this.options.mutationDeps,
        {
          ...this.options.execution,
          signal: context.signal,
          beforeCommitRefUpdate: () => this.contextIsCurrent(context),
          snapshotReader: () =>
            readGitRawWorktreeSnapshot(runtimeGitReadDeps(context, this.options.execution ?? {})),
        },
        context.correlationId,
      );
      const headSha =
        result.outcome.status === "succeeded"
          ? result.outcome.executionResult.externalId
          : undefined;
      if (result.outcome.status === "succeeded" && headSha === undefined)
        return this.record(context, binding, "recovery-required", "execution-uncertain");
      return this.record(
        context,
        binding,
        result.outcome.status,
        kernelReason(result),
        headSha,
        kernelDetails(result),
      );
    } catch (error) {
      this.log(context, "execute", { state: "failed", ...describeError(error) }, true);
      return this.record(context, binding, "recovery-required", "execution-uncertain");
    }
  }

  private contextIsCurrent(context: VerifiedCommitRunContext): boolean {
    const current = this.context();
    return current !== undefined && contextMatches(current, context);
  }

  private record(
    context: VerifiedCommitRunContext,
    binding: VerifiedCommitBinding,
    status: VerifiedCommitStatus,
    reason: VerifiedCommitReason,
    headSha?: string,
    details: Pick<VerifiedCommitResult, "blockReason" | "preflightFindings" | "violations"> = {},
  ): VerifiedCommitResult {
    const result = this.result(binding, status, reason, headSha, details);
    if (!this.persist(context, binding, status, reason, result))
      return this.result(binding, "recovery-required", "execution-uncertain");
    this.log(context, "result", {
      state: status,
      reason,
      proposalId: binding.proposalId,
      stagedTreeDigest: binding.stagedTreeDigest,
      ...(result.violations === undefined
        ? {}
        : { violations: result.violations, violationCount: result.violations.length }),
    });
    return result;
  }

  // #3384 audit batch 5 item 5 / security review (head 02785dbd): a `VerifiedCommitBinding` is
  // frozen at propose time (runtime-authority/workspace digests captured once); today nothing
  // mutates those columns post-insert, so a stale-proposal persistence failure is latent, but a
  // throw from `snapshots.recordVerifiedCommit` must never escape `record()` uncaught — every
  // caller (including the recovery path inside `mutate`'s catch block and `admissionFailure`)
  // relies on `record()` never throwing. Fails closed to a recovery-required result instead of an
  // unhandled rejection out of execute()/executeApproved(), with a body-free diagnostic line
  // (existing catalogued `op`, closed `errorKind`, the run's correlationId) an operator can read
  // from the activity log per AGENTS.md §8.
  //
  // `effectPhase` (review finding, comment 3941793530) distinguishes, in that same log line,
  // whether the failed write was `recordWriteAhead`'s pre-effect marker — where the caller must
  // treat `false` as a hard stop, since the Git mutation has not run yet and never will for this
  // attempt — from every other, post-effect call (a terminal result after the mutation ran, a
  // pre-mutation block/drift, or a `reconcile()` receipt): those already fail closed to
  // recovery-required and the mutation, if any, has already happened.
  private persist(
    context: VerifiedCommitRunContext,
    binding: VerifiedCommitBinding,
    status: VerifiedCommitStatus,
    reason: VerifiedCommitReason,
    result: VerifiedCommitResult,
    effectPhase: "pre-effect" | "post-effect" = "post-effect",
  ): boolean {
    try {
      this.options.snapshots.recordVerifiedCommit(result);
      return true;
    } catch (error) {
      this.log(
        context,
        "persist-failed",
        {
          proposalId: binding.proposalId,
          attemptedStatus: status,
          attemptedReason: reason,
          effectPhase,
          ...describeError(error),
        },
        true,
      );
      return false;
    }
  }

  private result(
    binding: VerifiedCommitBinding,
    status: VerifiedCommitStatus,
    reason: VerifiedCommitReason,
    headSha?: string,
    details: Pick<VerifiedCommitResult, "blockReason" | "preflightFindings" | "violations"> = {},
  ): VerifiedCommitResult {
    return {
      schemaVersion: "1",
      ...binding,
      ...details,
      status,
      reason,
      recordedAt: new Date(this.now()).toISOString(),
      ...(headSha === undefined ? {} : { headSha, committedTreeDigest: binding.stagedTreeDigest }),
    };
  }

  private log(
    context: VerifiedCommitRunContext,
    phase: string,
    extra: Readonly<Record<string, unknown>>,
    failed = false,
  ): void {
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.verified-commit",
      correlationId: context.correlationId,
      ...(failed ? ({ level: "warn", errorKind: "internal" } as const) : {}),
      extra: { phase, runId: context.runId, ...extra },
    });
  }

  public invalidate(): void {
    this.generation += 1;
    this.executionLeases = new WeakMap();
    this.tickets = new WeakMap();
    this.proof = undefined;
    this.proposals.clear();
  }

  public async reconcile(): Promise<VerifiedCommitResult | undefined> {
    const context = this.context();
    if (context === undefined) return undefined;
    const receipt = this.options.snapshots.get(context.runId)?.verifiedCommitResult;
    if (receipt?.status !== "recovery-required") return receipt;
    const recovered = await reconcileVerifiedCommit(receipt, context, this.options.execution ?? {});
    // Same fail-closed persistence guard as `record()` (#3384 audit batch 5 item 5): a frozen
    // binding whose reconciled outcome can no longer be persisted must not throw out of a public
    // API — it degrades to the same closed recovery-required result instead.
    if (!this.persist(context, recovered, recovered.status, recovered.reason, recovered))
      return this.result(recovered, "recovery-required", "execution-uncertain");
    this.log(context, "reconcile", { state: recovered.status, proposalId: recovered.proposalId });
    return recovered;
  }
}

export function createVerifiedCommitService(
  options: VerifiedCommitServiceOptions,
): VerifiedCommitService {
  return new VerifiedCommitController(options);
}
