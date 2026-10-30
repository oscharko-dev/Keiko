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
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { GitMutationLifecycleResult } from "@oscharko-dev/keiko-tools";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorKindOf } from "@oscharko-dev/keiko-activity-log";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  type GitDeliveryApprovalBinding,
  type GitDeliveryIssuedApproval,
} from "./approvalStore.js";
import {
  executeGovernedMutation,
  gitDeliveryActivityCode,
  gitDeliveryActivityErrorKind,
  gitDeliveryActivityFailureKind,
  readStagedConflictMarkerFileCountFor,
} from "./execution.js";
import {
  readVerifiedCommitFacts,
  sameVerifiedCommitFacts,
  verifiedCommitMessageDigest,
} from "./verifiedCommitFacts.js";
import { reconcileVerifiedCommit } from "./verifiedCommitRecovery.js";
import {
  commitVerificationReportFailed,
  commitVerificationReportPassed,
} from "./verifiedCommitVerification.js";
import {
  appendVerificationCheck,
  EMPTY_VERIFICATION_CHECK_HISTORY,
  verificationCheckRecord,
  type VerificationCheckHistory,
} from "./verificationChecks.js";
import type {
  VerificationTicketOutcome,
  VerifiedCommitFacts,
  VerifiedCommitProposal,
  VerifiedCommitRunContext,
  VerifiedCommitService,
  VerifiedCommitServiceOptions,
  VerifiedCommitBlockingPaths,
} from "./verifiedCommitTypes.js";

const VERIFIED_COMMIT_RESULT_REASONS = [
  "approval-required",
  "approval-invalid",
  "authority-denied",
  "verification-missing",
  "candidate-not-staged",
  "buffers-dirty",
  "verification-failed",
  "verification-stale",
  "candidate-drift",
  "repository-drift",
  "message-policy",
  "review-incomplete",
  "issue-directive",
  "conflict-markers",
  "policy-block",
  "preflight-block",
  "execution-failed",
  "execution-uncertain",
  "restart-reconciliation",
  "completed",
] as const;

const VERIFIED_COMMIT_RESULT_STATES = [
  "succeeded",
  "approval-required",
  "blocked",
  "failed",
  "recovery-required",
  "verification-failed",
  "drift",
] as const;

const VERIFIED_COMMIT_FRAMES_FIELD = {
  type: "string-array",
  dataClass: "safe-platform-class",
  required: false,
  maxLength: 512,
  maxItems: 8,
} as const;

const VERIFIED_COMMIT_CAUSE_CHAIN_FIELD = {
  type: "string-array",
  dataClass: "error-kind",
  required: false,
  maxLength: 128,
  maxItems: 5,
} as const;

const VERIFIED_COMMIT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.verified-commit",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/verifiedCommitService.VerifiedCommitService.log",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "verification-started",
        "verification-unavailable",
        "verification-discarded",
        "verification",
        "verification-observed",
        "approval",
        "execute",
        "write-ahead",
        "result",
        "persist-failed",
        "reconcile",
      ],
    },
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...VERIFIED_COMMIT_RESULT_REASONS],
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["issued", "consumed", "policy-authorized", ...VERIFIED_COMMIT_RESULT_STATES],
    },
    unstagedCount: { type: "integer", dataClass: "count", required: false },
    untrackedCount: { type: "integer", dataClass: "count", required: false },
    verificationGeneration: { type: "integer", dataClass: "count", required: false },
    currentGeneration: { type: "integer", dataClass: "count", required: false },
    passed: { type: "boolean", dataClass: "closed-enum", required: false },
    verificationEvidenceId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    checkCount: { type: "integer", dataClass: "count", required: false },
    failedCheckCount: { type: "integer", dataClass: "count", required: false },
    omittedCount: { type: "integer", dataClass: "count", required: false },
    proposalId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    stagedTreeDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    violations: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 6,
      values: [
        "empty-subject",
        "missing-conventional-prefix",
        "disallowed-type",
        "subject-too-long",
        "missing-issue-key",
        "missing-signoff",
      ],
    },
    violationCount: { type: "integer", dataClass: "count", required: false },
    attemptedStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...VERIFIED_COMMIT_RESULT_STATES],
    },
    attemptedReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...VERIFIED_COMMIT_RESULT_REASONS],
    },
    effectPhase: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pre-effect", "post-effect"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: VERIFIED_COMMIT_FRAMES_FIELD,
    causeChain: VERIFIED_COMMIT_CAUSE_CHAIN_FIELD,
  },
  causal: "correlation",
  diagnosticWhen: [{ field: "failedCheckCount", positive: true }],
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-verified-commit"],
  proofIds: ["git.verified-commit.emitted-line"],
  releaseImpact: "patch",
});

type VerifiedCommitActivityPhase =
  | "verification-started"
  | "verification-unavailable"
  | "verification-discarded"
  | "verification"
  | "verification-observed"
  | "approval"
  | "execute"
  | "write-ahead"
  | "result"
  | "persist-failed"
  | "reconcile";

interface VerifiedCommitActivityFields {
  readonly verificationGeneration?: number;
  readonly currentGeneration?: number;
  readonly reason?: VerifiedCommitReason;
  readonly state?: VerifiedCommitStatus | "issued" | "consumed" | "policy-authorized" | "failed";
  readonly unstagedCount?: number;
  readonly untrackedCount?: number;
  readonly passed?: boolean;
  readonly verificationEvidenceId?: string;
  readonly checkCount?: number;
  readonly failedCheckCount?: number;
  readonly omittedCount?: number;
  readonly proposalId?: string;
  readonly stagedTreeDigest?: string;
  readonly violations?: NonNullable<VerifiedCommitResult["violations"]>;
  readonly violationCount?: number;
  readonly attemptedStatus?: VerifiedCommitStatus;
  readonly attemptedReason?: VerifiedCommitReason;
  readonly effectPhase?: "pre-effect" | "post-effect";
  readonly failureKind?: string;
  readonly errorClass?: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

function verifiedCommitErrorFields(
  error: unknown,
): Pick<
  VerifiedCommitActivityFields,
  "failureKind" | "errorClass" | "code" | "frames" | "causeChain"
> {
  const failureKind = gitDeliveryActivityFailureKind(errorKindOf(error));
  const detail = describeError(error);
  const code = gitDeliveryActivityCode(detail.code);
  return {
    failureKind,
    errorClass: detail.errorClass,
    ...(code === undefined ? {} : { code }),
    ...(detail.frames === undefined ? {} : { frames: detail.frames }),
    ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
  };
}

function failedVerificationCheckCount(report: VerificationReport): number {
  return report.results.filter(
    ({ status }) => status === "failed" || status === "timed-out" || status === "resource-exceeded",
  ).length;
}

const TTL_MS = 5 * 60 * 1000;
interface VerificationTicket {
  readonly context: VerifiedCommitRunContext;
  readonly facts: VerifiedCommitFacts;
  readonly startedAtMs: number;
  /** Full access verified a staged candidate while untracked files lay outside it (#3907). */
  readonly untracked: boolean;
}
interface VerificationProof extends VerificationTicket {
  readonly evidenceId: string;
  readonly passed: boolean;
  /** The checks ran on this unchanged candidate and at least one failed: evidence, not proof. */
  readonly failed: boolean;
  /** The checks ran on a working tree that also held untracked files: evidence, not proof. */
  readonly unproven: boolean;
}

// Why a completed verification cannot prove the candidate, or undefined when it does. The cause is
// on the verification line: a Linux run whose sandbox left untracked files behind read only as
// `passed: false` beside zero failed checks (PR #4095).
function verificationRejection(
  before: VerificationTicket,
  after: VerifiedCommitFacts,
  report: VerificationReport,
  now: number,
): "verification-failed" | "candidate-drift" | "verification-stale" | undefined {
  if (
    report.workspaceRoot !== before.context.workspace.root ||
    !commitVerificationReportPassed(report, before.startedAtMs, now)
  )
    return "verification-failed";
  if (!sameVerifiedCommitFacts(before.facts, after)) return "candidate-drift";
  if (now - before.startedAtMs >= TTL_MS) return "verification-stale";
  return undefined;
}

// A completed verification of this exact, unchanged candidate whose checks ran and failed (#3907).
function failingEvidence(
  before: VerificationTicket,
  after: VerifiedCommitFacts,
  report: VerificationReport,
  now: number,
): boolean {
  return (
    report.workspaceRoot === before.context.workspace.root &&
    commitVerificationReportFailed(report, before.startedAtMs, now) &&
    sameVerifiedCommitFacts(before.facts, after) &&
    now - before.startedAtMs < TTL_MS
  );
}

// Full access commits the staged candidate while untracked files lie outside it, as a plain `git
// commit` does (owner decision 2026-10-30, #3907): the parity lane's own `npm install` had left an
// untracked package-lock.json, and the model, which rightly kept it out of the commit, read
// candidate-not-staged until the run's deadline. Unstaged changes and unsaved buffers still refuse.
function untrackedOutsideCandidate(
  context: VerifiedCommitRunContext,
  facts: VerifiedCommitFacts,
): boolean {
  const blocking = facts.blocking;
  return (
    !facts.clean &&
    blocking?.unstagedCount === 0 &&
    blocking.untrackedCount > 0 &&
    context.buffersClean()
  );
}

// The same staged candidate on the same head and base; untracked files outside it are not compared.
function sameCommitCandidate(a: VerifiedCommitFacts, b: VerifiedCommitFacts): boolean {
  return (
    a.headSha === b.headSha &&
    a.baseSha === b.baseSha &&
    a.stagedTreeDigest === b.stagedTreeDigest &&
    a.repositoryDigest === b.repositoryDigest
  );
}

// A verification that ran to its end, passing or failing, on an unchanged staged candidate that had
// untracked files beside it: it describes the working tree, not the commit, so it is never a proof.
function untrackedEvidence(
  context: VerifiedCommitRunContext,
  before: VerificationTicket,
  after: VerifiedCommitFacts,
  report: VerificationReport,
  now: number,
): boolean {
  const ran =
    commitVerificationReportPassed(report, before.startedAtMs, now) ||
    commitVerificationReportFailed(report, before.startedAtMs, now);
  return (
    report.workspaceRoot === before.context.workspace.root &&
    ran &&
    sameCommitCandidate(before.facts, after) &&
    (after.clean || untrackedOutsideCandidate(context, after)) &&
    now - before.startedAtMs < TTL_MS
  );
}

interface VerificationVerdict {
  readonly rejection: ReturnType<typeof verificationRejection> | "candidate-not-staged";
  readonly passed: boolean;
  readonly failed: boolean;
  readonly unproven: boolean;
}

// A ticket issued beside untracked files can never prove the candidate; it is unproven evidence or
// nothing. Any other ticket is a proof, failing evidence, or nothing.
function verificationVerdict(
  context: VerifiedCommitRunContext,
  before: VerificationTicket,
  after: VerifiedCommitFacts,
  report: VerificationReport,
  now: number,
): VerificationVerdict {
  if (before.untracked) {
    const unproven = untrackedEvidence(context, before, after, report, now);
    return { rejection: "candidate-not-staged", passed: false, failed: false, unproven };
  }
  const rejection = verificationRejection(before, after, report, now);
  const passed = rejection === undefined;
  const failed = !passed && failingEvidence(before, after, report, now);
  return { rejection, passed, failed, unproven: false };
}

function blockingCounts(
  facts: VerifiedCommitFacts,
): Pick<VerifiedCommitActivityFields, "unstagedCount" | "untrackedCount"> {
  if (facts.blocking === undefined) return {};
  return {
    unstagedCount: facts.blocking.unstagedCount,
    untrackedCount: facts.blocking.untrackedCount,
  };
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

// The cause split of `recordMissingProof`, for a verification that cannot form a proof (#3612):
// with nothing unstaged or untracked, unsaved editor buffers are what keeps the candidate from
// equalling the working tree, and staging cannot resolve them.
function unverifiableCandidateReason(
  context: VerifiedCommitRunContext,
  blocking: VerifiedCommitBlockingPaths,
): "candidate-not-staged" | "buffers-dirty" {
  return blocking.unstagedCount + blocking.untrackedCount === 0 && !context.buffersClean()
    ? "buffers-dirty"
    : "candidate-not-staged";
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

type VerificationTicketIdentity = Pick<VerifiedCommitRunContext, "runId" | "correlationId"> & {
  readonly verificationGeneration: number;
};

class VerifiedCommitController implements VerifiedCommitService {
  // Weak, body-free log identities survive invalidation without retaining any authority or facts.
  private readonly ticketIdentities = new WeakMap<object, VerificationTicketIdentity>();
  private generation = 0;
  private tickets = new WeakMap<object, VerificationTicket>();
  private proof: VerificationProof | undefined;
  // The run's verification history for the pull request's check list (F57). Keyed by run so a new
  // run starts empty, and kept across invalidate(), which every new verification calls.
  private checks:
    { readonly runId: string; readonly history: VerificationCheckHistory } | undefined;
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

  public async beginVerification(): Promise<VerificationTicketOutcome> {
    // An unclean read always carries its paths; the empty set only types the impossible absence.
    this.invalidate();
    const context = this.context();
    if (context === undefined) return { kind: "unavailable" };
    const identity = {
      runId: context.runId,
      correlationId: context.correlationId,
      verificationGeneration: this.generation,
    };
    this.log(context, "verification-started", {
      verificationGeneration: identity.verificationGeneration,
    });
    const facts = await this.facts(context);
    const untracked = this.admitsUntracked(context, facts);
    if (!facts.clean && !untracked) {
      // Named, not merely counted, for the model: the blocking paths travel on the tool result,
      // only their counts on this line (run 16, 2026-09-10).
      const blocking = facts.blocking ?? NO_BLOCKING_PATHS;
      const reason = unverifiableCandidateReason(context, blocking);
      this.log(context, "verification-unavailable", {
        reason,
        unstagedCount: blocking.unstagedCount,
        untrackedCount: blocking.untrackedCount,
      });
      return { kind: "refused", reason, blocking };
    }
    const ticket = {};
    this.tickets.set(ticket, { context, facts, startedAtMs: this.now(), untracked });
    this.ticketIdentities.set(ticket, identity);
    return { kind: "ticket", ticket };
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
    const identity = this.ticketIdentities.get(ticket);
    this.ticketIdentities.delete(ticket);
    const context = this.context();
    if (before === undefined || context === undefined || !contextMatches(context, before.context)) {
      this.recordDiscardedTicket(identity);
      return false;
    }
    if (!this.verificationGuardLive(context, guard)) return false;
    let after: VerifiedCommitFacts;
    try {
      after = await this.facts(guardedVerificationContext(context, guard));
    } catch (error) {
      if (!this.verificationGuardLive(context, guard)) return false;
      throw error;
    }
    if (!this.verificationGuardLive(context, guard)) return false;
    const now = this.now();
    const { rejection, passed, failed, unproven } = verificationVerdict(
      context,
      before,
      after,
      report,
      now,
    );
    const history = this.recordCheck(context.runId, report, before.facts.stagedTreeDigest);
    const evidenceId = this.recordVerificationEvidence(context, before.facts, report, history);
    this.proof = { ...before, passed, failed, unproven, evidenceId };
    this.log(context, "verification", {
      passed,
      ...(rejection === undefined ? {} : { reason: rejection }),
      ...blockingCounts(after),
      verificationEvidenceId: evidenceId,
      checkCount: history.records.length,
      failedCheckCount: failedVerificationCheckCount(report),
    });
    return passed;
  }

  private recordDiscardedTicket(identity: VerificationTicketIdentity | undefined): void {
    if (identity === undefined) return;
    this.log(identity, "verification-discarded", {
      reason: "verification-stale",
      verificationGeneration: identity.verificationGeneration,
      currentGeneration: this.generation,
    });
  }

  public observeVerification(report: VerificationReport): void {
    const context = this.context();
    if (context === undefined) return;
    const history = this.recordCheck(context.runId, report);
    // The history is what the pull request's check list reads, so an addition on the unstaged path
    // leaves a line just as the proof path's does (review on PR #3452).
    this.log(context, "verification-observed", {
      checkCount: history.records.length,
      failedCheckCount: failedVerificationCheckCount(report),
      omittedCount: history.omitted,
    });
  }

  private recordCheck(
    runId: string,
    report: VerificationReport,
    stagedTreeDigest?: string,
  ): VerificationCheckHistory {
    const previous =
      this.checks?.runId === runId ? this.checks.history : EMPTY_VERIFICATION_CHECK_HISTORY;
    const history = appendVerificationCheck(
      previous,
      verificationCheckRecord(report, stagedTreeDigest),
    );
    this.checks = { runId, history };
    return history;
  }

  private recordVerificationEvidence(
    context: VerifiedCommitRunContext,
    facts: VerifiedCommitFacts,
    report: VerificationReport,
    history: VerificationCheckHistory,
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
      // The run's verification history up to this proof, for the pull request's check list (F57).
      checks: history,
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
    // Two different facts, two words (#3390): no verification of this workspace at all, or a
    // latest verification that did not pass (it failed, or executed nothing). Rehearsal run-16's
    // model read "verification-missing" after a verification it had just watched succeed and gave
    // the delivery up; the proof it lacked was a PASSING latest verification.
    if (verification === undefined) return this.recordMissingProof(context, binding, facts);
    if (!verification.passed && !this.admitsFailedVerification(verification))
      return this.record(context, binding, "verification-failed", "verification-failed");
    if (
      !contextMatches(context, verification.context) ||
      !this.candidateCurrent(context, verification.facts, facts) ||
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
    return this.prepareProposal(context, facts, binding, message, !verification.passed);
  }

  // Full access commits what the human asked for even when the candidate's checks ran red (owner
  // decision 2026-10-30, #3907): the failing evidence stays bound to the commit and its log lines,
  // never presented as a pass. Every other mode keeps a passing verification as the gate.
  private admitsFailedVerification(verification: VerificationProof): boolean {
    return (verification.failed || verification.unproven) && this.fullAccess();
  }

  private fullAccess(): boolean {
    return this.options.policyAllowsWithoutApproval?.("commit") === true;
  }

  private admitsUntracked(context: VerifiedCommitRunContext, facts: VerifiedCommitFacts): boolean {
    return this.fullAccess() && untrackedOutsideCandidate(context, facts);
  }

  // The verified staged candidate, unchanged. Full access also admits untracked files beside it,
  // whether they lay there while the verification ran (unproven) or a test run left them after it
  // passed (T19's pytest cache): the commit holds the staged tree alone (#3907).
  private candidateCurrent(
    context: VerifiedCommitRunContext,
    verified: VerifiedCommitFacts,
    facts: VerifiedCommitFacts,
  ): boolean {
    if (sameVerifiedCommitFacts(verified, facts)) return true;
    return (
      sameCommitCandidate(verified, facts) &&
      (verified.clean || untrackedOutsideCandidate(context, verified)) &&
      (facts.clean || this.admitsUntracked(context, facts))
    );
  }

  /** The untracked paths a Full-access commit leaves outside, once its verification ran (#3907). */
  public unprovenAdmission(): VerifiedCommitBlockingPaths | undefined {
    const verification = this.proof;
    if (verification?.unproven !== true || !this.fullAccess()) return undefined;
    return verification.facts.blocking;
  }

  private async prepareProposal(
    context: VerifiedCommitRunContext,
    facts: VerifiedCommitFacts,
    binding: VerifiedCommitBinding,
    message: string,
    verificationFailed: boolean,
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
    if (!this.candidateCurrent(context, facts, afterReview))
      return this.record(context, binding, "drift", "candidate-drift");
    const proposal: VerifiedCommitProposal = {
      binding,
      review,
      context,
      expiresAtMs: this.now() + TTL_MS,
      ...(verificationFailed ? { verificationFailed: true as const } : {}),
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
      (facts.clean || this.admitsUntracked(proposal.context, facts)) &&
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
    this.log(
      proposal.context,
      "execute",
      { state: "failed", ...verifiedCommitErrorFields(error) },
      true,
    );
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
    if (this.options.policyAllowsWithoutApproval?.("commit") === true) {
      this.log(context, "approval", {
        proposalId: binding.proposalId,
        state: "policy-authorized",
        ...(proposal.verificationFailed === true
          ? { passed: false, verificationEvidenceId: binding.verificationEvidenceId }
          : {}),
      });
      return this.executeConsumed(proposal, { required: false });
    }
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
    if (!claim.required && this.options.policyAllowsWithoutApproval?.("commit") !== true)
      return this.record(context, binding, "blocked", "approval-invalid");
    // Only Full access admits a failed verification, so a mode lowered after the proposal turns the
    // red checks back into the gate, whatever approval reached this point.
    if (
      proposal.verificationFailed === true &&
      this.options.policyAllowsWithoutApproval?.("commit") !== true
    )
      return this.record(context, binding, "verification-failed", "verification-failed");
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
    // The marker is the write-ahead, not an outcome: logged as a "result" it showed every
    // successful commit as recovery-required first (coding runs 26 and 27, F80). The terminal result
    // follows from `record()`; reconcile() reads the persisted marker, never this line.
    this.log(context, "write-ahead", {
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
      this.log(context, "execute", { state: "failed", ...verifiedCommitErrorFields(error) }, true);
      return this.record(context, binding, "recovery-required", "execution-uncertain");
    }
  }

  private contextIsCurrent(context: VerifiedCommitRunContext): boolean {
    const current = this.context();
    return current !== undefined && contextMatches(current, context);
  }

  // No proof at all has three causes that need different next steps (#3610): an unstaged or
  // untracked part of the change, which no verification can prove until it is staged; unsaved editor
  // buffers, which staging cannot resolve (review on #3611); and a clean staged candidate nobody
  // verified yet. Naming the first as "verification-missing" sent the model back to a verification
  // that answered candidate-not-staged, round and round. The cause comes from the same read's
  // blocking paths, never from the combined clean flag.
  private recordMissingProof(
    context: VerifiedCommitRunContext,
    binding: VerifiedCommitBinding,
    facts: VerifiedCommitFacts,
  ): VerifiedCommitResult {
    const blocking = facts.blocking;
    if (blocking !== undefined && blocking.unstagedCount + blocking.untrackedCount > 0)
      return this.record(context, binding, "verification-failed", "candidate-not-staged");
    if (!context.buffersClean()) return this.record(context, binding, "blocked", "buffers-dirty");
    return this.record(context, binding, "verification-failed", "verification-missing");
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
          ...verifiedCommitErrorFields(error),
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
    context: Pick<VerifiedCommitRunContext, "runId" | "correlationId">,
    phase: VerifiedCommitActivityPhase,
    extra: VerifiedCommitActivityFields,
    failed = false,
  ): void {
    (this.options.execution?.activityLog ?? processServerLogSink()).write(
      activityLogEvent(
        VERIFIED_COMMIT_OPERATION,
        {
          correlationId: context.correlationId,
          ...(failed
            ? {
                level: "warn",
                errorKind: gitDeliveryActivityErrorKind(extra.failureKind ?? "internal"),
              }
            : {}),
        },
        { phase, runId: context.runId, ...extra },
      ),
    );
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

const NO_BLOCKING_PATHS: VerifiedCommitBlockingPaths = Object.freeze({
  unstagedCount: 0,
  untrackedCount: 0,
  unstaged: [],
  untracked: [],
});

export function createVerifiedCommitService(
  options: VerifiedCommitServiceOptions,
): VerifiedCommitService {
  return new VerifiedCommitController(options);
}
