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
import { runtimeGitDiff, runtimeGitStatus, runtimeGitReadDeps } from "./runtimeGitRead.js";
import {
  snapshotRuntimeGitRequest,
  type RuntimeGitRequest,
} from "../coding-runtime/codingRuntimeGitIpc.js";
import type { CodingToolMutationGuard } from "../coding-runtime/codingToolFacadePorts.js";
import { describeError } from "../diagnostics-log.js";
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
interface RuntimeGitOptions extends VerifiedCommitServiceOptions {
  readonly mode: () => CodingWorkbenchMode | undefined;
  readonly invalidateVerification: () => void;
}
function buildStageProposal(
  context: VerifiedCommitRunContext,
  facts: import("./verifiedCommitTypes.js").VerifiedCommitFacts,
  paths: readonly string[],
  worktreeDigest: string,
  diff: import("@oscharko-dev/keiko-contracts").GitEditorDiffResponse,
  nowMs: number,
): RuntimeGitProposal {
  const proposalId = mintProposalId("stage");
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
      fileCount: paths.length,
      addedLines: diff.files.reduce((n, file) => n + file.addedLines, 0),
      deletedLines: diff.files.reduce((n, file) => n + file.removedLines, 0),
    },
  };
}

function resultEvidence(
  result: CodingRuntimeGitResult | undefined,
): Readonly<Record<string, unknown>> {
  if (result === undefined) return { state: "unavailable" };
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
  ): Promise<CodingRuntimeGitResult | undefined> {
    const request = snapshotRuntimeGitRequest(input);
    const context = this.guardedContext(guard, signal);
    if (context === undefined) return undefined;
    try {
      const result = await this.dispatch(context, request, guard);
      if (result !== undefined && !isCodingRuntimeGitResult(result))
        throw new Error("git-runtime-result-invalid");
      this.log(
        context,
        request.operation === "stage" ? `stage-${request.phase}` : request.operation,
        resultEvidence(result),
      );
      return context.stillAuthorized() ? result : undefined;
    } catch (error) {
      this.log(context, request.operation, { state: "failed", ...describeError(error) }, true);
      return request.operation === "stage" && request.phase === "execute"
        ? this.result(this.proposals.get(request.proposalId), "failed", "execution-failed")
        : undefined;
    }
  }
  private guardedContext(
    guard: CodingToolMutationGuard,
    signal: AbortSignal | undefined,
  ): VerifiedCommitRunContext | undefined {
    const context = this.options.context();
    if (signal?.aborted === true || context?.signal?.aborted === true) return undefined;
    if (context === undefined || !guard.check() || this.options.mode() === undefined)
      return undefined;
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
  private async dispatch(
    context: VerifiedCommitRunContext,
    request: RuntimeGitRequest,
    guard: CodingToolMutationGuard,
  ): Promise<CodingRuntimeGitResult | undefined> {
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
  private async propose(
    context: VerifiedCommitRunContext,
    paths: readonly string[],
  ): Promise<CodingRuntimeGitStage | undefined> {
    this.pruneExpired();
    if (this.proposals.size >= 64 || !context.buffersClean()) return undefined;
    const execution = this.options.execution ?? {};
    const facts = await readVerifiedCommitFacts(context, execution);
    const worktreeDigest = await readGitStageCandidate(context.workspace.root, paths);
    const diff = await runtimeGitDiff(context, execution, "unstaged", paths);
    if (
      diff.truncated ||
      diff.files.some((file) => file.truncated) ||
      diff.files.length !== paths.length
    )
      return undefined;
    if ((await readGitStageCandidate(context.workspace.root, paths)) !== worktreeDigest)
      return undefined;
    const proposal = buildStageProposal(context, facts, paths, worktreeDigest, diff, this.now());
    const proposalId = proposal.proposalId;
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
  ): Promise<CodingRuntimeGitStage | undefined> {
    const proposal = this.review(id);
    if (proposal === undefined) return undefined;
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
    return this.mutateStage(context, proposal, consumed?.claim ?? { required: false });
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
    const digest = await readGitStageCandidate(context.workspace.root, proposal.command.pathspecs);
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
  ): Promise<CodingRuntimeGitStage | undefined> {
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
    proposal: RuntimeGitProposal | undefined,
    status: CodingRuntimeGitStage["status"],
    reason: CodingRuntimeGitStage["reason"],
  ): CodingRuntimeGitStage | undefined {
    return proposal === undefined
      ? undefined
      : {
          kind: "stage",
          proposalId: proposal.proposalId,
          status,
          reason,
          pathCount: proposal.command.pathspecs.length,
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
      op: "git.runtime-action",
      correlationId: context.correlationId,
      ...(failed ? { level: "warn" as const, errorKind: "internal" as const } : {}),
      extra: { phase, runId: context.runId, ...extra },
    });
  }
}
