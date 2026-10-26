import type {
  CodingRuntimeGitResult,
  CodingRuntimeGitStage,
  CodingRuntimeGitSync,
  CodingRuntimeGitUnstage,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimePendingApprovalReview,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isCodingRuntimeGitResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { isSafeGitRefName } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  readGitRevision,
  readGitStageCandidate,
  readGitStageSupport,
  readGitRawWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitStageCommand, GitUnstageCommand } from "@oscharko-dev/keiko-tools";
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
import {
  executeGovernedMutation,
  gitDeliveryActivityErrorKind,
  gitDeliveryActivityFailureKind,
  gitDeliveryTerminationHandler,
  recordKeikoWrittenHead,
} from "./execution.js";
import {
  admitStageSelection,
  admitUnstageSelection,
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
  type RuntimeGitSyncOperation,
} from "../coding-runtime/codingRuntimeGitIpc.js";
import { buildSyncPreview, runSyncExecute, type GitDeliverySyncSeams } from "./syncExecution.js";
import { persistGitSyncResult } from "./syncEvidence.js";
import type { CodingToolMutationGuard } from "../coding-runtime/codingToolFacadePorts.js";
import type { GovernedSyncHead } from "../coding-runtime/governedSyncHeads.js";
import { describeError } from "../diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorKindOf } from "@oscharko-dev/keiko-activity-log";
import type { GitSyncOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-sync";

const RUNTIME_GIT_STATE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: [
    "issued",
    "consumed",
    "completed",
    "refused",
    "withheld",
    "failed",
    "ready",
    "approval-required",
    "succeeded",
    "blocked",
    "drift",
    "recovery-required",
  ],
} as const;

const RUNTIME_GIT_REASON_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [
    "none",
    "approval-required",
    "approval-invalid",
    "authority-denied",
    "scope-denied",
    "policy-block",
    "preflight-block",
    "unsupported-transformation",
    "selection-unreviewed",
    "buffers-dirty",
    "proposal-limit",
    "candidate-drift",
    "execution-failed",
    "execution-uncertain",
    "authority-revoked",
    "proposal-unknown",
    "signal-aborted",
    "run-not-live",
    "guard-rejected",
    "mode-unavailable",
  ],
} as const;

const RUNTIME_GIT_FRAMES_FIELD = {
  type: "string-array",
  dataClass: "safe-platform-class",
  required: false,
  maxLength: 512,
  maxItems: 8,
} as const;

const RUNTIME_GIT_CAUSE_CHAIN_FIELD = {
  type: "string-array",
  dataClass: "error-kind",
  required: false,
  maxLength: 128,
  maxItems: 5,
} as const;

const RUNTIME_GIT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.runtime-action",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/runtimeGitService.RuntimeGitService.log",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "approval",
        "status",
        "diff",
        "stage-propose",
        "stage-execute",
        "unstage-propose",
        "unstage-execute",
        "fetch",
        "pull",
      ],
    },
    runId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    state: RUNTIME_GIT_STATE_FIELD,
    reason: RUNTIME_GIT_REASON_FIELD,
    proposalId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    pathCount: { type: "integer", dataClass: "count", required: false },
    fileCount: { type: "integer", dataClass: "count", required: false },
    truncated: { type: "boolean", dataClass: "closed-enum", required: false },
    // #3902 AC2: the closed outcome of a fetch or pull (`GIT_SYNC_OUTCOMES`); the Git process lines
    // of the same correlation carry a failure's own error evidence.
    syncOutcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "succeeded",
        "up-to-date",
        "no-remote",
        "no-upstream",
        "detached-head",
        "dirty-worktree",
        "not-fast-forward",
        "authority-denied",
        "auth-failed",
        "untrusted-host-key",
        "remote-unavailable",
        "timeout",
        "output-truncated",
        "git-missing",
        "unsafe-repository",
        "git-error",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: RUNTIME_GIT_FRAMES_FIELD,
    causeChain: RUNTIME_GIT_CAUSE_CHAIN_FIELD,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-runtime-action"],
  proofIds: ["git.runtime-action.emitted-line"],
  releaseImpact: "patch",
});

type RuntimeGitPhase =
  | "approval"
  | "status"
  | "diff"
  | "stage-propose"
  | "stage-execute"
  | "unstage-propose"
  | "unstage-execute"
  | RuntimeGitSyncOperation;
/** A proposal's result: staging, or its inverse unstaging (#3902 AC2), on one lifecycle. */
type IndexProposalResult = CodingRuntimeGitStage | CodingRuntimeGitUnstage;
interface RuntimeGitActivityFields {
  readonly state:
    | CodingRuntimeGitStage["status"]
    | "issued"
    | "consumed"
    | "completed"
    | "refused"
    | "withheld"
    | "failed";
  readonly reason?:
    CodingRuntimeGitStage["reason"] | RuntimeGitRefusalReason | RuntimeGitRefusalCondition;
  readonly proposalId?: string;
  readonly pathCount?: number;
  readonly fileCount?: number;
  readonly truncated?: boolean;
  readonly syncOutcome?: GitSyncOutcome;
  readonly failureKind?: string;
  readonly errorClass?: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

function runtimeGitLogOptions(
  context: VerifiedCommitRunContext | undefined,
  extra: RuntimeGitActivityFields,
  outcome: "ok" | "refused" | "failed",
): {
  readonly correlationId: string;
  readonly level?: "warn";
  readonly errorKind?: ReturnType<typeof gitDeliveryActivityErrorKind>;
} {
  return {
    correlationId: context?.correlationId ?? UNKNOWN_CORRELATION_ID,
    ...(outcome === "ok" ? {} : { level: "warn" as const }),
    ...(outcome === "failed"
      ? { errorKind: gitDeliveryActivityErrorKind(extra.failureKind ?? extra.reason ?? outcome) }
      : {}),
  };
}

export interface RuntimeGitProposal {
  readonly proposalId: string;
  readonly runId: string;
  readonly expiresAtMs: number;
  readonly context: VerifiedCommitRunContext;
  readonly command: GitStageCommand | GitUnstageCommand;
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
  /** Test seams of the Git sync owner's executor (its runner, clock, bounds). */
  readonly sync?: Pick<GitDeliverySyncSeams, "runner" | "now" | "maxBytes" | "timeoutMs">;
  /** Records the head a governed fast-forward wrote (governedSyncHeads.ts). */
  readonly recordGovernedSyncHead?: ((head: GovernedSyncHead) => void) | undefined;
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
  return assembleProposal(context, facts, command, review, nowMs, proposalId);
}

// An unstage proposal binds the same head, base and staged tree as a stage proposal, and carries
// them to the index effect, which checks them inside its index transaction and again at the swap:
// redeemed only while the index it reviewed is the index it changes, also after an approval (#3902
// AC2, PR #4064 review). The worktree is not its subject.
function buildUnstageProposal(
  context: VerifiedCommitRunContext,
  facts: import("./verifiedCommitTypes.js").VerifiedCommitFacts,
  paths: readonly string[],
  review: StageSelectionReview,
  nowMs: number,
  proposalId: string,
): RuntimeGitProposal {
  const command: GitUnstageCommand = {
    kind: "unstage",
    pathspecs: [...paths],
    verified: { ...facts, branchName: context.headRef, baseRef: context.baseRef },
  };
  return assembleProposal(context, facts, command, review, nowMs, proposalId);
}

function assembleProposal(
  context: VerifiedCommitRunContext,
  facts: import("./verifiedCommitTypes.js").VerifiedCommitFacts,
  command: GitStageCommand | GitUnstageCommand,
  review: StageSelectionReview,
  nowMs: number,
  proposalId: string,
): RuntimeGitProposal {
  const paths = command.pathspecs;
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

// A settled fetch or pull: Git's own outcome, in the state vocabulary of the other runtime actions.
const SYNC_BLOCKS: ReadonlySet<GitSyncOutcome> = new Set([
  "no-remote",
  "no-upstream",
  "detached-head",
  "dirty-worktree",
  "not-fast-forward",
  "git-missing",
  "unsafe-repository",
]);
function syncEvidence(result: CodingRuntimeGitSync): RuntimeGitActivityFields {
  const state =
    result.status === "succeeded"
      ? "succeeded"
      : result.status === "up-to-date"
        ? "completed"
        : result.status === "authority-denied"
          ? "refused"
          : SYNC_BLOCKS.has(result.status)
            ? "blocked"
            : "failed";
  return { state, syncOutcome: result.status, truncated: result.truncated };
}

/** The log outcome of a result: a sync that settled anywhere but Git's success is a warning. */
function resultOutcome(result: RuntimeGitOutcome): "ok" | "refused" {
  if (result.kind === "refused") return "refused";
  return (result.kind === "fetch" || result.kind === "pull") &&
    result.status !== "succeeded" &&
    result.status !== "up-to-date"
    ? "refused"
    : "ok";
}

function resultEvidence(result: RuntimeGitOutcome): RuntimeGitActivityFields {
  if (result.kind === "refused") return { state: "refused", reason: result.reason };
  if (result.kind === "fetch" || result.kind === "pull") return syncEvidence(result);
  if (result.kind === "stage" || result.kind === "unstage")
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
  return message !== undefined && message.length <= 64 && /^[a-z]+(?:-[a-z]+){1,8}$/u.test(message)
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
    const phase: RuntimeGitPhase =
      request.operation === "stage" || request.operation === "unstage"
        ? `${request.operation}-${request.phase}`
        : request.operation;
    const context = this.guardedContext(guard, signal, phase);
    if (context === undefined) return REFUSED_AUTHORITY;
    try {
      const result = await this.dispatch(context, request, guard);
      if (result.kind !== "refused" && !isCodingRuntimeGitResult(result))
        throw new Error("git-runtime-result-invalid");
      this.log(context, phase, resultEvidence(result), resultOutcome(result));
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
    phase: RuntimeGitPhase,
    error: unknown,
  ): RuntimeGitOutcome {
    if (context.signal?.aborted === true || !context.stillAuthorized()) {
      this.log(context, phase, { state: "refused", reason: "authority-revoked" }, "refused");
      return REFUSED_AUTHORITY;
    }
    const cause = error instanceof StageEffectFailure ? error.cause : error;
    const failureKind = gitDeliveryActivityFailureKind(errorKindOf(cause));
    const detail = describeError(cause);
    this.log(
      context,
      phase,
      {
        state: "failed",
        failureKind,
        errorClass: detail.errorClass,
        ...thrownGitCode(cause),
        ...(detail.frames === undefined ? {} : { frames: detail.frames }),
        ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
      },
      "failed",
    );
    return error instanceof StageEffectFailure
      ? this.result(error.proposal, "failed", "execution-failed")
      : REFUSED_EXECUTION;
  }
  private guardedContext(
    guard: CodingToolMutationGuard,
    signal: AbortSignal | undefined,
    phase: RuntimeGitPhase,
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
    if (request.operation === "fetch" || request.operation === "pull")
      return this.sync(context, request.operation);
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
    if (request.phase === "execute")
      return this.redeem(context, request.operation, request.proposalId, guard.stageApproval);
    return request.operation === "stage"
      ? this.propose(context, request.paths)
      : this.proposeUnstage(context, request.paths);
  }
  // #3902 AC2: one fetch, or one fast-forward pull of the current branch from its upstream, through
  // the Git sync owner's own executor: the fixed argv, hardened runner, bounds and closed outcomes of
  // the Git Client's Fetch and Pull. The run's live authority is proven again immediately before
  // the remote dispatch, and the outcome lands in the same sync evidence ledger.
  private async sync(
    context: VerifiedCommitRunContext,
    operation: RuntimeGitSyncOperation,
  ): Promise<CodingRuntimeGitSync> {
    const root = context.workspace.root;
    const seams: GitDeliverySyncSeams = {
      ...this.options.sync,
      correlationId: context.correlationId,
      activityLog: this.options.execution?.activityLog,
      beforeRemoteDispatch: () => context.stillAuthorized(),
    };
    const before = await buildSyncPreview(operation, root, undefined, seams);
    const result = await runSyncExecute(operation, root, undefined, seams, before);
    if (operation === "pull" && result.outcome === "succeeded")
      await this.recordWrittenHead(context);

    persistGitSyncResult(this.options.mutationDeps, {
      operation,
      remote: undefined,
      workspaceRoot: root,
      before,
      result,
      recordedAtMs: this.now(),
    });
    const branch = result.branch ?? before.branch;
    return {
      kind: operation,
      status: result.outcome,
      ...(branch !== undefined && isSafeGitRefName(branch) ? { branch } : {}),
      ...(result.ahead === undefined ? {} : { ahead: result.ahead }),
      ...(result.behind === undefined ? {} : { behind: result.behind }),
      truncated: result.truncated,
    };
  }
  // #3902 AC2: the fast-forward moved the run's branch to a head Keiko itself wrote. The workspace's
  // verified head and the run's sync receipt both record it, so the run's authority stands on it as
  // it stands on a head Keiko's verified commit wrote.
  private async recordWrittenHead(context: VerifiedCommitRunContext): Promise<void> {
    const execution = this.options.execution ?? {};
    await recordKeikoWrittenHead(this.options.mutationDeps, context.workspace, execution, {
      activityLog: execution.activityLog,
      correlationId: context.correlationId,
    });
    const headSha = await readGitRevision(
      {
        workspace: context.workspace,
        processEnv: execution.processEnv,
        signal: context.signal,
        onTerminated: gitDeliveryTerminationHandler(execution, context.correlationId),
      },
      "HEAD",
    );
    this.options.recordGovernedSyncHead?.({
      runId: context.runId,
      headSha,
      workspaceDigest: context.workspaceDigest,
    });
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
  ): Promise<IndexProposalResult> {
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
  // #3902 AC2: unstaging gives a staged change back to the worktree. Admission is Git's own change
  // list (only staged, unconflicted paths); the review counts the staged lines it gives back.
  private async proposeUnstage(
    context: VerifiedCommitRunContext,
    paths: readonly string[],
  ): Promise<CodingRuntimeGitUnstage> {
    this.pruneExpired();
    const proposalId = mintProposalId("unstage");
    const refuse = (reason: CodingRuntimeGitUnstage["reason"]): CodingRuntimeGitUnstage => ({
      kind: "unstage",
      proposalId,
      status: "blocked",
      reason,
      pathCount: paths.length,
    });
    if (this.proposals.size >= MAX_OPEN_PROPOSALS) return refuse("proposal-limit");
    const execution = this.options.execution ?? {};
    const facts = await readVerifiedCommitFacts(context, execution);
    const selection = await admitUnstageSelection(context, execution, paths);
    if (selection === undefined) return refuse("selection-unreviewed");
    const review = await reviewStageSelection(context, execution, selection, "staged");
    const proposal = buildUnstageProposal(context, facts, paths, review, this.now(), proposalId);
    this.proposals.set(proposalId, proposal);
    const result =
      this.options.mode() === "governed-assist"
        ? this.result(proposal, "approval-required", "approval-required")
        : this.result(proposal, "ready", "none");
    return { ...result, kind: "unstage" };
  }
  private async redeem(
    context: VerifiedCommitRunContext,
    kind: "stage" | "unstage",
    id: string,
    lease: object | undefined,
  ): Promise<RuntimeGitOutcome> {
    const proposal = this.review(id);
    if (proposal === undefined) return { kind: "refused", reason: this.redemptionRefusal(id) };
    if (proposal.command.kind !== kind) return { kind: "refused", reason: "proposal-unknown" };
    const consumed = this.consumeLease(lease);
    if (!this.approvedFor(proposal, lease, consumed))
      return this.result(proposal, "blocked", "approval-invalid");
    if (!(await this.indexCurrent(context, proposal)))
      return this.result(proposal, "drift", "candidate-drift");
    this.proposals.delete(id);
    this.options.invalidateVerification();
    // The proposal leaves the redeemable map BEFORE the effect runs (a redeemed proposal must never
    // be redeemable twice), so a throwing effect carries it out with itself for the failure result
    // instead of being looked up in a map it has already left (CodeRabbit review, 2026-09-10).
    try {
      return await this.mutateIndex(context, proposal, consumed?.claim ?? { required: false });
    } catch (error) {
      throw new StageEffectFailure(proposal, error);
    }
  }
  // A presented lease, and every redemption under Ask for approval, must carry this proposal's own
  // approval.
  private approvedFor(
    proposal: RuntimeGitProposal,
    lease: object | undefined,
    consumed: { readonly proposal: RuntimeGitProposal } | undefined,
  ): boolean {
    if (lease === undefined && this.options.mode() !== "governed-assist") return true;
    return consumed?.proposal === proposal;
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
  // A stage proposal also binds the worktree bytes it stages; an unstage proposal only the index.
  private async indexCurrent(
    context: VerifiedCommitRunContext,
    proposal: RuntimeGitProposal,
  ): Promise<boolean> {
    if (proposal.command.kind === "stage")
      return this.stageCurrent(context, { ...proposal, command: proposal.command });
    const current = await readVerifiedCommitFacts(context, this.options.execution ?? {});
    return (
      current.headSha === proposal.binding.headSha &&
      current.baseSha === proposal.binding.baseSha &&
      current.stagedTreeDigest === proposal.binding.stagedTreeDigest
    );
  }
  private async stageCurrent(
    context: VerifiedCommitRunContext,
    proposal: RuntimeGitProposal & { readonly command: GitStageCommand },
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
  private async mutateIndex(
    context: VerifiedCommitRunContext,
    proposal: RuntimeGitProposal,
    claim: GitDeliveryApprovalRequirement,
  ): Promise<IndexProposalResult> {
    // Unsaved editor bytes matter to what staging records, never to what unstaging gives back.
    const buffersSettled = (): boolean =>
      proposal.command.kind === "unstage" || context.buffersClean();
    const outcome = await executeGovernedMutation(
      proposal.command,
      claim,
      context.workspace,
      this.options.mutationDeps,
      {
        ...this.options.execution,
        signal: context.signal,
        beforeIndexUpdate: () => context.stillAuthorized() && buffersSettled(),
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
  ): IndexProposalResult {
    return {
      kind: proposal.command.kind,
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
    phase: RuntimeGitPhase,
    extra: RuntimeGitActivityFields,
    outcome: "ok" | "refused" | "failed" = "ok",
  ): void {
    (this.options.execution?.activityLog ?? processServerLogSink()).write(
      activityLogEvent(RUNTIME_GIT_OPERATION, runtimeGitLogOptions(context, extra, outcome), {
        phase,
        ...(context === undefined ? {} : { runId: context.runId }),
        ...extra,
      }),
    );
  }
}
