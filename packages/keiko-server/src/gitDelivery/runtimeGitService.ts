import type {
  CodingRuntimeGitResult,
  CodingRuntimeGitStage,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimePendingApprovalReview,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import { isCodingRuntimeGitResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import {
  readGitStageCandidate,
  readGitStageSupport,
  readGitRawWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitStageCommand } from "@oscharko-dev/keiko-tools";
import { readVerifiedCommitFacts } from "./verifiedCommitFacts.js";
import { mintProposalId } from "./proposalId.js";
import type {
  VerifiedCommitRunContext,
  VerifiedCommitServiceOptions,
} from "./verifiedCommitTypes.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  type GitDeliveryApprovalBinding,
  type GitDeliveryIssuedApproval,
} from "./approvalStore.js";
import { executeGovernedMutation } from "./execution.js";
import {
  admitStageSelection,
  reviewStageSelection,
  runtimeGitDiff,
  runtimeGitStatus,
  runtimeGitReadDeps,
  runtimeWorkspaceFs,
  type StageSelectionReview,
} from "./runtimeGitRead.js";
import {
  snapshotRuntimeGitRequest,
  type RuntimeGitRequest,
} from "../coding-runtime/codingRuntimeGitIpc.js";
import type { CodingToolMutationGuard } from "../coding-runtime/codingToolFacadePorts.js";
import { describeError } from "../diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

export interface RuntimeGitProposal {
  readonly proposalId: string;
  readonly runId: string;
  readonly expiresAtMs: number;
  readonly context: VerifiedCommitRunContext;
  readonly command: GitStageCommand;
  readonly review: CodingWorkbenchRuntimePendingApprovalReview;
  readonly binding: GitDeliveryApprovalBinding;
}
/**
 * Why `execute()` answered without a Git result. `authority-revoked` is the only refusal the model
 * may read as such: the run is not live, its guard or signal has closed, or authority lapsed while
 * the operation ran. `proposal-unknown` is a stage redemption for an id this service does not hold —
 * never proposed here, already redeemed, or expired — and `execution-failed` a Git read or stage
 * helper that threw. Both used to surface as `undefined` and reach the model as a revoked authority
 * (Coding Workbench run 13, 2026-09-10).
 */
export type RuntimeGitRefusalReason = "authority-revoked" | "proposal-unknown" | "execution-failed";
export interface RuntimeGitRefusal {
  readonly kind: "refused";
  readonly reason: RuntimeGitRefusalReason;
}
export type RuntimeGitOutcome = CodingRuntimeGitResult | RuntimeGitRefusal;
type RuntimeGitRefusalCondition =
  "signal-aborted" | "run-not-live" | "guard-rejected" | "mode-unavailable";
/** A stage effect that threw, carrying the proposal it was redeeming for the failure result. */
class StageEffectFailure extends Error {
  public constructor(
    public readonly proposal: RuntimeGitProposal,
    public override readonly cause: unknown,
  ) {
    super("git-stage-effect-failed");
    this.name = "StageEffectFailure";
  }
}
const REFUSED_AUTHORITY: RuntimeGitRefusal = { kind: "refused", reason: "authority-revoked" };
const REFUSED_EXECUTION: RuntimeGitRefusal = { kind: "refused", reason: "execution-failed" };
/** Open stage proposals the service holds at once; one more is blocked as `proposal-limit`. */
const MAX_OPEN_PROPOSALS = 64;
interface RuntimeGitOptions extends VerifiedCommitServiceOptions {
  readonly mode: () => CodingWorkbenchMode | undefined;
  readonly invalidateVerification: () => void;
}
function buildStageProposal(
  context: VerifiedCommitRunContext,
  facts: import("./verifiedCommitTypes.js").VerifiedCommitFacts,
  paths: readonly string[],
  worktreeDigest: string,
  review: StageSelectionReview,
  nowMs: number,
  proposalId: string,
): RuntimeGitProposal {
  const command: GitStageCommand = {
    kind: "stage",
    pathspecs: [...paths],
    includeUntracked: true,
    worktreeDigest,
    verified: { ...facts, branchName: context.headRef, baseRef: context.baseRef },
  };
  const binding: GitDeliveryApprovalBinding = {
    projectId: context.workspace.root,
    operation: "local-mutation",
    command,
    proposalId,
    runId: context.runId,
    envelopeDigest: context.envelopeDigest,
    workspaceDigest: context.workspaceDigest,
    repositoryDigest: context.repositoryDigest,
    headSha: facts.headSha,
    baseSha: facts.baseSha,
    stagedTreeDigest: facts.stagedTreeDigest,
  };
  return {
    proposalId,
    runId: context.runId,
    context,
    command,
    binding,
    expiresAtMs: nowMs + 300_000,
    review: {
      requestId: proposalId,
      paths: [...paths],
      pathsTruncated: false,
      fileCount: review.fileCount,
      addedLines: review.addedLines,
      deletedLines: review.deletedLines,
    },
  };
}

function resultEvidence(result: RuntimeGitOutcome): Readonly<Record<string, unknown>> {
  if (result.kind === "refused") return { state: "refused", reason: result.reason };
  if (result.kind === "stage")
    return {
      state: result.status,
      reason: result.reason,
      proposalId: result.proposalId,
      pathCount: result.pathCount,
    };
  return result.kind === "status"
    ? { state: "completed", fileCount: result.changes.length, truncated: result.truncated }
    : { state: "completed", fileCount: result.diff.totalFiles, truncated: result.diff.truncated };
}

// The closed literal a Git read or stage helper threw (`git-runtime-diff-drift`,
// `verified-commit-repository-drift`, `git-stage-candidate-too-large`, ...): a slug by construction,
// so the failure line can name it body-free next to `describeError`'s class and frames.
function thrownGitCode(error: unknown): { readonly code?: string } {
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && /^[a-z]+(?:-[a-z]+){1,8}$/u.test(message)
    ? { code: message }
    : {};
}

export class RuntimeGitService {
  private generation = 0;
  private readonly proposals = new Map<string, RuntimeGitProposal>();
  private leases = new WeakMap<
    object,
    { proposal: RuntimeGitProposal; claim: GitDeliveryApprovalRequirement }
  >();
  public constructor(private readonly options: RuntimeGitOptions) {}
  private now(): number {
    return this.options.execution?.now?.() ?? Date.now();
  }
  private store(): typeof DEFAULT_GIT_DELIVERY_APPROVAL_STORE {
    return this.options.execution?.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
  }
  public review(id: string): RuntimeGitProposal | undefined {
    const proposal = this.proposals.get(id);
    const live = this.options.context();
    return proposal !== undefined &&
      proposal.expiresAtMs > this.now() &&
      live?.runId === proposal.runId &&
      live.envelopeDigest === proposal.context.envelopeDigest &&
      live.stillAuthorized()
      ? proposal
      : undefined;
  }
  public issueApproval(id: string): GitDeliveryIssuedApproval | undefined {
    const proposal = this.review(id);
    if (proposal === undefined) return undefined;
    const issued = this.store().issue({
      binding: proposal.binding,
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: this.now(),
      ttlMs: proposal.expiresAtMs - this.now(),
    });
    this.log(proposal.context, "approval", { state: "issued", proposalId: id });
    return issued;
  }
  public matchesApproval(id: string): boolean {
    const proposal = this.review(id);
    return (
      proposal !== undefined &&
      this.store().matchesStageBinding?.(proposal.binding, this.now()) === true
    );
  }
  public consumeApproval(id: string): object | undefined {
    const proposal = this.review(id);
    if (proposal === undefined) return undefined;
    const claim = this.store().consumeStageBinding?.(proposal.binding, this.now());
    if (claim === undefined) return undefined;
    const lease = Object.freeze({});
    this.leases.set(lease, { proposal, claim });
    this.log(proposal.context, "approval", { state: "consumed", proposalId: id });
    return lease;
  }
  public invalidate(): void {
    this.generation += 1;
    this.proposals.clear();
    this.leases = new WeakMap();
  }
  public async execute(
    input: RuntimeGitRequest,
    guard: CodingToolMutationGuard,
    signal?: AbortSignal,
  ): Promise<RuntimeGitOutcome> {
    const request = snapshotRuntimeGitRequest(input);
    const phase = request.operation === "stage" ? `stage-${request.phase}` : request.operation;
    const context = this.guardedContext(guard, signal, phase);
    if (context === undefined) return REFUSED_AUTHORITY;
    try {
      const result = await this.dispatch(context, request, guard);
      if (result.kind !== "refused" && !isCodingRuntimeGitResult(result))
        throw new Error("git-runtime-result-invalid");
      this.log(
        context,
        phase,
        resultEvidence(result),
        result.kind === "refused" ? "refused" : "ok",
      );
      if (context.stillAuthorized()) return result;
      this.log(context, phase, { state: "withheld", reason: "authority-revoked" }, "refused");
      return REFUSED_AUTHORITY;
    } catch (error) {
      return this.failed(context, phase, error);
    }
  }
  // A read that threw because authority closed under it (`git-runtime-authority-denied`,
  // `verified-commit-authority-unavailable`) is the authority refusal, not a failed Git effect
  // (CodeRabbit review, 2026-09-10): the model may read only `authority-revoked` as such. A stage
  // redemption that threw still names its proposal, so the model can tell a failed effect from a
  // refused request; every other operation has no result to fail and is refused as such.
  private failed(
    context: VerifiedCommitRunContext,
    phase: string,
    error: unknown,
  ): RuntimeGitOutcome {
    if (context.signal?.aborted === true || !context.stillAuthorized()) {
      this.log(context, phase, { state: "refused", reason: "authority-revoked" }, "refused");
      return REFUSED_AUTHORITY;
    }
    const cause = error instanceof StageEffectFailure ? error.cause : error;
    this.log(
      context,
      phase,
      { state: "failed", ...describeError(cause), ...thrownGitCode(cause) },
      "failed",
    );
    return error instanceof StageEffectFailure
      ? this.result(error.proposal, "failed", "execution-failed")
      : REFUSED_EXECUTION;
  }
  private guardedContext(
    guard: CodingToolMutationGuard,
    signal: AbortSignal | undefined,
    phase: string,
  ): VerifiedCommitRunContext | undefined {
    const context = this.options.context();
    const condition = this.refusalCondition(context, guard, signal);
    if (context === undefined || condition !== undefined) {
      this.log(
        context,
        phase,
        { state: "refused", reason: condition ?? "run-not-live" },
        "refused",
      );
      return undefined;
    }
    const generation = this.generation;
    const signals = [context.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    return {
      ...context,
      signal: AbortSignal.any(signals),
      stillAuthorized: () =>
        generation === this.generation && context.stillAuthorized() && guard.check(),
    };
  }
  // Checked in the order the old silent `undefined` was decided, so the first true condition is the
  // one named: a closed signal before a missing run, a missing run before its guard, the guard
  // before the mode the service cannot resolve.
  private refusalCondition(
    context: VerifiedCommitRunContext | undefined,
    guard: CodingToolMutationGuard,
    signal: AbortSignal | undefined,
  ): RuntimeGitRefusalCondition | undefined {
    if (signal?.aborted === true || context?.signal?.aborted === true) return "signal-aborted";
    if (context === undefined) return "run-not-live";
    if (!guard.check()) return "guard-rejected";
    return this.options.mode() === undefined ? "mode-unavailable" : undefined;
  }
  private async dispatch(
    context: VerifiedCommitRunContext,
    request: RuntimeGitRequest,
    guard: CodingToolMutationGuard,
  ): Promise<RuntimeGitOutcome> {
    const execution = this.options.execution ?? {};
    await readVerifiedCommitFacts(context, execution);
    if (request.operation === "status") return runtimeGitStatus(context, execution);
    if (request.operation === "diff")
      return {
        kind: "diff",
        diff: await runtimeGitDiff(
          context,
          execution,
          request.scope === "index" ? "staged" : "unstaged",
          request.paths,
        ),
      };
    return request.phase === "propose"
      ? this.propose(context, request.paths)
      : this.stage(context, request.proposalId, guard.stageApproval);
  }
  private pruneExpired(): void {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAtMs <= this.now()) this.proposals.delete(id);
    }
  }
  // Every refusal here is a complete Git result under a freshly minted id nothing is stored for:
  // the model learns what to change, the log carries the same reason, and only the authority path
  // (`execute`) may answer without a result. Admission is settled against Git's own change list
  // before the candidate bytes are read, so a directory or an unchanged path is refused as such
  // instead of surfacing as a failed read; the two digest reads then bracket the review counts,
  // binding the operator's numbers to exactly the bytes the proposal will stage.
  private async propose(
    context: VerifiedCommitRunContext,
    paths: readonly string[],
  ): Promise<CodingRuntimeGitStage> {
    this.pruneExpired();
    const proposalId = mintProposalId("stage");
    const refuse = (
      status: "blocked" | "drift",
      reason: CodingRuntimeGitStage["reason"],
    ): CodingRuntimeGitStage => ({
      kind: "stage",
      proposalId,
      status,
      reason,
      pathCount: paths.length,
    });
    if (this.proposals.size >= MAX_OPEN_PROPOSALS) return refuse("blocked", "proposal-limit");
    if (!context.buffersClean()) return refuse("blocked", "buffers-dirty");
    const execution = this.options.execution ?? {};
    const facts = await readVerifiedCommitFacts(context, execution);
    const selection = await admitStageSelection(context, execution, paths);
    if (selection === undefined) return refuse("blocked", "selection-unreviewed");
    const workspaceFs = runtimeWorkspaceFs(context);
    const worktreeDigest = await readGitStageCandidate(context.workspace.root, paths, workspaceFs);
    const review = await reviewStageSelection(context, execution, selection);
    if (
      (await readGitStageCandidate(context.workspace.root, paths, workspaceFs)) !== worktreeDigest
    )
      return refuse("drift", "candidate-drift");
    const proposal = buildStageProposal(
      context,
      facts,
      paths,
      worktreeDigest,
      review,
      this.now(),
      proposalId,
    );
    if (!(await readGitStageSupport(runtimeGitReadDeps(context, execution), paths)))
      return this.result(proposal, "blocked", "unsupported-transformation");
    this.proposals.set(proposalId, proposal);
    return this.options.mode() === "governed-assist"
      ? this.result(proposal, "approval-required", "approval-required")
      : this.result(proposal, "ready", "none");
  }
  private async stage(
    context: VerifiedCommitRunContext,
    id: string,
    lease: object | undefined,
  ): Promise<RuntimeGitOutcome> {
    const proposal = this.review(id);
    if (proposal === undefined) return { kind: "refused", reason: this.redemptionRefusal(id) };
    const consumed = this.consumeLease(lease);
    if (
      (lease !== undefined || this.options.mode() === "governed-assist") &&
      consumed?.proposal !== proposal
    )
      return this.result(proposal, "blocked", "approval-invalid");
    if (!(await this.stageCurrent(context, proposal)))
      return this.result(proposal, "drift", "candidate-drift");
    this.proposals.delete(id);
    this.options.invalidateVerification();
    // The proposal leaves the redeemable map BEFORE the effect runs (a redeemed proposal must never
    // be redeemable twice), so a throwing effect carries it out with itself for the failure result
    // instead of being looked up in a map it has already left (CodeRabbit review, 2026-09-10).
    try {
      return await this.mutateStage(context, proposal, consumed?.claim ?? { required: false });
    } catch (error) {
      throw new StageEffectFailure(proposal, error);
    }
  }
  // `review()` rejects an id it never held, one already redeemed or expired, and one whose run,
  // envelope or authority no longer match. Only the last is the model's authority; the rest are a
  // stale id it can replace by proposing again.
  private redemptionRefusal(id: string): RuntimeGitRefusalReason {
    const held = this.proposals.get(id);
    return held === undefined || held.expiresAtMs <= this.now()
      ? "proposal-unknown"
      : "authority-revoked";
  }
  private consumeLease(
    lease: object | undefined,
  ): { proposal: RuntimeGitProposal; claim: GitDeliveryApprovalRequirement } | undefined {
    if (lease === undefined) return undefined;
    const consumed = this.leases.get(lease);
    this.leases.delete(lease);
    return consumed;
  }
  private async stageCurrent(
    context: VerifiedCommitRunContext,
    proposal: RuntimeGitProposal,
  ): Promise<boolean> {
    const current = await readVerifiedCommitFacts(context, this.options.execution ?? {});
    const digest = await readGitStageCandidate(
      context.workspace.root,
      proposal.command.pathspecs,
      runtimeWorkspaceFs(context),
    );
    return (
      context.buffersClean() &&
      current.headSha === proposal.binding.headSha &&
      current.baseSha === proposal.binding.baseSha &&
      current.stagedTreeDigest === proposal.binding.stagedTreeDigest &&
      digest === proposal.command.worktreeDigest
    );
  }
  private async mutateStage(
    context: VerifiedCommitRunContext,
    proposal: RuntimeGitProposal,
    claim: GitDeliveryApprovalRequirement,
  ): Promise<CodingRuntimeGitStage> {
    const outcome = await executeGovernedMutation(
      proposal.command,
      claim,
      context.workspace,
      this.options.mutationDeps,
      {
        ...this.options.execution,
        signal: context.signal,
        beforeIndexUpdate: () => context.stillAuthorized() && context.buffersClean(),
        snapshotReader: () =>
          readGitRawWorktreeSnapshot(runtimeGitReadDeps(context, this.options.execution ?? {})),
      },
      context.correlationId,
    );
    const status = outcome.outcome.status;
    if (status === "succeeded") return this.result(proposal, "succeeded", "none");
    if (status === "blocked") return this.result(proposal, "blocked", outcome.outcome.category);
    if (status === "approval-required")
      return this.result(proposal, "approval-required", "approval-required");
    return status === "recovery-required"
      ? this.result(proposal, status, "execution-uncertain")
      : this.result(proposal, status, "execution-failed");
  }
  private result(
    proposal: RuntimeGitProposal,
    status: CodingRuntimeGitStage["status"],
    reason: CodingRuntimeGitStage["reason"],
  ): CodingRuntimeGitStage {
    return {
      kind: "stage",
      proposalId: proposal.proposalId,
      status,
      reason,
      pathCount: proposal.command.pathspecs.length,
    };
  }
  // A refusal is not a failure: it is written at warn level so an unanswered Git call stands out in
  // the timeline, but carries no errorKind. A thrown failure keeps the structured error shape. With
  // no live run to borrow a correlation id from, the line rides on the one sanctioned unknown id.
  private log(
    context: VerifiedCommitRunContext | undefined,
    phase: string,
    extra: Readonly<Record<string, unknown>>,
    outcome: "ok" | "refused" | "failed" = "ok",
  ): void {
    (this.options.execution?.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.runtime-action",
      correlationId: context?.correlationId ?? UNKNOWN_CORRELATION_ID,
      ...(outcome === "ok" ? {} : { level: "warn" as const }),
      ...(outcome === "failed" ? { errorKind: "internal" as const } : {}),
      extra: { phase, ...(context === undefined ? {} : { runId: context.runId }), ...extra },
    });
  }
}
