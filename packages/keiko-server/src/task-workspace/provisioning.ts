// Managed task-workspace provisioning + activation service (Issue #445, Epic #443).
//
// This is the missing `git worktree` lifecycle AUTHORITY: it creates a dedicated task branch and a
// managed worktree from an approved base branch, walks the #444 lifecycle (provisioning → active),
// persists the durable WorkspaceInstance, and yields the WorkspaceBinding that Studio/editor/runtime/
// Git-Delivery surfaces bind to (#446 consumes it). It REUSES, never duplicates: Git mutation runs
// through the narrow keiko-tools worktree adapter (the single governed runCommand spawn boundary),
// path containment is delegated to @oscharko-dev/keiko-workspace, and branch/commit/publish/PR/merge
// stay owned by #470. No generic shell, no generic Git runner (SC1).
//
// Failure handling is deterministic and leaves a CLASSIFIED, visible state (SC4): pre-write rejections
// (invalid base, conflict, unsafe path, existing-unmanaged, lock contention) throw BEFORE any worktree
// or instance row is created; a failure DURING the worktree mutation transitions the persisted
// instance to `failed`/`recovery-required`, rolls the partial worktree back, and emits the matching
// content-free evidence.

import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { isSafeGitRefName } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  TaskWorkspaceDriftMarker,
  TaskWorkspaceHealth,
  TaskWorkspaceLifecycleState,
  WorkspaceEventType,
  WorkspaceInfo,
  WorkspaceInstance,
  WorkspaceLock,
} from "@oscharko-dev/keiko-contracts";
import {
  isTaskWorkspaceDriftMarker,
  planWorkspaceRecoveryHints,
  reconciliationHealth,
  reconciliationStatusFromInstance,
  TASK_WORKSPACE_SCHEMA_VERSION,
  validateTaskWorkspaceTransition,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { buildBinding } from "./binding.js";
import { assertSafeFieldValue, containsUnsafeFieldChars } from "./field-safety.js";
import { lockIsLive, makeWorkspaceLock, resolveLockTtl } from "./locks.js";
import { provisionKey, repositoryKey, workspaceKey } from "./mutex.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "./naming.js";
import {
  assertManagedRootOwned,
  assertManagedTargetContained,
  ensureManagedWorktreeParent,
  managedTargetExists,
} from "./managed-root.js";
import { TaskWorkspaceError } from "./errors.js";
import { safelyRemoveManagedPath } from "./cleanup.js";
import {
  inspectManagedGitdirIdentityOutcome,
  liveManagedIdentityDrift,
  managedIdentityDriftFor,
  managedIdentityDriftMarker,
  managedIdentityDriftMessage,
  UNSUPPORTED_IDENTITY_MESSAGE,
} from "./gitdir-identity.js";
import {
  logWorkspaceIdentityProbe,
  recordWorkspaceLifecycle,
  runWithWorkspaceLifecycleFailureLogging,
} from "./activity-log.js";
import {
  proveCreationTimeSupport,
  type ProvenCreationTimeSupport,
  type RepositoryCreationTimeSupport,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { correlationIdOrUnknown } from "../correlation.js";
import {
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
  type WorkspaceLifecycleOperation,
  type WorkspaceLifecycleOutcome,
} from "./evidence.js";
import { recordVerifiedManagedHead } from "./verified-head.js";
import type {
  RecordVerifiedHeadInput,
  WorkspaceActivateRequest,
  WorkspaceActivateResult,
  WorkspaceProvisioningService,
  WorkspaceProvisioningServiceDeps,
  WorkspaceProvisionRequest,
  WorkspaceProvisionResult,
} from "./types.js";

const MAX_FIELD_LENGTH = 512;
const RESUMABLE_STATES: ReadonlySet<TaskWorkspaceLifecycleState> = new Set([
  "active",
  "paused",
  "handoff-ready",
]);
// The states an explicit activation may start from: the resumable ones plus `recovery-required`,
// which the contract lists as activatable under `lock-held-by-actor` + `path-contained`
// (TASK_WORKSPACE_LEGAL_TRANSITIONS). Activation re-proves exactly those facts live — persisted
// path, worktree presence, managed identity — so a flag left behind by a drift that has since been
// resolved (the tree restored, the pointer reconciled) is cleared by the proof itself, while a row
// whose drift persists still refuses through the same proofs. Widening the set widens no trust
// boundary; refusing here while the contract permits it left the switcher offering an action the
// server answered with ILLEGAL_TRANSITION (2026-09-03 dev log).
const ACTIVATABLE_STATES: ReadonlySet<TaskWorkspaceLifecycleState> = new Set([
  ...RESUMABLE_STATES,
  "recovery-required",
]);
// The markers a successful activation or resume has re-proven false: the path is contained, the
// worktree is present and its identity is current. Any other marker — a moved HEAD, a deleted
// branch, uncommitted work — is not proven here and is carried forward for the next reconcile to
// confirm or clear; `lock-stale` is refuted only by the write that replaces the lock (activation),
// never by a resume, which leaves the lock field as it found it.
const MARKERS_REPROVEN_BY_LIVE_PROOF: ReadonlySet<TaskWorkspaceDriftMarker> = new Set([
  "worktree-missing",
  "pointer-stale",
  "gitdir-mismatch",
  "identity-schema-retired",
  "identity-unsupported",
  "path-escape",
]);
// One sentence for the migration refusal, shared by every path that refuses it, so an operator sees
// the same instruction whether the refusal came from the first attempt or a later retry.
const COMPLETABLE_STATES: ReadonlySet<TaskWorkspaceLifecycleState> = new Set([
  "provisioning",
  "failed",
  "recovery-required",
]);

interface ProvisioningCtx {
  readonly deps: WorkspaceProvisioningServiceDeps;
  readonly lockTtlMs: number;
  // The triggering operation's correlation id, so the worktree adapter's termination evidence joins
  // the same timeline as every other line of that operation (AGENTS.md §8). It lives on the CTX, not
  // in each helper's signature: the ctx is already threaded everywhere the adapter is built, so this
  // needed no new parameter on any private function (PR #3355 review, P2).
  readonly correlationId: string;
  // When this operation began, so every evidence line it emits carries a measured duration instead
  // of a placeholder zero (audit finding, 2026-09-03).
  readonly startedAtMs: number;
  // Operation-local: an emitted classified failure must not be followed by a duplicate generic
  // rejection line when the same TaskWorkspaceError crosses the public service boundary.
  failureOutcomeRecorded: boolean;
}

interface RepositoryContext {
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly taskBranch: string;
  readonly worktreePath: string;
  readonly adapter: GitWorktreeAdapter;
}

interface EmitInput {
  readonly operation: WorkspaceLifecycleOperation;
  readonly outcome: WorkspaceLifecycleOutcome;
  readonly type: WorkspaceEventType;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly nowMs: number;
  // The triggering request's own correlation id, threaded from WorkspaceProvisionRequest /
  // WorkspaceActivateRequest. Falls back to UNKNOWN_CORRELATION_ID (never the workspace's own
  // identity) when the caller genuinely has no request scope, so the evidence honestly reports
  // "no correlation id was known" instead of a value that only LOOKS like one (AGENTS.md §8).
  readonly correlationId?: string | undefined;
  readonly fromState?: TaskWorkspaceLifecycleState | undefined;
  readonly toState?: TaskWorkspaceLifecycleState | undefined;
  readonly lockId?: string | undefined;
  // A caught TaskWorkspaceError's own `.code`, when the caller has one in scope — carried into the
  // activity-log line's `errorKind` (see activity-log.ts's `WorkspaceLifecycleLogInput.errorCode`).
  // Ignored on a success outcome.
  readonly errorCode?: string | undefined;
  // The classified drift marker on a drift verdict, carried into the activity-log line's `extra`.
  readonly driftMarker?: TaskWorkspaceDriftMarker | undefined;
  // The managed worktrees this outcome handled: one for a materialised, resumed or activated
  // worktree, none for a pre-write rejection or a refusal.
  readonly worktreeCount?: number | undefined;
}

// ─── pure helpers ────────────────────────────────────────────────────────────────────────────────

function isBoundedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function unsupportedIdentityError(
  support: RepositoryCreationTimeSupport = "absent",
): TaskWorkspaceError {
  return new TaskWorkspaceError(
    "POINTER_DRIFT",
    support === "inconclusive" ? INCONCLUSIVE_IDENTITY_MESSAGE : UNSUPPORTED_IDENTITY_MESSAGE,
    ["identity-unsupported"],
  );
}

// Every volume the identity hashes must be proven: the managed root by probe, the repository
// read-only or shared with the managed root. The first verdict that is not durable names the reason.
function unprovenVolume(
  support: ProvenCreationTimeSupport,
): RepositoryCreationTimeSupport | undefined {
  if (support.managedRoot !== "durable") return support.managedRoot;
  if (support.repository !== "durable" && support.repository !== "same-volume") {
    return support.repository;
  }
  return undefined;
}

const INCONCLUSIVE_IDENTITY_MESSAGE =
  "managed worktree filesystem could not prove a durable creation time; retry once the workspace root is older than one timestamp granule, or relocate it";

// Every volume the identity hashes is proven before a mint. The repository is proven at the common
// git directory the identity actually hashed — the inspection resolves it through the gitfile or
// symlink a linked worktree or a separate-git-dir layout leaves at `<root>/.git`. A stat of that
// pointer would prove the pointer's volume, and a durable managed root would mint against an
// unproven — possibly aliasing — gitdir volume (#3376 review).
function proveIdentityVolumes(
  ctx: ProvisioningCtx,
  commonDirectory: string,
  correlationId: string | undefined,
): void {
  const prove = ctx.deps.proveCreationTimeSupport ?? proveCreationTimeSupport;
  let support: ProvenCreationTimeSupport;
  try {
    support = prove(ctx.deps.managedRoot, commonDirectory);
  } catch (cause) {
    // The probe reads and writes both volumes; an I/O failure there says nothing about the
    // identity and is the same retryable, non-destructive outcome every other proof path
    // classifies (#3376 review).
    throw new TaskWorkspaceError(
      "IDENTITY_PROOF_FAILED",
      "managed worktree creation-time proof failed",
      [],
      { cause },
    );
  }
  logWorkspaceIdentityProbe(ctx.deps, { correlationId, support });
  // Only PROVEN durable volumes mint: the managed root by probe, the repository read-only (its
  // metadata is a user's data; nothing is written there) or shared with the managed root. An
  // inconclusive verdict (everything created within one timestamp granule) fails closed too, with a
  // message that says retry, rather than minting an identity the invariant has no evidence for
  // (#3376 review).
  const unproven = unprovenVolume(support);
  if (unproven !== undefined) throw unsupportedIdentityError(unproven);
}

// Mints the identity of a freshly materialized worktree. Once the pointer is identified, the
// creation-time support of every volume it hashed is proven: a nonzero birthtime is not proof of a
// kept creation time (Node may report the ctime under that name), and an identity minted from a
// ctime would read as a replaced worktree after the first ordinary metadata write. Every refusal
// names its own reason — platform limitation, I/O failure, or an unprovable pointer — because they
// lead to three different operator actions.
function requiredGitdirIdentity(
  ctx: ProvisioningCtx,
  worktreePath: string,
  repositoryRoot: string,
  correlationId: string | undefined,
): string {
  const outcome = inspectManagedGitdirIdentityOutcome(worktreePath, repositoryRoot);
  switch (outcome.kind) {
    case "identified":
      proveIdentityVolumes(ctx, outcome.inspection.commonDirectory, correlationId);
      return outcome.inspection.identity;
    case "unsupported":
      throw unsupportedIdentityError();
    case "failed":
      // Retryable and non-destructive: the same proof-could-not-run outcome every other path
      // classifies as IDENTITY_PROOF_FAILED; failProvisioning rolls back only a worktree this call
      // created (#3376 review).
      throw new TaskWorkspaceError(
        "IDENTITY_PROOF_FAILED",
        "managed worktree identity proof failed",
        [],
        {
          cause: outcome.cause,
        },
      );
    case "unproven":
      throw new TaskWorkspaceError(
        "POINTER_DRIFT",
        "managed worktree git identity could not be proven",
      );
  }
}

// A POINTER_DRIFT raised at mint time carries its classified marker as a reason, so the failed row
// is persisted with the marker that names the cause instead of a generic stale pointer.
function driftMarkerFromError(error: TaskWorkspaceError): TaskWorkspaceDriftMarker {
  return error.reasons.find(isTaskWorkspaceDriftMarker) ?? "pointer-stale";
}

function assertPersistedManagedPath(ctx: ProvisioningCtx, instance: WorkspaceInstance): void {
  assertManagedTargetContained(ctx.deps.managedRoot, instance.managedWorktreePath);
  const expected = deriveManagedWorktreePath({
    managedRoot: ctx.deps.managedRoot,
    repositoryId: instance.repositoryId,
    workspaceId: instance.workspaceId,
  });
  if (instance.managedWorktreePath !== expected) {
    throw new TaskWorkspaceError(
      "POINTER_DRIFT",
      "persisted managed worktree path does not match its workspace identity",
    );
  }
}

function ensureManagedWorkspaceIdentity(ctx: ProvisioningCtx, instance: WorkspaceInstance): void {
  try {
    ctx.deps.ensureManagedWorkspaceIdentity?.(instance);
  } catch (error) {
    throw new TaskWorkspaceError(
      "PROVISIONING_FAILED",
      "managed workspace identity registration failed",
      [],
      { cause: error },
    );
  }
}

// ─── lock helpers ──────────────────────────────────────────────────────────────────────────────
// Lock liveness + the advisory-lock builder are the consolidated #449 helpers (locks.ts); this thin
// wrapper binds the provisioning ctx's TTL so the call sites stay terse.

function provisioningLockLive(
  ctx: ProvisioningCtx,
  lock: WorkspaceLock | null,
  nowMs: number,
): boolean {
  return lockIsLive(lock, nowMs, ctx.lockTtlMs);
}

function makeLock(
  ctx: ProvisioningCtx,
  owner: string,
  reason: WorkspaceLock["reason"],
  nowMs: number,
): WorkspaceLock {
  return makeWorkspaceLock({ newId: ctx.deps.newId, owner, reason, nowMs, ttlMs: ctx.lockTtlMs });
}

// ─── evidence ───────────────────────────────────────────────────────────────────────────────────

function emit(ctx: ProvisioningCtx, input: EmitInput): void {
  const correlationId = correlationIdOrUnknown(input.correlationId);
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    type: input.type,
    at: isoFrom(input.nowMs),
    correlationId,
    ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
    ...(input.toState !== undefined ? { toState: input.toState } : {}),
    ...(input.lockId !== undefined ? { lockId: input.lockId } : {}),
  });
  recordWorkspaceLifecycle(ctx.deps, {
    evidenceStore: ctx.deps.evidenceStore,
    record: {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: input.nowMs,
      operation: input.operation,
      outcome: input.outcome,
      attempt: 1,
      durationMs: Math.max(0, input.nowMs - ctx.startedAtMs),
      worktreeCount: input.worktreeCount ?? 0,
      event,
    },
    redactString: ctx.deps.redactString,
    errorCode: input.errorCode,
    driftMarker: input.driftMarker,
  });
  if (input.errorCode !== undefined) ctx.failureOutcomeRecorded = true;
}

// ─── repository resolution ─────────────────────────────────────────────────────────────────────

function validateProvisionRequest(request: WorkspaceProvisionRequest): void {
  const reasons: string[] = [];
  if (!isBoundedNonEmpty(request.repositoryRequestPath)) reasons.push("repository path required");
  if (!isBoundedNonEmpty(request.taskId)) reasons.push("taskId required");
  else if (containsUnsafeFieldChars(request.taskId))
    reasons.push("taskId contains forbidden characters");
  if (!isBoundedNonEmpty(request.requestedBy)) reasons.push("requestedBy required");
  else if (containsUnsafeFieldChars(request.requestedBy)) {
    reasons.push("requestedBy contains forbidden characters");
  }
  if (!isBoundedNonEmpty(request.baseBranch) || !isSafeGitRefName(request.baseBranch)) {
    reasons.push("baseBranch must be a safe git ref name");
  }
  if (reasons.length > 0) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "invalid provision request", reasons);
  }
}

async function resolveRepositoryContext(
  ctx: ProvisioningCtx,
  request: WorkspaceProvisionRequest,
): Promise<RepositoryContext> {
  const requestWorkspace = detectWorkspaceAt(request.repositoryRequestPath);
  const repositoryRoot = await ctx.deps
    .createAdapter(requestWorkspace, ctx.correlationId)
    .resolveRepositoryRoot();
  if (repositoryRoot === undefined) {
    throw new TaskWorkspaceError("MISSING_REPOSITORY", "path is not inside a git repository");
  }
  const repositoryId = deriveRepositoryId(repositoryRoot);
  const workspaceId = deriveWorkspaceId({ repositoryId, taskId: request.taskId });
  const repoWorkspace: WorkspaceInfo =
    repositoryRoot === requestWorkspace.root ? requestWorkspace : detectWorkspaceAt(repositoryRoot);
  return {
    repositoryRoot,
    repositoryId,
    workspaceId,
    taskBranch: deriveTaskBranchName({ taskId: request.taskId }),
    worktreePath: deriveManagedWorktreePath({
      managedRoot: ctx.deps.managedRoot,
      repositoryId,
      workspaceId,
    }),
    adapter: ctx.deps.createAdapter(repoWorkspace, ctx.correlationId),
  };
}

// ─── instance shaping ──────────────────────────────────────────────────────────────────────────

function freshInstance(
  ctx: RepositoryContext,
  request: WorkspaceProvisionRequest,
  existing: WorkspaceInstance | undefined,
  lock: WorkspaceLock,
  nowMs: number,
): WorkspaceInstance {
  const iso = isoFrom(nowMs);
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: ctx.workspaceId,
    taskId: request.taskId,
    repositoryId: ctx.repositoryId,
    repositoryRoot: ctx.repositoryRoot,
    baseBranch: request.baseBranch,
    taskBranch: ctx.taskBranch,
    managedWorktreePath: ctx.worktreePath,
    gitdirIdentity: existing?.gitdirIdentity ?? ctx.workspaceId,
    lifecycleState: "provisioning",
    health: "unknown",
    lock,
    createdAt: existing?.createdAt ?? iso,
    updatedAt: iso,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: existing?.auditCorrelationId ?? ctx.workspaceId,
  };
}

function finalizeActive(
  ctx: ProvisioningCtx,
  provisioning: WorkspaceInstance,
  identity: string,
  nowMs: number,
): WorkspaceInstance {
  const transition = validateTaskWorkspaceTransition({
    from: "provisioning",
    to: "active",
    context: {
      lockHeldByActor: true,
      pathContained: true,
      worktreeClean: true,
      branchReady: true,
      providerReady: true,
      operatorApproved: false,
    },
  });
  if (!transition.ok) {
    throw new TaskWorkspaceError(
      "PROVISIONING_FAILED",
      "provisioning to active transition rejected",
      transition.reasons,
    );
  }
  const iso = isoFrom(nowMs);
  return ctx.deps.store.upsert({
    ...provisioning,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    gitdirIdentity: identity,
    lastVerifiedAt: iso,
    updatedAt: iso,
    driftMarkers: [],
    recoveryHints: [],
  });
}

// ─── pre-write gates ────────────────────────────────────────────────────────────────────────────

function assertNotLocked(
  ctx: ProvisioningCtx,
  existing: WorkspaceInstance | undefined,
  request: WorkspaceProvisionRequest,
  nowMs: number,
): void {
  if (
    existing !== undefined &&
    provisioningLockLive(ctx, existing.lock, nowMs) &&
    existing.lock?.owner !== request.requestedBy
  ) {
    throw new TaskWorkspaceError("LOCK_CONTENTION", "workspace is locked by another actor");
  }
}

async function assertNoTargetOrBranchConflict(
  ctx: RepositoryContext,
  existing: WorkspaceInstance | undefined,
): Promise<void> {
  const ours = existing?.managedWorktreePath === ctx.worktreePath;
  if (managedTargetExists(ctx.worktreePath)) {
    if (!ours) {
      throw new TaskWorkspaceError(
        "EXISTING_UNMANAGED_PATH",
        "target worktree path exists and is not Keiko-managed",
      );
    }
    return;
  }
  if (!ours && (await ctx.adapter.localBranchExists(ctx.taskBranch))) {
    throw new TaskWorkspaceError("BRANCH_CONFLICT", "task branch already exists");
  }
}

// Detects the pre-write rejections. Throws WITHOUT persisting an instance — nothing was created, so
// there is no partial state to classify.
async function assertProvisionable(
  ctx: ProvisioningCtx,
  repo: RepositoryContext,
  request: WorkspaceProvisionRequest,
  existing: WorkspaceInstance | undefined,
  nowMs: number,
): Promise<void> {
  assertNotLocked(ctx, existing, request, nowMs);
  if (!(await repo.adapter.refResolves(request.baseBranch))) {
    throw new TaskWorkspaceError("INVALID_BASE_BRANCH", "base branch does not resolve");
  }
  await assertNoTargetOrBranchConflict(repo, existing);
}

// ─── worktree materialization ────────────────────────────────────────────────────────────────────

async function materializeWorktree(
  repo: RepositoryContext,
  request: WorkspaceProvisionRequest,
): Promise<void> {
  if (managedTargetExists(repo.worktreePath)) {
    return; // our managed worktree already present — resume-complete without re-adding
  }
  ensureManagedWorktreeParent(repo.worktreePath);
  const branchExists = await repo.adapter.localBranchExists(repo.taskBranch);
  const result = branchExists
    ? await repo.adapter.addWorktreeForExistingBranch({
        worktreePath: repo.worktreePath,
        branch: repo.taskBranch,
      })
    : await repo.adapter.addWorktree({
        worktreePath: repo.worktreePath,
        taskBranch: repo.taskBranch,
        baseRef: request.baseBranch,
      });
  if (!result.ok) {
    throw new TaskWorkspaceError("PROVISIONING_FAILED", "git worktree add failed");
  }
}

// Persists the partial-failure state visibly (SC4): the instance moves to `failed`/`recovery-required`
// with the lock released so a retry is unblocked, and a best-effort rollback removes the half-created
// worktree.
// A proof that could not run says nothing about the worktree: `unknown`, not `drifted`.
function failedProvisioningHealth(error: TaskWorkspaceError): TaskWorkspaceHealth {
  if (error.code === "IDENTITY_PROOF_FAILED") return "unknown";
  return error.outcome === "retry-required" ? "drifted" : "degraded";
}

async function failProvisioning(
  repo: RepositoryContext,
  ctx: ProvisioningCtx,
  provisioning: WorkspaceInstance,
  error: TaskWorkspaceError,
  nowMs: number,
  correlationId: string | undefined,
  // Only what THIS call set out to create is rolled back: a target that was absent before its add,
  // including the partial tree and stale registration a failed `git worktree add` leaves behind. A
  // completion or an operator-approved repair runs over an existing worktree, and a transient proof
  // failure there must never delete it (#3376 review).
  attemptedHere: boolean,
): Promise<never> {
  const target: TaskWorkspaceLifecycleState =
    error.outcome === "retry-required" ? "recovery-required" : "failed";
  if (attemptedHere) {
    try {
      await repo.adapter.removeWorktree({ worktreePath: repo.worktreePath, force: true });
      await repo.adapter.pruneWorktrees();
      // A partial tree git never registered, or could not remove, is still this call's: the target
      // did not exist before the add. The SC1 choke point keeps the removal inside the managed root,
      // and its refusal stays inside this best-effort block: the classified error below, the
      // persisted failed row, and the lock release must never be displaced by a rollback failure
      // (#3376 review).
      if (managedTargetExists(repo.worktreePath)) {
        safelyRemoveManagedPath(ctx.deps.managedRoot, repo.worktreePath);
      }
    } catch {
      // Rollback is best-effort; the visible state plus drift markers drive #447 repair.
    }
  }
  const driftMarker = error.code === "POINTER_DRIFT" ? driftMarkerFromError(error) : undefined;
  ctx.deps.store.upsert({
    ...provisioning,
    lifecycleState: target,
    health: failedProvisioningHealth(error),
    lock: null,
    updatedAt: isoFrom(nowMs),
    driftMarkers: driftMarker === undefined ? [] : [driftMarker],
    recoveryHints: driftMarker === undefined ? [] : planWorkspaceRecoveryHints([driftMarker]),
  });
  emit(ctx, {
    operation: "provision",
    outcome: error.outcome,
    type: error.code === "POINTER_DRIFT" ? "drift-detected" : "transition-rejected",
    workspaceId: provisioning.workspaceId,
    taskId: provisioning.taskId,
    nowMs,
    correlationId,
    fromState: "provisioning",
    toState: target,
    errorCode: error.code,
    driftMarker,
  });
  throw error;
}

// ─── resume / drift ──────────────────────────────────────────────────────────────────────────────

function resumeExisting(
  ctx: ProvisioningCtx,
  repo: RepositoryContext,
  existing: WorkspaceInstance,
  nowMs: number,
  correlationId: string | undefined,
): WorkspaceProvisionResult {
  assertPersistedManagedPath(ctx, existing);
  const drift = managedIdentityDriftFor(
    inspectManagedGitdirIdentityOutcome(repo.worktreePath, repo.repositoryRoot),
    existing.gitdirIdentity,
  );
  if (drift !== "matches") {
    // Both outcomes refuse and both need the same pointer reconciliation, but they are not the same
    // event and must not carry the same sentence: a workspace registered before the identity rule
    // bound the pointer stamps is UNPROVEN under a proof that cannot see a replacement — not proven
    // replaced — and telling an operator it changed sends them after an incident the evidence does
    // not show. (Nor is it proven intact: the retired proof cannot tell either way.)
    return flagDrift(
      ctx,
      "provision",
      existing,
      nowMs,
      correlationId,
      managedIdentityDriftMarker(drift),
      managedIdentityDriftMessage(drift),
    );
  }
  ensureManagedWorkspaceIdentity(ctx, existing);
  const refreshed = ctx.deps.store.upsert({
    ...existing,
    ...driftAfterLiveProof(existing, existing.lifecycleState, false),
    lastVerifiedAt: isoFrom(nowMs),
    updatedAt: isoFrom(nowMs),
  });
  emit(ctx, {
    operation: "provision",
    outcome: "resumed",
    type: "activated",
    workspaceId: refreshed.workspaceId,
    taskId: refreshed.taskId,
    nowMs,
    correlationId,
    toState: refreshed.lifecycleState,
    worktreeCount: 1,
  });
  return { instance: refreshed, binding: buildBinding(refreshed), created: false };
}

// A workspace whose managed worktree vanished, was replaced, predates the identity rule or sits on a
// volume without creation times is drift, not a re-provision: the contract forbids re-entering
// `provisioning`, so the row moves to `recovery-required` with the classified marker and its hint,
// the event carries the marker, and the request is refused. One helper for the provision and the
// activation paths — the two used to be near-identical copies (#3376 review).
function flagDrift(
  ctx: ProvisioningCtx,
  operation: WorkspaceLifecycleOperation,
  existing: WorkspaceInstance,
  nowMs: number,
  correlationId: string | undefined,
  marker: TaskWorkspaceDriftMarker = "worktree-missing",
  message = "managed worktree is missing",
): never {
  const drifted = ctx.deps.store.upsert({
    ...existing,
    lifecycleState: "recovery-required",
    health: marker === "worktree-missing" ? "missing" : "drifted",
    lock: null,
    updatedAt: isoFrom(nowMs),
    driftMarkers: [marker],
    recoveryHints: planWorkspaceRecoveryHints([marker]),
  });
  emit(ctx, {
    operation,
    outcome: "retry-required",
    type: "drift-detected",
    workspaceId: drifted.workspaceId,
    taskId: drifted.taskId,
    nowMs,
    correlationId,
    fromState: existing.lifecycleState,
    toState: "recovery-required",
    errorCode: "POINTER_DRIFT",
    driftMarker: marker,
  });
  throw new TaskWorkspaceError("POINTER_DRIFT", message);
}

function reuseExistingOrUndefined(
  ctx: ProvisioningCtx,
  repo: RepositoryContext,
  existing: WorkspaceInstance | undefined,
  nowMs: number,
  correlationId: string | undefined,
  operatorApprovedRepair: boolean,
): WorkspaceProvisionResult | undefined {
  if (existing === undefined) return undefined;
  if (RESUMABLE_STATES.has(existing.lifecycleState)) {
    return managedTargetExists(repo.worktreePath)
      ? resumeExisting(ctx, repo, existing, nowMs, correlationId)
      : flagDrift(ctx, "provision", existing, nowMs, correlationId);
  }
  if (!COMPLETABLE_STATES.has(existing.lifecycleState)) {
    // Terminal state (archived/merged/abandoned/cleanup-pending): idempotent no-op, return as-is.
    // A retired-schema marker is deliberately NOT consulted here — a terminal row still has to be
    // archivable and removable, and refusing it would strand it (#3372 review P2).
    assertPersistedManagedPath(ctx, existing);
    return { instance: existing, binding: buildBinding(existing), created: false };
  }
  // The completion path recomputes an identity and finalizes it. For a worktree that ALREADY EXISTS
  // on disk that is an identity reissue, and it must never happen without an operator-approved
  // repair: `recovery-required` is in COMPLETABLE_STATES, so a refused row would otherwise be
  // upgraded by the very next identical request. Reproduced in review.
  //
  // The check is on the live verdict, not on a persisted marker. A marker can be absent, stale, or
  // cleared by a repair that did not fix anything, and gating on it left the leak open for exactly
  // those rows — including a genuinely CHANGED v3 identity, which needs approval just as much as a
  // retired one. Only "matches" may proceed; a worktree that does not exist yet is a real
  // completion and falls through untouched.
  if (!operatorApprovedRepair && managedTargetExists(repo.worktreePath)) {
    const drift = managedIdentityDriftFor(
      inspectManagedGitdirIdentityOutcome(repo.worktreePath, repo.repositoryRoot),
      existing.gitdirIdentity,
    );
    if (drift !== "matches") {
      return flagDrift(
        ctx,
        "provision",
        existing,
        nowMs,
        correlationId,
        managedIdentityDriftMarker(drift),
        managedIdentityDriftMessage(drift),
      );
    }
  }
  return undefined; // COMPLETABLE: fall through to (re)provision/complete.
}

// ─── provision orchestration ─────────────────────────────────────────────────────────────────────

async function runWorktreeMutation(
  ctx: ProvisioningCtx,
  repo: RepositoryContext,
  request: WorkspaceProvisionRequest,
  provisioning: WorkspaceInstance,
): Promise<WorkspaceProvisionResult> {
  // Decided BEFORE the add: a target absent now is this call's to roll back, whether the add
  // succeeds, fails halfway, or the proof after it fails (#3376 review).
  const attemptedHere = !managedTargetExists(repo.worktreePath);
  let identity: string;
  try {
    await materializeWorktree(repo, request);
    identity = requiredGitdirIdentity(
      ctx,
      repo.worktreePath,
      repo.repositoryRoot,
      request.correlationId,
    );
    ensureManagedWorkspaceIdentity(ctx, provisioning);
  } catch (error) {
    const failure =
      error instanceof TaskWorkspaceError
        ? error
        : new TaskWorkspaceError("PROVISIONING_FAILED", "unexpected provisioning failure");
    return failProvisioning(
      repo,
      ctx,
      provisioning,
      failure,
      ctx.deps.now(),
      request.correlationId,
      attemptedHere,
    );
  }
  const active = finalizeActive(ctx, provisioning, identity, ctx.deps.now());
  emit(ctx, {
    operation: "provision",
    outcome: "provisioned",
    type: "provisioned",
    workspaceId: active.workspaceId,
    taskId: active.taskId,
    nowMs: ctx.deps.now(),
    correlationId: request.correlationId,
    fromState: "provisioning",
    toState: "active",
    worktreeCount: 1,
  });
  return { instance: active, binding: buildBinding(active), created: attemptedHere };
}

// The gated provisioning critical section. Runs under the `prov:<repositoryId>:<taskId>` mutex key
// (#449, ADR-0093 D1) so two concurrent provisions of the SAME (repo, task) serialize instead of both
// passing the check-then-write gates and racing `git worktree add`. It also runs under `repo:` because
// `git worktree add` mutates shared repository metadata even for distinct task branches. The advisory
// cross-actor LOCK_CONTENTION check (assertProvisionable → assertNotLocked) stays INSIDE this section,
// preserving the across-actor rejection while the mutex only serializes same-process callers.
async function provisionLocked(
  ctx: ProvisioningCtx,
  request: WorkspaceProvisionRequest,
  repo: RepositoryContext,
): Promise<WorkspaceProvisionResult> {
  assertManagedRootOwned(ctx.deps.managedRoot);
  assertManagedTargetContained(ctx.deps.managedRoot, repo.worktreePath);

  const nowMs = ctx.deps.now();
  const existing = ctx.deps.store.findByRepositoryAndTask(repo.repositoryId, request.taskId);
  const reused = reuseExistingOrUndefined(
    ctx,
    repo,
    existing,
    nowMs,
    request.correlationId,
    request.operatorApprovedRepair === true,
  );
  if (reused !== undefined) return reused;

  try {
    await assertProvisionable(ctx, repo, request, existing, nowMs);
  } catch (error) {
    if (error instanceof TaskWorkspaceError) {
      emit(ctx, {
        operation: "provision",
        outcome: error.outcome,
        type: "transition-rejected",
        workspaceId: repo.workspaceId,
        taskId: request.taskId,
        nowMs,
        correlationId: request.correlationId,
        errorCode: error.code,
      });
    }
    throw error;
  }

  const lock = makeLock(ctx, request.requestedBy, "provisioning", nowMs);
  const provisioning = ctx.deps.store.upsert(freshInstance(repo, request, existing, lock, nowMs));
  return runWorktreeMutation(ctx, repo, request, provisioning);
}

async function provisionImpl(
  ctx: ProvisioningCtx,
  request: WorkspaceProvisionRequest,
): Promise<WorkspaceProvisionResult> {
  validateProvisionRequest(request);
  // Resolve the repository identity (read-only git-root resolution) BEFORE acquiring the key — the key
  // is derived from (repositoryId, taskId) and serialization must cover only the mutating gated section.
  const repo = await resolveRepositoryContext(ctx, request);
  return ctx.deps.mutex.runExclusive(
    [repositoryKey(repo.repositoryId), provisionKey(repo.repositoryId, request.taskId)],
    () => provisionLocked(ctx, request, repo),
  );
}

// ─── activate orchestration ──────────────────────────────────────────────────────────────────────

function activateActiveOrResume(
  instance: WorkspaceInstance,
  lockHeldByActor: boolean,
): {
  readonly next: WorkspaceInstance;
  readonly type: WorkspaceEventType;
} {
  if (instance.lifecycleState === "active") {
    return { next: instance, type: "activated" };
  }
  const transition = validateTaskWorkspaceTransition({
    from: instance.lifecycleState,
    to: "active",
    context: {
      lockHeldByActor,
      pathContained: true,
      worktreeClean: true,
      branchReady: true,
      providerReady: true,
      operatorApproved: false,
    },
  });
  if (!transition.ok) {
    // The state pair itself is legal for every ACTIVATABLE_STATES member, so the only precondition
    // that can fail here is ownership — and that is contention (retryable once the actor owns the
    // workspace), not an illegal transition (a permanent verdict about the state pair).
    throw lockHeldByActor
      ? new TaskWorkspaceError("ILLEGAL_TRANSITION", "cannot resume workspace", transition.reasons)
      : new TaskWorkspaceError(
          "LOCK_CONTENTION",
          "activation does not hold the workspace lock",
          transition.reasons,
        );
  }
  return { next: { ...instance, lifecycleState: "active" }, type: "resumed" };
}

function assertActivatable(
  ctx: ProvisioningCtx,
  instance: WorkspaceInstance,
  request: WorkspaceActivateRequest,
  nowMs: number,
): void {
  if (isBoundedNonEmpty(request.taskId) && instance.taskId !== request.taskId) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "taskId does not match workspace");
  }
  if (
    request.expectedLifecycleState !== undefined &&
    request.expectedLifecycleState !== instance.lifecycleState
  ) {
    throw new TaskWorkspaceError("LOCK_CONTENTION", "workspace state changed; retry");
  }
  if (
    provisioningLockLive(ctx, instance.lock, nowMs) &&
    instance.lock?.owner !== request.requestedBy
  ) {
    throw new TaskWorkspaceError("LOCK_CONTENTION", "workspace is locked by another actor");
  }
  if (!ACTIVATABLE_STATES.has(instance.lifecycleState)) {
    throw new TaskWorkspaceError(
      "ILLEGAL_TRANSITION",
      `cannot activate from ${instance.lifecycleState}`,
    );
  }
}

// The drift bookkeeping a passed live proof persists: every marker the proofs have just refuted is
// dropped, the hints are re-planned from what remains, and `health` is DERIVED from what remains, so
// a healthy row never advertises an identity or path finding its own proof disproved (and the
// read-only report, which derives its status from the persisted markers, cannot report a healthy
// active row as stale). Shared by the activation and the idempotent-resume path: the two perform the
// same proof and the same write, and fixing one without the other left the resume path persisting a
// stale `gitdir-mismatch` next to `health: "healthy"` (audit finding, 2026-09-03). Only the caller
// that rewrites the lock field may also drop `lock-stale`: a marker is dropped by the write that
// refutes it, never by one that leaves the lock as it found it.
//
// The proof refutes the identity and path findings, not the operational ones — a moved HEAD, a
// deleted branch, a dirty tree survive it — so a flat `health: "healthy"` stated the opposite of the
// markers it was written next to. The health report copies the persisted value onto its live
// classification and the workbench renders both, so an active workspace read as healthy WHILE
// showing drift, and the UI's own "a drifted worktree stays visible" branch (which keys on the
// persisted health telling the truth) instead threw a restore-verification error (PR #3381 review).
// The mapping is the contract's, not a second one: the same status the read-only report will
// reconstruct from these markers, through the same `reconciliationHealth` reconciliation persists.
function driftAfterLiveProof(
  instance: WorkspaceInstance,
  lifecycleState: TaskWorkspaceLifecycleState,
  lockRewritten: boolean,
): Pick<WorkspaceInstance, "driftMarkers" | "recoveryHints" | "health"> {
  return workspaceDriftBookkeeping(
    instance.driftMarkers.filter(
      (marker) =>
        !MARKERS_REPROVEN_BY_LIVE_PROOF.has(marker) && !(lockRewritten && marker === "lock-stale"),
    ),
    lifecycleState,
  );
}

/**
 * The drift bookkeeping for a caller that has just REFUTED one or more markers: re-plan the hints
 * from what remains and DERIVE health from what remains, through the contract's own mapping.
 *
 * Extracted from `driftAfterLiveProof` so the #3382 `accept-moved-head` repair (repair.ts) drops its
 * one marker through the identical derivation instead of restating it. A second copy of this three
 * line rule is exactly how the resume path once persisted `health: "healthy"` next to a stale
 * `gitdir-mismatch` (audit finding, 2026-09-03): the two callers must move together.
 */
export function workspaceDriftBookkeeping(
  driftMarkers: readonly TaskWorkspaceDriftMarker[],
  lifecycleState: TaskWorkspaceLifecycleState,
): Pick<WorkspaceInstance, "driftMarkers" | "recoveryHints" | "health"> {
  return {
    driftMarkers,
    recoveryHints: planWorkspaceRecoveryHints(driftMarkers),
    // `health: "healthy"` as the input keeps the `locked-out` short-circuit out of this derivation:
    // the live proof has just passed and the lock is the caller's business, not a drift fact.
    health: reconciliationHealth(
      reconciliationStatusFromInstance({ lifecycleState, health: "healthy", driftMarkers }),
    ),
  };
}

// The gated activation critical section, run under the `ws:<workspaceId>` mutex key (#449, ADR-0093 D1)
// so a concurrent activate/pause/repair/cleanup of the same workspace serializes. The advisory
// cross-actor LOCK_CONTENTION check (assertActivatable) stays INSIDE.
// Activation exposes an operational binding, so it runs the same live four-way proof as resume: a
// retired-schema, unsupported or changed identity is flagged and refused here, never marked healthy
// on path existence alone (#3376 review P1).
function assertActivationIdentityCurrent(
  ctx: ProvisioningCtx,
  instance: WorkspaceInstance,
  nowMs: number,
  correlationId: string | undefined,
): void {
  const drift = liveManagedIdentityDrift(
    instance.managedWorktreePath,
    instance.repositoryRoot,
    instance.gitdirIdentity,
  );
  if (drift === "matches") return;
  flagDrift(
    ctx,
    "activate",
    instance,
    nowMs,
    correlationId,
    managedIdentityDriftMarker(drift),
    managedIdentityDriftMessage(drift),
  );
}

// What the activation actually owns, and the fact ADR-0088's `lock-held-by-actor` precondition is
// answered with.
interface ActivationOwnership {
  // The row as the store persisted it with the actor's lock on it — the transition is validated
  // against THIS record, never against the pre-acquisition one. For an already-active row, which
  // makes no transition, it is the row as it was read.
  readonly instance: WorkspaceInstance;
  // The lock this activation may RETAIN when `acquireLock` asked for it. `null` only where no
  // transition needed one and no retention was requested.
  readonly lock: WorkspaceLock | null;
  // Whether the DURABLE row proves the actor owns the workspace. Read back from what the store
  // returned rather than from the object handed to it: an ownership that could not be recorded is
  // not ownership, and this activation must refuse rather than assert a precondition nothing
  // supports.
  readonly lockHeldByActor: boolean;
}

// ADR-0088 gates every activation transition — `paused`/`handoff-ready`/`recovery-required` →
// `active` — on `lock-held-by-actor`. That fact used to be hard-coded `true`, which the mutex cannot
// stand in for: mutex.ts states the `ws:` key grants TURN ORDER (same-process serialization) while
// the persisted advisory `WorkspaceLock` grants OWNERSHIP (across-restart / across-actor). With
// `recovery-required` now activatable, the hard-coded fact let ANY actor promote a drifted, unowned
// row while the settled write persisted `lock: null` — the precondition was fabricated, not met
// (PR #3381 review P1).
//
// So the lock is ACQUIRED here: the actor's `activation` lock is written to the durable row before
// the transition is validated, and a live lock this same actor already holds is reused rather than
// replaced. `acquireLock` keeps exactly the meaning it always had — RETENTION beyond this call for
// cross-actor exclusivity — and the settled write in `activateLocked` releases the lock again when
// it was not requested, so the persisted outcome of an ordinary switch is unchanged.
// `assertActivatable` has already refused a live lock owned by anyone else, so an acquisition can
// only take a row this actor is entitled to.
function ownActivation(
  ctx: ProvisioningCtx,
  instance: WorkspaceInstance,
  request: WorkspaceActivateRequest,
  nowMs: number,
): ActivationOwnership {
  // An already-active row makes NO transition, so the contract's precondition table asks nothing of
  // the lock and this stays the single-write idempotent activation ADR-0093 D4's constant-per-switch
  // bound (pinned in scale.test.ts) describes. `lockHeldByActor` is reported as what it is — nothing
  // was acquired — so a future caller that DID need a transition here would fail closed.
  if (instance.lifecycleState === "active") {
    return {
      instance,
      lock: request.acquireLock ? makeLock(ctx, request.requestedBy, "activation", nowMs) : null,
      lockHeldByActor: false,
    };
  }
  const existing = instance.lock;
  const lock =
    existing !== null &&
    existing.owner === request.requestedBy &&
    provisioningLockLive(ctx, existing, nowMs)
      ? existing
      : makeLock(ctx, request.requestedBy, "activation", nowMs);
  const persisted = ctx.deps.store.upsert({ ...instance, lock, updatedAt: isoFrom(nowMs) });
  const durable = persisted.lock;
  return {
    instance: persisted,
    lock,
    lockHeldByActor:
      durable !== null &&
      durable.lockId === lock.lockId &&
      durable.owner === request.requestedBy &&
      provisioningLockLive(ctx, durable, nowMs),
  };
}

// The transition, with its refusal left CLASSIFIED and VISIBLE rather than only thrown: a rejected
// activation records the same `transition-rejected` evidence + `task-workspace.lifecycle` line the
// provision gate records, carrying the error code, so an operator reading `server.log` alone sees
// which precondition refused the switch (AGENTS.md §8, SC4).
function activateOrRefuse(
  ctx: ProvisioningCtx,
  owned: ActivationOwnership,
  request: WorkspaceActivateRequest,
  nowMs: number,
): { readonly next: WorkspaceInstance; readonly type: WorkspaceEventType } {
  try {
    return activateActiveOrResume(owned.instance, owned.lockHeldByActor);
  } catch (error) {
    if (error instanceof TaskWorkspaceError) {
      emit(ctx, {
        operation: "activate",
        outcome: error.outcome,
        type: "transition-rejected",
        workspaceId: owned.instance.workspaceId,
        taskId: owned.instance.taskId,
        nowMs,
        correlationId: request.correlationId,
        fromState: owned.instance.lifecycleState,
        errorCode: error.code,
      });
    }
    throw error;
  }
}

function activateLocked(
  ctx: ProvisioningCtx,
  request: WorkspaceActivateRequest,
): WorkspaceActivateResult {
  const instance = ctx.deps.store.getById(request.workspaceId);
  if (instance === undefined) {
    throw new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "workspace not found");
  }
  const nowMs = ctx.deps.now();
  assertActivatable(ctx, instance, request, nowMs);
  assertPersistedManagedPath(ctx, instance);
  if (!managedTargetExists(instance.managedWorktreePath)) {
    flagDrift(ctx, "activate", instance, nowMs, request.correlationId);
  }
  assertActivationIdentityCurrent(ctx, instance, nowMs, request.correlationId);
  ensureManagedWorkspaceIdentity(ctx, instance);
  const owned = ownActivation(ctx, instance, request, nowMs);
  const { next, type } = activateOrRefuse(ctx, owned, request, nowMs);
  const lock = request.acquireLock ? owned.lock : null;
  const persisted = ctx.deps.store.upsert({
    ...next,
    ...driftAfterLiveProof(next, next.lifecycleState, true),
    lock,
    lastVerifiedAt: isoFrom(nowMs),
    updatedAt: isoFrom(nowMs),
  });
  emit(ctx, {
    operation: "activate",
    outcome: type === "resumed" ? "resumed" : "activated",
    type,
    workspaceId: persisted.workspaceId,
    taskId: persisted.taskId,
    nowMs,
    correlationId: request.correlationId,
    ...(type === "resumed" ? { fromState: instance.lifecycleState } : {}),
    toState: "active",
    ...(lock !== null ? { lockId: lock.lockId } : {}),
    worktreeCount: 1,
  });
  return { instance: persisted, binding: buildBinding(persisted) };
}

function activateImpl(
  ctx: ProvisioningCtx,
  request: WorkspaceActivateRequest,
): Promise<WorkspaceActivateResult> {
  if (!isBoundedNonEmpty(request.workspaceId) || !isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "invalid activation request");
  }
  // requestedBy becomes the activation advisory-lock owner; a provided taskId is the cross-check key.
  // Both flow into operator-visible state, so reject control/zero-width/bidi code points here too.
  assertSafeFieldValue(request.requestedBy, "requestedBy");
  if (isBoundedNonEmpty(request.taskId)) assertSafeFieldValue(request.taskId, "taskId");
  return ctx.deps.mutex.runExclusive([workspaceKey(request.workspaceId)], () =>
    activateLocked(ctx, request),
  );
}

// ─── factory ─────────────────────────────────────────────────────────────────────────────────────

function runLoggedProvision(
  ctx: ProvisioningCtx,
  request: WorkspaceProvisionRequest,
): Promise<WorkspaceProvisionResult> {
  return runWithWorkspaceLifecycleFailureLogging(
    ctx.deps,
    {
      operation: "provision",
      // The seed is hashed before logging. Prefer the task identity when present; an invalid
      // request with no task still gets a stable, body-free identity from its request path.
      workspaceIdentitySeed: request.taskId || request.repositoryRequestPath,
      correlationId: request.correlationId,
      failureOutcomeAlreadyRecorded: () => ctx.failureOutcomeRecorded,
    },
    () => provisionImpl(ctx, request),
  );
}

function runLoggedActivation(
  ctx: ProvisioningCtx,
  request: WorkspaceActivateRequest,
): Promise<WorkspaceActivateResult> {
  return runWithWorkspaceLifecycleFailureLogging(
    ctx.deps,
    {
      operation: "activate",
      workspaceIdentitySeed: request.workspaceId || request.taskId || "invalid-activation",
      correlationId: request.correlationId,
      failureOutcomeAlreadyRecorded: () => ctx.failureOutcomeRecorded,
    },
    () => activateImpl(ctx, request),
  );
}

export function createWorkspaceProvisioningService(
  deps: WorkspaceProvisioningServiceDeps,
): WorkspaceProvisioningService {
  const lockTtlMs = resolveLockTtl(deps.lockTtlMs);
  // Built PER OPERATION, not once per service: the correlation id belongs to the request, and a
  // service-lifetime ctx is exactly what forced the previous UNKNOWN_CORRELATION_ID here.
  const ctxFor = (correlationId: string | undefined): ProvisioningCtx => ({
    deps,
    lockTtlMs,
    correlationId: correlationIdOrUnknown(correlationId),
    startedAtMs: deps.now(),
    failureOutcomeRecorded: false,
  });
  return {
    provision: (request: WorkspaceProvisionRequest): Promise<WorkspaceProvisionResult> =>
      runLoggedProvision(ctxFor(request.correlationId), request),
    activate: (request: WorkspaceActivateRequest): Promise<WorkspaceActivateResult> =>
      runLoggedActivation(ctxFor(request.correlationId), request),
    getInstance: (workspaceId: string): WorkspaceInstance | undefined =>
      deps.store.getById(workspaceId),
    // No request, so no operation id to join to: `ensureIdentity` is a synchronous store write with
    // no child process and therefore emits no termination evidence. UNKNOWN is honest here, and it
    // is the sanctioned fallback rather than an ad-hoc string.
    ensureIdentity: (instance: WorkspaceInstance): void => {
      ensureManagedWorkspaceIdentity(ctxFor(undefined), instance);
    },
    // The #3382 restamp seam. It shares this service's deps bundle (store, managed root, adapter
    // factory, evidence, clock, id) rather than composing a second one, so a caller cannot reach a
    // different store or a different managed root than provisioning itself writes through.
    recordVerifiedHead: (input: RecordVerifiedHeadInput): Promise<boolean> =>
      recordVerifiedManagedHead(deps, input),
  };
}
