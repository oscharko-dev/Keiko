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
  GitDeliveryExecutionResult,
  GitDeliveryRepoPolicyPack,
  GitSyncOperation,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
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
  readGitWorktreeSnapshot,
  readStagedConflictMarkerFileCount,
  readStagedPaths,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
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
import { errorKindOf, type ServerLogSink } from "../observability/server-log.js";
import { logCommandTermination, processServerLogSink } from "../process-log-sink.js";

const KEIKO_DEFAULT_PROTECTED_BRANCH_PATTERNS = [
  { matchKind: "exact", value: "dev" },
  { matchKind: "exact", value: "main" },
] as const;

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
  readonly adapterFactory?: ((workspace: WorkspaceInfo) => GitLocalMutationAdapter) | undefined;
  readonly snapshotReader?:
    ((workspace: WorkspaceInfo) => Promise<GitWorktreeSnapshot>) | undefined;
  readonly stagedPathsReader?:
    ((workspace: WorkspaceInfo) => Promise<readonly string[]>) | undefined;
  // Injectable seam for the staged-conflict-marker guard (see readStagedConflictMarkerFileCountFor).
  readonly conflictMarkerReader?: ((workspace: WorkspaceInfo) => Promise<number>) | undefined;
  readonly branchProtectionReader?: GitDeliveryBranchProtectionReader | undefined;
  readonly policyPacks?: GitDeliveryTrustedPolicyPacks | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly now?: (() => number) | undefined;
  readonly newActionId?: (() => string) | undefined;
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
 * Best-effort and awaited: the commit has already happened, so a failed restamp must not turn a
 * successful mutation into an error. It is never silent — the task-workspace layer logs every refusal
 * and failure on the existing `task-workspace.lifecycle` line under this correlation id.
 */
async function restampManagedTaskWorkspaceHead(
  deps: GitDeliveryMutationDeps,
  workspace: WorkspaceInfo,
  command: GitMutationCommand,
  lifecycle: GitMutationLifecycleResult,
  logging: WorkspaceRootAccessDenialLogging,
): Promise<void> {
  // `succeeded` is the whole gate: a dispatch the authority guard refused is recorded as
  // `blocked`/`authority-denied` by `authorityDeniedGitDeliveryLifecycle`, so it can never reach here.
  if (command.kind !== "commit" || lifecycle.outcome.status !== "succeeded") return;
  const managedWorktreePath = managedTaskWorktreeRoot(deps, workspace, logging);
  if (managedWorktreePath === undefined) return;
  await deps.workspaceProvisioning?.recordVerifiedHead?.({
    managedWorktreePath,
    ...(logging.correlationId === undefined ? {} : { correlationId: logging.correlationId }),
  });
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
    logCommandTermination(activityLog, correlationId ?? UNKNOWN_CORRELATION_ID, evidence);
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
  activityLog.write({
    category: "security",
    op: "git.delivery.dispatch.no-spawn",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    status: 403,
    extra: { operation },
  });
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
    workspace,
    processEnv: process.env,
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
}

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
  logGitDeliveryMutation(input.activityLog, lifecycle, input.correlationId);
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
  await restampManagedTaskWorkspaceHead(deps, workspace, command, lifecycle, logging);
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

export function logGitDeliveryMutation(
  log: ServerLogSink,
  result: GitMutationLifecycleResult,
  correlationId: string | undefined,
): void {
  const { outcome, envelope, phaseReached, preflight } = result;
  const unsuccessful = UNSUCCESSFUL_MUTATION_STATUSES.has(outcome.status);
  const executionErrorCode =
    outcome.status === "failed" || outcome.status === "recovery-required"
      ? (outcome.executionResult.errorCode ?? "internal-error")
      : undefined;
  const blockReason =
    outcome.status === "blocked" && outcome.category === "policy-block"
      ? outcome.blockReason
      : undefined;
  log.write({
    // Without an explicit level this line defaulted to `info`, so a FAILED governed mutation or
    // push was filtered out entirely under `KEIKO_LOG_LEVEL=warn` — the threshold an operator
    // investigating a failed delivery would actually be running at (AGENTS.md §8 Rule 1).
    level: unsuccessful ? "warn" : "info",
    category: "diagnostic",
    op: "git.delivery.mutation.completed",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    // Promoted out of `extra` onto the envelope: `errorKind` is the field an operator greps and
    // `keiko support analyze` clusters on, and it was previously reachable only by digging into
    // `extra.executionErrorCode`.
    ...(executionErrorCode === undefined ? {} : { errorKind: executionErrorCode }),
    extra: {
      actionId: envelope.actionId,
      actionKind: envelope.kind,
      status: outcome.status,
      phaseReached,
      policyOutcome: envelope.policyDecision.outcome,
      preflightFindingCount: preflight.findings.length,
      preflightBlockingCount: preflight.blocking.length,
      requiredApproverCount:
        outcome.status === "approval-required" ? outcome.requiredApprovers.length : 0,
      blockReason,
      executionErrorCode,
    },
  });
}

export function logGitDeliveryPreconditionFailure(
  log: ServerLogSink,
  actionKind: GitDeliveryActionKind,
  error: unknown,
  correlationId: string | undefined,
): void {
  log.write({
    level: "error",
    category: "diagnostic",
    op: "git.delivery.mutation.failed",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    errorKind: errorKindOf(error),
    extra: {
      actionKind,
      phaseReached: "snapshot",
    },
  });
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
