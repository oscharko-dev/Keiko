// Governed local Git execution core for the #475 branch/staging/commit routes (Epic #470).
//
// Both #475 route groups (localMutationRoutes, commitRoutes) share ONE execution path: resolve and
// authorize the project workspace, build a TRUSTWORTHY snapshot from the live worktree, drive the
// #472 kernel `runGitMutation` (the sole execution authority — preflight + policy + approval gates),
// and append a content-free evidence record through the #474 ledger. No second orchestrator, no
// generic shell, no terminal-allowlist widening. The git Node effect (adapter + reader) is injected
// via seams so route tests run deterministically against a fake repository.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  CommandTerminationEvidence,
  GitDeliveryActionKind,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryExecutionErrorCode,
  GitDeliveryExecutionResult,
  GitDeliveryRepoPolicyPack,
  GitSyncOperation,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import {
  activityLogEvent,
  defineActivityLogOperation,
  isErrorKind,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  buildGitDeliveryEvidenceRecord,
  runGitMutation,
  type GitLocalMutationAdapter,
  type GitMutationCommand,
  type GitMutationLifecycleResult,
  type GitMutationOutcome,
  type GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import {
  createNodeGitMutationAdapter,
  readGitStagedDiff,
  readGitWorktreeSnapshot,
  readStagedConflictMarkerFileCount,
  readStagedPaths,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { UiHandlerDeps } from "../deps.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { logWorkspaceLifecycleFailure } from "../task-workspace/activity-log.js";
import { asRepositoryUnreachable, TaskWorkspaceError } from "../task-workspace/errors.js";
import {
  requiresConfiguredManagedWorkspaceAuthority,
  resolveManagedWorkspaceRootAccess,
  resolveRegisteredOrManagedWorkspaceRoot,
  type WorkspaceRootAccessDenialLogging,
} from "../task-workspace/workspace-root-access.js";
import type { GitDeliveryApprovalStore } from "./approvalStore.js";
import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import type { GitDeliveryBranchProtectionReader } from "./branchProtectionPreflight.js";
import { recordGitDeliveryMutationEvidence } from "./mutationEvidenceLedger.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import { errorKindOf, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import { logCommandTermination, processServerLogSink } from "../process-log-sink.js";

const KEIKO_DEFAULT_PROTECTED_BRANCH_PATTERNS = [
  { matchKind: "exact", value: "dev" },
  { matchKind: "exact", value: "main" },
] as const;

const GIT_DELIVERY_MUTATION_ACTIONS = [
  "branch-create",
  "branch-switch",
  "stage",
  "unstage",
  "commit",
  "push",
  "pr-create",
  "pr-update",
  "pr-description-apply",
  "pr-mark-ready",
  "merge",
  "abort",
  "recovery",
] as const;

const GIT_DELIVERY_FAILURE_FRAMES_FIELD = {
  type: "string-array",
  dataClass: "safe-platform-class",
  required: false,
  maxLength: 512,
  maxItems: 8,
} as const;

const GIT_DELIVERY_FAILURE_CAUSE_CHAIN_FIELD = {
  type: "string-array",
  dataClass: "error-kind",
  required: false,
  maxLength: 128,
  maxItems: 5,
} as const;

const DISPATCH_NO_SPAWN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.dispatch.no-spawn",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/execution.logGitDeliveryNoSpawnRefusal",
  fields: {
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...GIT_DELIVERY_MUTATION_ACTIONS, "fetch", "pull"],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-delivery-authority-continuity"],
  proofIds: ["git.delivery.dispatch.no-spawn.emitted-line"],
  releaseImpact: "patch",
});

const UPSTREAM_TRACKING_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.push.upstream-tracking-failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "gitDelivery/execution.logGitDeliveryUpstreamTrackingFailed",
  fields: {},
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-upstream-tracking"],
  proofIds: ["git.delivery.push.upstream-tracking-failed.emitted-line"],
  releaseImpact: "patch",
});

const MUTATION_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.mutation.completed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "gitDelivery/execution.logGitDeliveryMutation",
  fields: {
    actionId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    actionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...GIT_DELIVERY_MUTATION_ACTIONS],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "approval-required", "blocked", "failed", "recovery-required"],
    },
    phaseReached: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["resolve", "preflight", "preview", "policy", "execute", "result"],
    },
    policyOutcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["allowed", "blocked", "approval-gated", "constrained"],
    },
    preflightFindingCount: { type: "integer", dataClass: "count", required: true },
    preflightBlockingCount: { type: "integer", dataClass: "count", required: true },
    requiredApproverCount: { type: "integer", dataClass: "count", required: true },
    blockReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "policy-pack-blocked",
        "authority-denied",
        "protected-branch",
        "provider-capability-absent",
        "approval-expired",
        "approver-not-authorized",
        "risk-class-ceiling",
        "head-hash-mismatch",
        "no-applicable-rule",
      ],
    },
    executionErrorCode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "provider-rejected",
        "network-failure",
        "conflict",
        "precondition-failed",
        "signature-failed",
        "timeout",
        "internal-error",
      ],
    },
    rejectionReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "already-exists",
        "base-missing",
        "head-unpublished",
        "validation-error",
        "permission-denied",
        "not-found",
        "rate-limited",
        "provider-unavailable",
        "unknown",
        "non-fast-forward",
        "fetch-first",
        "no-upstream",
        "auth-failed",
        "protected-ref",
        "remote-unavailable",
        "not-mergeable",
        "checks-failing",
        "approvals-missing",
        "conflict",
        "head-modified",
        "strategy-unavailable",
        "branch-protection",
        "already-merged",
      ],
    },
    failureClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "argv-invalid",
        "invocation-error",
        "output-truncated",
        "number-unparsable",
        "identity-unparsable",
      ],
    },
    identityIssue: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "json-invalid",
        "output-redacted",
        "shape-invalid",
        "repository-mismatch",
        "head-repository-mismatch",
        "head-ref-mismatch",
        "base-ref-mismatch",
        "draft-mismatch",
        "state-not-open",
      ],
    },
    stdoutBytes: { type: "integer", dataClass: "count", required: false },
    stderrBytes: { type: "integer", dataClass: "count", required: false },
    exitCode: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["git-delivery-mutation"],
  proofIds: ["git.delivery.mutation.completed.emitted-line"],
  releaseImpact: "patch",
});

const MUTATION_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.mutation.failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "gitDelivery/execution.logGitDeliveryMutationFailure",
  fields: {
    actionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...GIT_DELIVERY_MUTATION_ACTIONS],
    },
    phaseReached: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["snapshot", "readiness", "post-observation", "dispatch"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    frames: GIT_DELIVERY_FAILURE_FRAMES_FIELD,
    causeChain: GIT_DELIVERY_FAILURE_CAUSE_CHAIN_FIELD,
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-delivery-precondition"],
  proofIds: ["git.delivery.mutation.failed.emitted-line"],
  releaseImpact: "patch",
});

// Default trusted policy: PERMIT the lowest risk class (branch create/switch, stage, unstage, and
// feature-branch commits), block local commits on protected integration branches, and fail-closed for
// everything else (publish / protected-or-merge / recovery). It applies when no stricter pack is
// configured. The decision is still EVALUATED for every action — governance is preserved.
export const KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "keiko-local-default",
  rules: [
    {
      actionKind: "commit",
      decision: "constrained",
      constraints: [
        { kind: "risk-class-ceiling", maxRiskClass: "local-mutation" },
        { kind: "protected-branch", patterns: KEIKO_DEFAULT_PROTECTED_BRANCH_PATTERNS },
      ],
    },
  ],
  defaultRule: {
    decision: "constrained",
    constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
  },
};

export interface GitDeliveryExecutionSeams {
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly beforeCommitRefUpdate?: (() => boolean) | undefined;
  readonly beforeIndexUpdate?: (() => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly adapterFactory?: ((workspace: WorkspaceInfo) => GitLocalMutationAdapter) | undefined;
  readonly snapshotReader?:
    ((workspace: WorkspaceInfo) => Promise<GitWorktreeSnapshot>) | undefined;
  readonly stagedPathsReader?:
    ((workspace: WorkspaceInfo) => Promise<readonly string[]>) | undefined;
  readonly stagedDiffReader?: ((workspace: WorkspaceInfo) => Promise<string>) | undefined;
  // Injectable seam for the staged-conflict-marker guard (see readStagedConflictMarkerFileCountFor).
  readonly conflictMarkerReader?: ((workspace: WorkspaceInfo) => Promise<number>) | undefined;
  readonly branchProtectionReader?: GitDeliveryBranchProtectionReader | undefined;
  readonly policyPacks?: GitDeliveryTrustedPolicyPacks | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly now?: (() => number) | undefined;
  readonly newActionId?: (() => string) | undefined;
  // Test seam for VERIFIED_HEAD_RESTAMP_DEADLINE_MS, so the non-settling-port regression can prove
  // the bound in milliseconds instead of ten real seconds.
  readonly verifiedHeadRestampDeadlineMs?: number | undefined;
}

// projectId IS the workspace root path (mirrors the terminal execution manager). Resolving it through
// the UI project store both AUTHORIZES the path (only a registered project may be mutated) and yields
// the WorkspaceInfo the spawn boundary runs in.
export function resolveProjectWorkspace(
  deps: Pick<UiHandlerDeps, "managedTaskWorkspaceRoot" | "store" | "workspaceProvisioning">,
  projectId: string,
): WorkspaceInfo | undefined {
  return resolveRegisteredOrManagedWorkspaceRoot(deps, projectId);
}

/**
 * What `executeGovernedMutation` needs from the request deps: the evidence pair it always used,
 * plus the two managed-workspace fields the root re-proof below runs on. Both managed fields are
 * OPTIONAL on `UiHandlerDeps`, so every existing caller — production routes passing the whole deps
 * bag, and route tests passing an evidence-only literal — satisfies this unchanged.
 */
export type GitDeliveryMutationDeps = Pick<
  UiHandlerDeps,
  "evidenceStore" | "redactor" | "managedTaskWorkspaceRoot" | "workspaceProvisioning"
>;

/** A governed mutation refused because the admitted workspace root no longer re-proves. */
export class GitDeliveryRootAuthorityRevokedError extends Error {
  public constructor() {
    // The message is the classification: this error is diagnosed by its name and by the
    // `git.delivery.dispatch.no-spawn` line written before it is thrown, never by free text.
    super("git-delivery-root-authority-revoked");
    this.name = "GitDeliveryRootAuthorityRevokedError";
  }
}

/**
 * The managed-root re-proof this execution path carries to every spawn (#3347 owner P1).
 *
 * `resolveProjectWorkspace` admits a managed worktree through the strong prover and then collapses
 * it to a path-only `WorkspaceInfo`; nothing in that value can observe an archive or an identity
 * replacement that happens after admission, so the multi-command snapshot read and the mutation
 * commands that follow it could run in a repository that had replaced the admitted one. This
 * closure re-runs the SAME prover (`resolveManagedWorkspaceRootAccess`) and requires the re-proved
 * capability to still be a managed-task grant for the identical canonical path. Its refusals are
 * reported by the prover itself, on the existing `workspace.root.denied` vocabulary.
 *
 * An ordinary registered project is not under managed authority and keeps its previous outcome —
 * the classifier is the same one admission used, not a second path-shape rule.
 */
export function managedRootStillAuthorized(
  deps: Pick<UiHandlerDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">,
  workspace: WorkspaceInfo,
  logging: WorkspaceRootAccessDenialLogging,
): () => boolean {
  if (!requiresConfiguredManagedWorkspaceAuthority(deps, workspace.root)) {
    return (): boolean => true;
  }
  return (): boolean => {
    const access = resolveManagedWorkspaceRootAccess(deps, workspace.root, logging);
    return access?.kind === "managed-task" && access.canonicalRoot === workspace.root;
  };
}

/**
 * The canonical managed task-worktree root this mutation ran in, or `undefined` when the workspace is
 * an ordinary registered project.
 *
 * Asks the SAME prover admission and the mid-flight re-proof use (`resolveManagedWorkspaceRootAccess`)
 * and reads its `kind` discriminator, rather than re-deriving "is this managed" from path shape. The
 * classifier gate in front of it is the one `managedRootStillAuthorized` uses, so an ordinary root
 * costs no prover call and produces no managed-authority denial line.
 */
function managedTaskWorktreeRoot(
  deps: Pick<UiHandlerDeps, "managedTaskWorkspaceRoot" | "workspaceProvisioning">,
  workspace: WorkspaceInfo,
  logging: WorkspaceRootAccessDenialLogging,
): string | undefined {
  if (!requiresConfiguredManagedWorkspaceAuthority(deps, workspace.root)) return undefined;
  const access = resolveManagedWorkspaceRootAccess(deps, workspace.root, logging);
  return access?.kind === "managed-task" ? access.canonicalRoot : undefined;
}

/**
 * How long a governed commit will wait for its verified-head restamp before giving up on it.
 *
 * The restamp serializes on the workspace's `ws:` key, and `WorkspaceMutexRegistry.runExclusive` has
 * no cancellation — so the wait is bounded by whatever holds that key, not by the git spawn (which
 * the adapter already times out). Ten seconds is far longer than any healthy holder of that key
 * (a reconcile of one row, a repair, a cleanup) and far shorter than a client's patience: it is a
 * containment bound for a wedged holder, not a performance budget. Whatever the restamp fails to
 * record, the NEXT reconciliation pass classifies from live facts, so expiring here costs one
 * `head-moved` marker and the operator-approved `accept-moved-head` repair — never the commit.
 */
const VERIFIED_HEAD_RESTAMP_DEADLINE_MS = 10_000;

interface RestampDeadline {
  readonly signal: AbortSignal;
  // Resolves — never rejects — once the deadline has passed and the signal has been aborted.
  readonly expiry: Promise<"expired">;
  readonly dispose: () => void;
}

// The timer is `unref`'d so a pending restamp can never hold the process open, and cleared as soon
// as the race settles so a completed request leaves nothing behind.
function restampDeadline(deadlineMs: number): RestampDeadline {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("expired");
    }, deadlineMs);
    timer.unref();
  });
  return {
    signal: controller.signal,
    expiry,
    dispose: (): void => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Records the head Keiko's own governed COMMIT just wrote as the managed workspace's verified head
 * (#3382).
 *
 * `lastVerifiedHead` is the baseline `classifyWorkspaceReconciliation` measures `head-moved` against,
 * and until this call existed nothing wrote it outside a healthy reconciliation pass. Every governed
 * commit inside a managed task worktree therefore moved HEAD away from that baseline, the next pass
 * persisted `head-moved`, and `productionRuntimeWorkspaceAuthority` refused the workspace for every
 * further run — with `DRIFT_MARKER_RECOVERY["head-moved"]` mapped to a strategy `repair.ts` executes
 * for no marker, nothing could ever clear it.
 *
 * Scope, deliberately narrow:
 *  - only a COMMIT (the only local mutation kind that moves HEAD),
 *  - only when the kernel reports it `succeeded` and the authority guard did NOT refuse dispatch,
 *  - only inside a root the managed prover still admits as a managed task worktree.
 * Anything else — a move Keiko did not make, an ordinary project, a blocked or failed commit — leaves
 * the baseline untouched and still classifies as drift, which the operator-approved
 * `accept-moved-head` repair is the exit for.
 *
 * Best-effort and BOUNDED: the commit has already happened AND its lifecycle evidence is already
 * persisted, so nothing this seam does may change the mutation's outcome. `recordVerifiedHead` is a
 * PORT, and both ways it can fail the caller are contained here, at the seam that documents the
 * contract:
 *  - it REJECTS — an unguarded `await` reported a committed, evidenced mutation as failed, because
 *    the commit route maps any rejection to `409 …WORKTREE_UNAVAILABLE` (CodeRabbit, PR #3381);
 *  - it never SETTLES — the port queues on the workspace's `ws:` key and that wait has no
 *    cancellation, so a wedged holder left this `await` pending and the request hung on a commit
 *    that had already succeeded (CodeRabbit, PR #3381). The call is therefore raced against
 *    `VERIFIED_HEAD_RESTAMP_DEADLINE_MS`, whose expiry aborts the port's signal so the abandoned
 *    attempt can never persist anything afterwards.
 * Neither is silent: both land on the same body-free `task-workspace.lifecycle` failure line the
 * task-workspace layer uses, classified, with frames + cause chain, under this mutation's
 * correlation id.
 */
async function restampManagedTaskWorkspaceHead(
  deps: GitDeliveryMutationDeps,
  workspace: WorkspaceInfo,
  command: GitMutationCommand,
  lifecycle: GitMutationLifecycleResult,
  seams: GitDeliveryExecutionSeams,
  logging: WorkspaceRootAccessDenialLogging,
): Promise<void> {
  // `succeeded` is the whole gate: a dispatch the authority guard refused is recorded as
  // `blocked`/`authority-denied` by `authorityDeniedGitDeliveryLifecycle`, so it can never reach here.
  if (command.kind !== "commit" || lifecycle.outcome.status !== "succeeded") return;
  const managedWorktreePath = managedTaskWorktreeRoot(deps, workspace, logging);
  if (managedWorktreePath === undefined) return;
  const deadline = restampDeadline(
    seams.verifiedHeadRestampDeadlineMs ?? VERIFIED_HEAD_RESTAMP_DEADLINE_MS,
  );
  const recorded = recordVerifiedHeadThrough(deps, managedWorktreePath, deadline.signal, logging);
  try {
    if ((await Promise.race([recorded, deadline.expiry])) === "expired") {
      reportRestampFailure(
        logging,
        managedWorktreePath,
        new TaskWorkspaceError(
          "LOCK_CONTENTION",
          "the verified-head restamp did not settle within its deadline",
        ),
      );
    }
  } catch (error) {
    reportRestampFailure(
      logging,
      managedWorktreePath,
      asRepositoryUnreachable(error, "the verified-head restamp port rejected"),
    );
  } finally {
    deadline.dispose();
  }
}

// One classified line for either failure mode. The seed is hashed before it reaches the log
// (`workspaceLogIdentity`), so the worktree path never leaves this frame; an already-classified
// TaskWorkspaceError passes through `asRepositoryUnreachable` unchanged.
function reportRestampFailure(
  logging: WorkspaceRootAccessDenialLogging,
  managedWorktreePath: string,
  error: TaskWorkspaceError,
): void {
  logWorkspaceLifecycleFailure(
    logging,
    {
      operation: "verify-head",
      workspaceIdentitySeed: managedWorktreePath,
      correlationId: logging.correlationId,
    },
    error,
  );
}

// The port call, with a LATE rejection still reported rather than dropped. Once the deadline has
// won the race this promise has no awaiter left, and an unhandled rejection would either crash the
// process or vanish — so the handler lives on the call itself. It is not an empty catch: a late
// failure is a real fact about a restamp that was already reported as expired, and it is logged
// under the same operation and correlation id as everything else on this path.
function recordVerifiedHeadThrough(
  deps: GitDeliveryMutationDeps,
  managedWorktreePath: string,
  signal: AbortSignal,
  logging: WorkspaceRootAccessDenialLogging,
): Promise<"recorded"> {
  const call =
    deps.workspaceProvisioning?.recordVerifiedHead?.({
      managedWorktreePath,
      signal,
      ...(logging.correlationId === undefined ? {} : { correlationId: logging.correlationId }),
    }) ?? Promise.resolve(false);
  return call.then(
    (): "recorded" => "recorded",
    (error: unknown): never => {
      if (signal.aborted) {
        reportRestampFailure(
          logging,
          managedWorktreePath,
          asRepositoryUnreachable(error, "the verified-head restamp failed after its deadline"),
        );
      }
      throw error;
    },
  );
}

// One refusal record per governed mutation: it writes the no-spawn marker the instant the guard
// refuses a dispatch, and remembers that it did so, so the terminal lifecycle can be projected as
// the governance block it is instead of the adapter's synthetic transport abort.
interface MutationDispatchRefusal {
  readonly deny: () => void;
  readonly denied: () => boolean;
}

function mutationDispatchRefusal(
  activityLog: ServerLogSink,
  actionKind: GitDeliveryActionKind,
  correlationId: string | undefined,
): MutationDispatchRefusal {
  let denied = false;
  return {
    deny: (): void => {
      denied = true;
      logGitDeliveryNoSpawnRefusal(activityLog, actionKind, correlationId);
    },
    denied: (): boolean => denied,
  };
}

type MutationDispatch<Req> = (request: Req) => Promise<GitDeliveryExecutionResult>;

function guardedMutationDispatch<Req>(
  dispatch: MutationDispatch<Req>,
  refuseDispatch: () => GitDeliveryExecutionResult | undefined,
): MutationDispatch<Req> {
  return (request): Promise<GitDeliveryExecutionResult> => {
    const refusal = refuseDispatch();
    return refusal === undefined ? dispatch(request) : Promise.resolve(refusal);
  };
}

// Mirrors pushExecution.ts/prExecution.ts/mergeExecution.ts's `authorityGuarded*Adapter`: the real
// adapter is never called when the guard refuses, so no git process is spawned for that attempt.
// The synthetic `aborted` result exists only to unwind the kernel; the durable governance fact is
// the caller-side authority-denied projection plus the no-spawn marker written by `deny()`.
function authorityGuardedMutationAdapter(
  adapter: GitLocalMutationAdapter,
  stillAuthorized: () => boolean,
  refusal: MutationDispatchRefusal,
): GitLocalMutationAdapter {
  const refuseDispatch = (): GitDeliveryExecutionResult | undefined => {
    if (stillAuthorized()) return undefined;
    refusal.deny();
    return { schemaVersion: GIT_DELIVERY_SCHEMA_VERSION, outcome: "aborted", durationMs: 0 };
  };
  return {
    createBranch: guardedMutationDispatch((req) => adapter.createBranch(req), refuseDispatch),
    switchBranch: guardedMutationDispatch((req) => adapter.switchBranch(req), refuseDispatch),
    stage: guardedMutationDispatch((req) => adapter.stage(req), refuseDispatch),
    unstage: guardedMutationDispatch((req) => adapter.unstage(req), refuseDispatch),
    commit: guardedMutationDispatch((req) => adapter.commit(req), refuseDispatch),
    abort: guardedMutationDispatch((req) => adapter.abort(req), refuseDispatch),
    recover: guardedMutationDispatch((req) => adapter.recover(req), refuseDispatch),
  };
}

// The minimal "does this seam bag carry the caller's chosen activity-log sink" contract every
// termination-evidence composition point across git-delivery depends on. Deliberately narrower
// than `GitDeliveryExecutionSeams` so `gitDeliveryTerminationHandler` is reusable by every sibling
// execution module (pushExecution.ts, prExecution.ts, mergeExecution.ts) and by
// branchProtectionPreflight.ts's default reader — none of which share the local-mutation-specific
// seam shape (adapterFactory, stagedPathsReader, …) but all of which own an `activityLog` seam.
export interface GitDeliveryTerminationLogSeam {
  readonly activityLog?: ServerLogSink | undefined;
}

// Builds the runCommand termination-evidence callback for one git-delivery composition point.
// Threads the caller's own request-scoped correlationId when the call frame has one in scope,
// rather than downgrading to UNKNOWN_CORRELATION_ID while a real id sits one frame up (review
// finding: `executeGovernedMutation` already receives and uses `correlationId` for its own
// `git.delivery.mutation.*` lines, but its `readWorktreeSnapshotFor`/`adapterFor` calls dropped
// it — and, per the follow-up audit, so did every sibling default reader/adapter across
// pushExecution.ts, prExecution.ts, mergeExecution.ts, and branchProtectionPreflight.ts). Also
// resolves the SAME `seams.activityLog` the rest of this file logs through — a hard-coded
// `processServerLogSink()` at the call site would mean a test-injected sink never observed this
// evidence line. Shared by every one of those composition points so the mapping from
// "termination evidence" to "content-free activity-log line" is written exactly once.
export function gitDeliveryTerminationHandler(
  seams: GitDeliveryTerminationLogSeam,
  correlationId: string | undefined,
): (evidence: CommandTerminationEvidence) => void {
  const activityLog = seams.activityLog ?? processServerLogSink();
  return (evidence): void => {
    logCommandTermination(activityLog, correlationIdOrUnknown(correlationId), evidence);
  };
}

// F4: a run refused by the authority-continuity guard immediately before remote dispatch (the accepted
// authority changed mid-flight, or the operator's runtime authority was revoked between admission and
// this attempt) never reaches a real git/gh subprocess — pushExecution.ts / prExecution.ts /
// mergeExecution.ts's `authorityGuarded*Adapter` wrappers return a SYNTHETIC
// `{ outcome: "aborted", durationMs: 0 }` result instead of calling the real adapter. Left unmarked,
// that synthetic result is INDISTINGUISHABLE in the evidence stream from a genuine dispatch that DID
// reach a real subprocess and was then cancelled mid-flight (keiko-tools' CommandCancelledError path
// also produces `{ outcome: "aborted", errorCode: undefined }`) — an operator (or `keiko support
// analyze`) cannot tell "nothing ever ran" from "something ran and was terminated" from the evidence
// record alone. The wire vocabulary (keiko-contracts' closed GitDeliveryExecutionErrorCode) has no
// slot for "never spawned" that would not also misattribute a "user-fixable" git-state recovery hint
// this refusal does not carry, so this body-free activity-log line is the explicit, LOCAL marker
// instead: written the instant the guard refuses, strictly BEFORE the synthetic result is returned, so
// its presence alone (never inferred from a zero duration or cross-referenced against a separate
// authority-decision line) proves no process was spawned for this specific dispatch attempt.
export function logGitDeliveryNoSpawnRefusal(
  activityLog: ServerLogSink,
  operation: GitDeliveryActionKind | GitSyncOperation,
  correlationId: string | undefined,
): void {
  activityLog.write(
    activityLogEvent(
      DISPATCH_NO_SPAWN_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        status: 403,
        errorKind: "authority-denied",
      },
      { operation },
    ),
  );
}

// The interactive pinned-push path's post-push `git branch --set-upstream-to=…` follow-up
// (git-publish-node.ts's `applyUpstreamTrackingIfRequested`, #3394 review, ADR-0085 D6) could not
// establish tracking — either the local-only command exited non-zero or the run itself was
// terminated/denied. Deliberately its OWN op, never folded into `git.delivery.mutation.failed`: the
// governed push already succeeded by the time this can fire, so this line must never read, to an
// operator or `keiko support analyze`, as "the push failed" — it is visibility for "why does this
// freshly pushed branch show no upstream" only. Body-free by construction: the callback that invokes
// this carries no branch/remote/error payload at all.
export function logGitDeliveryUpstreamTrackingFailed(
  activityLog: ServerLogSink,
  correlationId: string | undefined,
): void {
  activityLog.write(
    activityLogEvent(
      UPSTREAM_TRACKING_FAILED_OPERATION,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind: "unavailable",
      },
      {},
    ),
  );
}

export function readWorktreeSnapshotFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  correlationId?: string,
): Promise<GitWorktreeSnapshot> {
  if (seams.snapshotReader !== undefined) return seams.snapshotReader(workspace);
  return readGitWorktreeSnapshot({
    workspace,
    processEnv: process.env,
    now,
    onTerminated: gitDeliveryTerminationHandler(seams, correlationId),
  });
}

export function readStagedPathsFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  correlationId?: string,
): Promise<readonly string[]> {
  if (seams.stagedPathsReader !== undefined) return seams.stagedPathsReader(workspace);
  return readStagedPaths({
    workspace,
    processEnv: process.env,
    now,
    onTerminated: gitDeliveryTerminationHandler(seams, correlationId),
  });
}

export function readStagedDiffFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  correlationId?: string,
): Promise<string> {
  if (seams.stagedDiffReader !== undefined) return seams.stagedDiffReader(workspace);
  return readGitStagedDiff({
    workspace,
    processEnv: process.env,
    now,
    onTerminated: gitDeliveryTerminationHandler(seams, correlationId),
  });
}

// Counts staged files that still contain an unresolved merge-conflict marker (`git diff --cached
// --check`, git's own detector — see readStagedConflictMarkerFileCount). Consumed by the commit
// execute route as a fail-closed guard BEFORE the kernel runs: `git add` clears git's own "unmerged
// path" state for a file the moment it is staged, so a conflicted file whose markers were staged
// without being resolved is otherwise indistinguishable from an ordinary clean staged change — nothing
// downstream (the worktree snapshot, the kernel's preflight, the commit adapter) would ever notice,
// and the commit would silently bake the literal marker lines into history.
export function readStagedConflictMarkerFileCountFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  correlationId?: string,
): Promise<number> {
  if (seams.conflictMarkerReader !== undefined) return seams.conflictMarkerReader(workspace);
  return readStagedConflictMarkerFileCount({
    workspace,
    processEnv: process.env,
    now,
    onTerminated: gitDeliveryTerminationHandler(seams, correlationId),
  });
}

function adapterFor(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  correlationId?: string,
): GitLocalMutationAdapter {
  if (seams.adapterFactory !== undefined) return seams.adapterFactory(workspace);
  return createNodeGitMutationAdapter({
    beforeCommitRefUpdate: seams.beforeCommitRefUpdate,
    beforeIndexUpdate: seams.beforeIndexUpdate,
    signal: seams.signal,
    workspace,
    processEnv: seams.processEnv ?? process.env,
    now,
    // Deps-level evidence port (PR #3354 review 3887021650): a governed git mutation that times
    // out or is aborted must leave its Windows tree-kill disposition in the activity log, tagged
    // with the SAME correlationId as this mutation's other log lines when the caller has one.
    onTerminated: gitDeliveryTerminationHandler(seams, correlationId),
  });
}

export function defaultGitDeliveryActionId(command: unknown, nowMs: number): string {
  const fingerprintInput = `${JSON.stringify(command)}:${String(nowMs)}`;
  return `gde-action-${sha256Hex(fingerprintInput).slice(0, 24)}`;
}

// String-leaf redactor for the evidence ledger, reusing the deps payload redactor (deepRedactStrings
// applies the inner audit redactString to a top-level string leaf). No new regex.
function redactStringFor(deps: Pick<UiHandlerDeps, "redactor">): (input: string) => string {
  return (input: string): string => deps.redactor(input) as string;
}

export function persistGitDeliveryEvidence(
  deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor" | "diagnostics">,
  result: GitMutationLifecycleResult,
  snapshot: GitWorktreeSnapshot,
  repoId: string,
  now: () => number,
): void {
  const record = buildGitDeliveryEvidenceRecord(
    {
      result,
      snapshot: {
        headDetached: snapshot.headDetached,
        ...(snapshot.currentBranchName !== undefined
          ? { currentBranchName: snapshot.currentBranchName }
          : {}),
        stagedFileCount: snapshot.stagedFileCount,
        unstagedFileCount: snapshot.unstagedFileCount,
        untrackedFileCount: snapshot.untrackedFileCount,
      },
      workflowRunId: `local-git-delivery:${repoId}`,
      repoId,
    },
    { now },
  );
  recordGitDeliveryMutationEvidence(
    {
      evidenceStore: deps.evidenceStore,
      redactString: redactStringFor(deps),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
    },
    record,
  );
}

// The remote gateways need a synthetic adapter result when the last-moment Authority Envelope
// continuity guard refuses dispatch. That transport stand-in is `aborted`, but the durable audit fact
// is a governance block: the accepted run no longer admitted the operation and no process started.
// Project it onto the existing lifecycle/evidence schema instead of persisting the misleading
// retryable internal-error result or growing a second authority ledger.
export function authorityDeniedGitDeliveryLifecycle(
  result: GitMutationLifecycleResult,
): GitMutationLifecycleResult {
  return {
    ...result,
    envelope: {
      ...result.envelope,
      // The adapter result exists only to unwind the kernel without dispatching. Keeping it on the
      // durable envelope would falsely claim that an execution was attempted.
      executionResult: undefined,
    },
    outcome: {
      status: "blocked",
      category: "policy-block",
      blockReason: "authority-denied",
    },
    phaseReached: "execute",
  };
}

interface GitDeliveryLifecycleRecordInput {
  readonly deps: Pick<UiHandlerDeps, "evidenceStore" | "redactor">;
  readonly result: GitMutationLifecycleResult;
  readonly snapshot: GitWorktreeSnapshot;
  readonly repoId: string;
  readonly now: () => number;
  readonly activityLog: ServerLogSink;
  readonly correlationId: string | undefined;
  readonly authorityDenied: boolean;
  /** The provider adapter's closed failure words and counts (#3390), logged with the mutation. */
  readonly failureDetail?: GitDeliveryFailureDetail | undefined;
}

/** What an adapter may say about a failed provider call, body-free: closed words and counts. */
export type GitDeliveryFailureDetail = Readonly<Record<string, string | number | undefined>>;

// Returns the lifecycle it actually recorded so a caller that answers the client from the same
// fact (executeGovernedMutation) reports the governance block it persisted, rather than projecting
// the authority-denied result a second time or returning the adapter's synthetic abort.
export function recordGitDeliveryLifecycle(
  input: GitDeliveryLifecycleRecordInput,
): GitMutationLifecycleResult {
  const lifecycle = input.authorityDenied
    ? authorityDeniedGitDeliveryLifecycle(input.result)
    : input.result;
  persistGitDeliveryEvidence(input.deps, lifecycle, input.snapshot, input.repoId, input.now);
  logGitDeliveryMutation(input.activityLog, lifecycle, input.correlationId, input.failureDetail);
  return lifecycle;
}

interface GovernedMutationKernelInput {
  readonly command: GitMutationCommand;
  readonly approval: GitDeliveryApprovalRequirement;
  readonly adapter: GitLocalMutationAdapter;
  readonly snapshot: GitWorktreeSnapshot;
  readonly seams: GitDeliveryExecutionSeams;
  readonly now: () => number;
}

// The #472 kernel invocation with its trusted policy packs and action-id minting resolved from the
// caller's seams. Split out only to keep executeGovernedMutation within the function-size bar; the
// composition is unchanged.
function runGovernedMutationKernel(
  input: GovernedMutationKernelInput,
): Promise<GitMutationLifecycleResult> {
  const { command, seams, now } = input;
  const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK);
  const newActionId =
    seams.newActionId ?? ((): string => defaultGitDeliveryActionId(command, now()));
  return runGitMutation(
    { command, approval: input.approval },
    {
      adapter: input.adapter,
      snapshot: input.snapshot,
      ...(packs.orgPack !== undefined ? { orgPolicyPack: packs.orgPack } : {}),
      ...(packs.repoPack !== undefined ? { repoPolicyPack: packs.repoPack } : {}),
      now,
      newActionId,
    },
  );
}

// The live snapshot read, with its precondition failure classified before it propagates. Extracted
// so `executeGovernedMutation` stays inside the repo's per-function line budget (AGENTS.md §6); the
// behaviour is unchanged — the same `git.delivery.mutation.failed` line, then the same rethrow.
async function snapshotOrReportFailure(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
  activityLog: ServerLogSink,
  actionKind: GitDeliveryActionKind,
  correlationId: string | undefined,
): Promise<GitWorktreeSnapshot> {
  try {
    return await readWorktreeSnapshotFor(workspace, seams, now, correlationId);
  } catch (error) {
    logGitDeliveryPreconditionFailure(activityLog, actionKind, error, correlationId);
    throw error;
  }
}

/**
 * Runs ONE governed local mutation end-to-end: live snapshot → kernel (preflight + policy + approval +
 * execute) → evidence. Returns the kernel lifecycle result; the caller projects it into a content-free
 * HTTP body. Evidence is appended best-effort BEFORE the caller responds.
 *
 * The admitted managed-root authority is re-proved immediately before the snapshot read and again
 * immediately before every mutation command (#3347 owner P1): both are spawn boundaries, and the
 * awaits between them are exactly where an archive or identity replacement lands.
 */
export async function executeGovernedMutation(
  command: GitMutationCommand,
  approval: GitDeliveryApprovalRequirement,
  workspace: WorkspaceInfo,
  deps: GitDeliveryMutationDeps,
  seams: GitDeliveryExecutionSeams,
  correlationId: string | undefined,
): Promise<GitMutationLifecycleResult> {
  const now = seams.now ?? Date.now;
  const activityLog = seams.activityLog ?? processServerLogSink();
  const logging: WorkspaceRootAccessDenialLogging = { activityLog, correlationId };
  const stillAuthorized = managedRootStillAuthorized(deps, workspace, logging);
  const refusal = mutationDispatchRefusal(activityLog, command.kind, correlationId);
  if (!stillAuthorized()) {
    refusal.deny();
    throw new GitDeliveryRootAuthorityRevokedError();
  }
  const snapshot = await snapshotOrReportFailure(
    workspace,
    seams,
    now,
    activityLog,
    command.kind,
    correlationId,
  );
  const result = await runGovernedMutationKernel({
    command,
    approval,
    adapter: authorityGuardedMutationAdapter(
      adapterFor(workspace, seams, now, correlationId),
      stillAuthorized,
      refusal,
    ),
    snapshot,
    seams,
    now,
  });
  const lifecycle = recordGitDeliveryLifecycle({
    deps,
    result,
    snapshot,
    repoId: workspace.root,
    now,
    activityLog,
    correlationId,
    authorityDenied: refusal.denied(),
  });
  await restampManagedTaskWorkspaceHead(deps, workspace, command, lifecycle, seams, logging);
  return lifecycle;
}

/**
 * One body-free line per finished governed action. Exported because the REMOTE publish path
 * (`pushExecution.ts`) produces the same `GitMutationLifecycleResult` and must report it the same
 * way — `envelope.kind` already distinguishes a `push` from a local mutation, so a second op and a
 * second formatter would split one vocabulary in two for no gain (AGENTS.md §5).
 */
// A terminal status that did not do what the caller asked. `blocked`/`approval-required` are
// GOVERNANCE outcomes — the gate working as designed, not a fault — so they stay informational;
// `failed`/`recovery-required` are the ones an operator has to act on.
const UNSUCCESSFUL_MUTATION_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "recovery-required",
]);

/**
 * The closed, body-free failure words a provider adapter attaches to a failed execution result
 * (#3390): a rejection reason, a create failure class and the identity validation that failed.
 * Rehearsal run-15's pull request existed on GitHub while the log said only `internal-error`; with
 * these on the mutation line the failing step is reconstructable from the log alone. Anything that
 * is not a short closed word never reaches the log.
 */
export interface GitDeliveryFailureFields {
  readonly rejectionReason?: MutationFailureStringValue<"rejectionReason">;
  readonly failureClass?: MutationFailureStringValue<"failureClass">;
  readonly identityIssue?: MutationFailureStringValue<"identityIssue">;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly exitCode?: number;
}

type MutationFailureStringField = "rejectionReason" | "failureClass" | "identityIssue";
type MutationFailureStringValue<FieldName extends MutationFailureStringField> =
  (typeof MUTATION_COMPLETED_OPERATION.fields)[FieldName]["values"][number];

function admittedString<FieldName extends MutationFailureStringField>(
  fieldName: FieldName,
  value: unknown,
): MutationFailureStringValue<FieldName> | undefined {
  const values: readonly string[] = MUTATION_COMPLETED_OPERATION.fields[fieldName].values;
  return typeof value === "string" && values.includes(value)
    ? (value as MutationFailureStringValue<FieldName>)
    : undefined;
}

function admittedCount(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && closedFailureDetailValue(value)
    ? value
    : undefined;
}

function failureValue(result: unknown, detail: GitDeliveryFailureDetail, key: string): unknown {
  const resultValue: unknown =
    typeof result === "object" && result !== null
      ? (result as Readonly<Record<string, unknown>>)[key]
      : undefined;
  const explicitValue: string | number | undefined = detail[key];
  return closedFailureDetailValue(explicitValue) ? explicitValue : resultValue;
}

export function executionFailureDetail(
  outcome: GitMutationLifecycleResult["outcome"],
  detail: GitDeliveryFailureDetail = {},
): GitDeliveryFailureFields {
  if (outcome.status !== "failed" && outcome.status !== "recovery-required") return {};
  const result: unknown = outcome.executionResult;
  const rejectionReason = admittedString(
    "rejectionReason",
    failureValue(result, detail, "rejectionReason"),
  );
  const failureClass = admittedString("failureClass", failureValue(result, detail, "failureClass"));
  const identityIssue = admittedString(
    "identityIssue",
    failureValue(result, detail, "identityIssue"),
  );
  const stdoutBytes = admittedCount(failureValue(result, detail, "stdoutBytes"));
  const stderrBytes = admittedCount(failureValue(result, detail, "stderrBytes"));
  const exitCode = admittedCount(failureValue(result, detail, "exitCode"));
  return {
    ...(rejectionReason === undefined ? {} : { rejectionReason }),
    ...(failureClass === undefined ? {} : { failureClass }),
    ...(identityIssue === undefined ? {} : { identityIssue }),
    ...(stdoutBytes === undefined ? {} : { stdoutBytes }),
    ...(stderrBytes === undefined ? {} : { stderrBytes }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

/** A closed word or a safe integer: the only value shapes a failure detail may carry onto the log. */
function closedFailureDetailValue(value: unknown): value is string | number {
  return (
    (typeof value === "string" && /^[a-z][a-z-]{0,39}$/u.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function executionErrorCodeOf(
  outcome: GitMutationLifecycleResult["outcome"],
): GitDeliveryExecutionErrorCode | undefined {
  return outcome.status === "failed" || outcome.status === "recovery-required"
    ? (outcome.executionResult.errorCode ?? "internal-error")
    : undefined;
}

const EXECUTION_ACTIVITY_ERROR_KIND: Readonly<
  Record<GitDeliveryExecutionErrorCode, ActivityLogErrorKind>
> = {
  "provider-rejected": "unavailable",
  "network-failure": "unavailable",
  conflict: "conflict",
  "precondition-failed": "conflict",
  "signature-failed": "validation-failed",
  timeout: "timeout",
  "internal-error": "internal",
};

const ACTIVITY_ERROR_PATTERNS: readonly (readonly [RegExp, ActivityLogErrorKind])[] = [
  [/rate[-_ ]?limit/u, "rate-limited"],
  [/timeout/u, "timeout"],
  [/cancel|abort/u, "cancelled"],
  [/authority/u, "authority-denied"],
  [/permission|denied/u, "permission-denied"],
  [/conflict|lock/u, "conflict"],
  [/valid|signature/u, "validation-failed"],
  [/unavailable|unreachable|network/u, "unavailable"],
];

export function gitDeliveryActivityErrorKind(kind: string): ActivityLogErrorKind {
  const lower = kind.toLowerCase();
  const match = ACTIVITY_ERROR_PATTERNS.find(([pattern]) => pattern.test(lower));
  if (match !== undefined) return match[1];
  return kind === "unknown" ? "unknown" : "internal";
}

export function gitDeliveryActivityFailureKind(kind: string): string {
  return isErrorKind(kind) ? kind : gitDeliveryActivityErrorKind(kind);
}

export function gitDeliveryActivityCode(code: string | undefined): string | undefined {
  return isErrorKind(code) ? code : undefined;
}

function policyBlockReasonOf(
  outcome: GitMutationLifecycleResult["outcome"],
): GitDeliveryBlockReason | undefined {
  return outcome.status === "blocked" && outcome.category === "policy-block"
    ? outcome.blockReason
    : undefined;
}

export function logGitDeliveryMutation(
  log: ServerLogSink,
  result: GitMutationLifecycleResult,
  correlationId: string | undefined,
  failureDetail: GitDeliveryFailureDetail = {},
): void {
  const { outcome, envelope, phaseReached, preflight } = result;
  const unsuccessful = UNSUCCESSFUL_MUTATION_STATUSES.has(outcome.status);
  const executionErrorCode = executionErrorCodeOf(outcome);
  const blockReason = policyBlockReasonOf(outcome);
  log.write(
    activityLogEvent(
      MUTATION_COMPLETED_OPERATION,
      {
        // Without an explicit level this line defaulted to `info`, so a FAILED governed mutation or
        // push was filtered out entirely under `KEIKO_LOG_LEVEL=warn` — the threshold an operator
        // investigating a failed delivery would actually be running at (AGENTS.md §8 Rule 1).
        level: unsuccessful ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId),
        ...(executionErrorCode === undefined
          ? {}
          : { errorKind: EXECUTION_ACTIVITY_ERROR_KIND[executionErrorCode] }),
      },
      {
        actionId: envelope.actionId,
        actionKind: envelope.kind,
        status: outcome.status,
        phaseReached,
        policyOutcome: envelope.policyDecision.outcome,
        preflightFindingCount: preflight.findings.length,
        preflightBlockingCount: preflight.blocking.length,
        requiredApproverCount:
          outcome.status === "approval-required" ? outcome.requiredApprovers.length : 0,
        ...(blockReason === undefined ? {} : { blockReason }),
        ...(executionErrorCode === undefined ? {} : { executionErrorCode }),
        ...executionFailureDetail(outcome, failureDetail),
      },
    ),
  );
}

export function logGitDeliveryPreconditionFailure(
  log: ServerLogSink,
  actionKind: GitDeliveryActionKind,
  error: unknown,
  correlationId: string | undefined,
): void {
  writeGitDeliveryMutationFailure(log, actionKind, "snapshot", error, correlationId, false);
}

export function logGitDeliveryMutationFailure(
  log: ServerLogSink,
  actionKind: GitDeliveryActionKind,
  phaseReached: "snapshot" | "readiness" | "post-observation" | "dispatch",
  error: unknown,
  correlationId: string | undefined,
): void {
  writeGitDeliveryMutationFailure(log, actionKind, phaseReached, error, correlationId, true);
}

function writeGitDeliveryMutationFailure(
  log: ServerLogSink,
  actionKind: GitDeliveryActionKind,
  phaseReached: "snapshot" | "readiness" | "post-observation" | "dispatch",
  error: unknown,
  correlationId: string | undefined,
  includeErrorStructure: boolean,
): void {
  const failureKind = errorKindOf(error);
  const frames = keikoStackFrames(error);
  const chain = causeChain(error);
  log.write(
    activityLogEvent(
      MUTATION_FAILED_OPERATION,
      {
        level: "error",
        correlationId: correlationIdOrUnknown(correlationId),
        errorKind: gitDeliveryActivityErrorKind(failureKind),
      },
      {
        actionKind,
        phaseReached,
        failureKind,
        ...(includeErrorStructure && frames.length > 0 ? { frames } : {}),
        ...(includeErrorStructure && chain.length > 0 ? { causeChain: chain } : {}),
      },
    ),
  );
}

// ─── Content-free response projection ──────────────────────────────────────────────────────────

export interface GitDeliveryMutationResponseBody {
  readonly schemaVersion: "1";
  readonly status: GitMutationOutcome["status"];
  readonly actionKind: GitDeliveryActionKind;
  readonly phaseReached: GitMutationLifecycleResult["phaseReached"];
  readonly policyOutcome: GitMutationLifecycleResult["envelope"]["policyDecision"]["outcome"];
  readonly blockReason?: string;
  readonly preflightFindingCodes?: readonly string[];
  readonly requiredApprovers?: readonly string[];
  readonly executionErrorCode?: string;
}

export function gitDeliveryMutationResponse(
  result: GitMutationLifecycleResult,
): GitDeliveryMutationResponseBody {
  const { outcome, envelope, phaseReached, preflight } = result;
  const base = {
    schemaVersion: "1" as const,
    status: outcome.status,
    actionKind: envelope.kind,
    phaseReached,
    policyOutcome: envelope.policyDecision.outcome,
  };
  if (outcome.status === "blocked") {
    return outcome.category === "policy-block"
      ? { ...base, blockReason: outcome.blockReason }
      : { ...base, preflightFindingCodes: preflight.blocking.map((f) => f.code) };
  }
  if (outcome.status === "approval-required") {
    return { ...base, requiredApprovers: outcome.requiredApprovers };
  }
  if (outcome.status === "failed" || outcome.status === "recovery-required") {
    return { ...base, executionErrorCode: outcome.executionResult.errorCode ?? "internal-error" };
  }
  return base;
}
