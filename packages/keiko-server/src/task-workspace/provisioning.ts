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

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { isSafeGitRefName } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  validateTaskWorkspaceTransition,
  type TaskWorkspaceLifecycleState,
  type WorkspaceEventType,
  type WorkspaceInfo,
  type WorkspaceInstance,
  type WorkspaceLock,
} from "@oscharko-dev/keiko-contracts";
import { buildBinding } from "./binding.js";
import { lockIsLive, makeWorkspaceLock, resolveLockTtl } from "./locks.js";
import { provisionKey, workspaceKey } from "./mutex.js";
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
import { TaskWorkspaceError, type WorkspaceFailureOutcome } from "./errors.js";
import {
  appendWorkspaceLifecycleEvidence,
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
  type WorkspaceLifecycleOperation,
  type WorkspaceLifecycleOutcome,
} from "./evidence.js";
import type {
  WorkspaceActivateRequest,
  WorkspaceActivateResult,
  WorkspaceProvisioningService,
  WorkspaceProvisioningServiceDeps,
  WorkspaceProvisionRequest,
  WorkspaceProvisionResult,
} from "./types.js";

const MAX_FIELD_LENGTH = 512;
const RESUMABLE_STATES: readonly TaskWorkspaceLifecycleState[] = ["active", "paused"];
const COMPLETABLE_STATES: readonly TaskWorkspaceLifecycleState[] = [
  "provisioning",
  "failed",
  "recovery-required",
];

interface ProvisioningCtx {
  readonly deps: WorkspaceProvisioningServiceDeps;
  readonly lockTtlMs: number;
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
  readonly fromState?: TaskWorkspaceLifecycleState | undefined;
  readonly toState?: TaskWorkspaceLifecycleState | undefined;
  readonly lockId?: string | undefined;
}

// ─── pure helpers ────────────────────────────────────────────────────────────────────────────────

function isBoundedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function gitdirIdentity(worktreePath: string): string {
  let raw: string;
  try {
    const dotGit = join(worktreePath, ".git");
    if (statSync(dotGit).isDirectory()) {
      throw new Error("`.git` is a directory, not a linked-worktree pointer");
    }
    raw = readFileSync(dotGit, "utf8");
  } catch {
    throw new TaskWorkspaceError("POINTER_DRIFT", "managed worktree git pointer is missing");
  }
  const match = /^gitdir:\s*(.+)\s*$/mu.exec(raw);
  if (match?.[1] === undefined || match[1].length === 0) {
    throw new TaskWorkspaceError("POINTER_DRIFT", "managed worktree git pointer is malformed");
  }
  // Content-free, stable identity of the worktree's admin dir. The raw target stays in-process.
  return createHash("sha256").update(match[1].trim(), "utf8").digest("hex").slice(0, 32);
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
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    type: input.type,
    at: isoFrom(input.nowMs),
    correlationId: input.workspaceId,
    ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
    ...(input.toState !== undefined ? { toState: input.toState } : {}),
    ...(input.lockId !== undefined ? { lockId: input.lockId } : {}),
  });
  appendWorkspaceLifecycleEvidence(
    ctx.deps.evidenceStore,
    {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: input.nowMs,
      operation: input.operation,
      outcome: input.outcome,
      attempt: 1,
      durationMs: 0,
      worktreeCount: 0,
      event,
    },
    ctx.deps.redactString,
  );
}

function emitOutcomeForCode(
  ctx: ProvisioningCtx,
  operation: WorkspaceLifecycleOperation,
  outcome: WorkspaceFailureOutcome,
  workspaceId: string,
  taskId: string,
  nowMs: number,
): void {
  emit(ctx, { operation, outcome, type: "transition-rejected", workspaceId, taskId, nowMs });
}

// ─── repository resolution ─────────────────────────────────────────────────────────────────────

function validateProvisionRequest(request: WorkspaceProvisionRequest): void {
  const reasons: string[] = [];
  if (!isBoundedNonEmpty(request.repositoryRequestPath)) reasons.push("repository path required");
  if (!isBoundedNonEmpty(request.taskId)) reasons.push("taskId required");
  if (!isBoundedNonEmpty(request.requestedBy)) reasons.push("requestedBy required");
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
  const repositoryRoot = await ctx.deps.createAdapter(requestWorkspace).resolveRepositoryRoot();
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
    adapter: ctx.deps.createAdapter(repoWorkspace),
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
): Promise<boolean> {
  if (managedTargetExists(repo.worktreePath)) {
    return false; // our managed worktree already present — resume-complete without re-adding
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
  return true;
}

// Persists the partial-failure state visibly (SC4): the instance moves to `failed`/`recovery-required`
// with the lock released so a retry is unblocked, and a best-effort rollback removes the half-created
// worktree.
async function failProvisioning(
  repo: RepositoryContext,
  ctx: ProvisioningCtx,
  provisioning: WorkspaceInstance,
  error: TaskWorkspaceError,
  nowMs: number,
): Promise<never> {
  const target: TaskWorkspaceLifecycleState =
    error.outcome === "retry-required" ? "recovery-required" : "failed";
  try {
    await repo.adapter.removeWorktree({ worktreePath: repo.worktreePath, force: true });
    await repo.adapter.pruneWorktrees();
  } catch {
    // Rollback is best-effort; the visible state plus drift markers drive #447 repair.
  }
  ctx.deps.store.upsert({
    ...provisioning,
    lifecycleState: target,
    health: error.outcome === "retry-required" ? "drifted" : "degraded",
    lock: null,
    updatedAt: isoFrom(nowMs),
    driftMarkers: error.code === "POINTER_DRIFT" ? ["pointer-stale"] : [],
  });
  emit(ctx, {
    operation: "provision",
    outcome: error.outcome,
    type: error.code === "POINTER_DRIFT" ? "drift-detected" : "transition-rejected",
    workspaceId: provisioning.workspaceId,
    taskId: provisioning.taskId,
    nowMs,
    fromState: "provisioning",
    toState: target,
  });
  throw error;
}

// ─── resume / drift ──────────────────────────────────────────────────────────────────────────────

function resumeExisting(
  ctx: ProvisioningCtx,
  repo: RepositoryContext,
  existing: WorkspaceInstance,
  nowMs: number,
): WorkspaceProvisionResult {
  const identity = gitdirIdentity(repo.worktreePath);
  const refreshed = ctx.deps.store.upsert({
    ...existing,
    health: "healthy",
    gitdirIdentity: identity,
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
    toState: refreshed.lifecycleState,
  });
  return { instance: refreshed, binding: buildBinding(refreshed), created: false };
}

// An active/paused workspace whose managed worktree has vanished is drift, not a re-provision: the
// contract forbids re-entering `provisioning`, so it transitions to `recovery-required` (a legal move)
// and #447 owns the repair.
function flagResumableDrift(
  ctx: ProvisioningCtx,
  existing: WorkspaceInstance,
  nowMs: number,
): never {
  const drifted = ctx.deps.store.upsert({
    ...existing,
    lifecycleState: "recovery-required",
    health: "missing",
    lock: null,
    updatedAt: isoFrom(nowMs),
    driftMarkers: ["worktree-missing"],
  });
  emit(ctx, {
    operation: "provision",
    outcome: "retry-required",
    type: "drift-detected",
    workspaceId: drifted.workspaceId,
    taskId: drifted.taskId,
    nowMs,
    fromState: existing.lifecycleState,
    toState: "recovery-required",
  });
  throw new TaskWorkspaceError("POINTER_DRIFT", "managed worktree is missing");
}

function reuseExistingOrUndefined(
  ctx: ProvisioningCtx,
  repo: RepositoryContext,
  existing: WorkspaceInstance | undefined,
  nowMs: number,
): WorkspaceProvisionResult | undefined {
  if (existing === undefined) return undefined;
  if (RESUMABLE_STATES.includes(existing.lifecycleState)) {
    return managedTargetExists(repo.worktreePath)
      ? resumeExisting(ctx, repo, existing, nowMs)
      : flagResumableDrift(ctx, existing, nowMs);
  }
  if (!COMPLETABLE_STATES.includes(existing.lifecycleState)) {
    // Terminal state (archived/merged/abandoned/cleanup-pending): idempotent no-op, return as-is.
    return { instance: existing, binding: buildBinding(existing), created: false };
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
  let created: boolean;
  let identity: string;
  try {
    created = await materializeWorktree(repo, request);
    identity = gitdirIdentity(repo.worktreePath);
  } catch (error) {
    const failure =
      error instanceof TaskWorkspaceError
        ? error
        : new TaskWorkspaceError("PROVISIONING_FAILED", "unexpected provisioning failure");
    return failProvisioning(repo, ctx, provisioning, failure, ctx.deps.now());
  }
  const active = finalizeActive(ctx, provisioning, identity, ctx.deps.now());
  emit(ctx, {
    operation: "provision",
    outcome: "provisioned",
    type: "provisioned",
    workspaceId: active.workspaceId,
    taskId: active.taskId,
    nowMs: ctx.deps.now(),
    fromState: "provisioning",
    toState: "active",
  });
  return { instance: active, binding: buildBinding(active), created };
}

// The gated provisioning critical section. Runs under the `prov:<repositoryId>:<taskId>` mutex key
// (#449, ADR-0093 D1) so two concurrent provisions of the SAME (repo, task) serialize instead of both
// passing the check-then-write gates and racing `git worktree add`. The advisory cross-actor
// LOCK_CONTENTION check (assertProvisionable → assertNotLocked) stays INSIDE this section, preserving the
// across-actor rejection while the mutex only serializes same-process callers.
async function provisionLocked(
  ctx: ProvisioningCtx,
  request: WorkspaceProvisionRequest,
  repo: RepositoryContext,
): Promise<WorkspaceProvisionResult> {
  assertManagedRootOwned(ctx.deps.managedRoot);
  assertManagedTargetContained(ctx.deps.managedRoot, repo.worktreePath);

  const nowMs = ctx.deps.now();
  const existing = ctx.deps.store.findByRepositoryAndTask(repo.repositoryId, request.taskId);
  const reused = reuseExistingOrUndefined(ctx, repo, existing, nowMs);
  if (reused !== undefined) return reused;

  try {
    await assertProvisionable(ctx, repo, request, existing, nowMs);
  } catch (error) {
    if (error instanceof TaskWorkspaceError) {
      emitOutcomeForCode(ctx, "provision", error.outcome, repo.workspaceId, request.taskId, nowMs);
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
  return ctx.deps.mutex.runExclusive([provisionKey(repo.repositoryId, request.taskId)], () =>
    provisionLocked(ctx, request, repo),
  );
}

// ─── activate orchestration ──────────────────────────────────────────────────────────────────────

function activateActiveOrResume(instance: WorkspaceInstance): {
  readonly next: WorkspaceInstance;
  readonly type: WorkspaceEventType;
} {
  if (instance.lifecycleState === "active") {
    return { next: instance, type: "activated" };
  }
  const transition = validateTaskWorkspaceTransition({
    from: "paused",
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
      "ILLEGAL_TRANSITION",
      "cannot resume workspace",
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
  if (!RESUMABLE_STATES.includes(instance.lifecycleState)) {
    throw new TaskWorkspaceError(
      "ILLEGAL_TRANSITION",
      `cannot activate from ${instance.lifecycleState}`,
    );
  }
}

function flagActivateDrift(
  ctx: ProvisioningCtx,
  instance: WorkspaceInstance,
  nowMs: number,
): never {
  const drifted = ctx.deps.store.upsert({
    ...instance,
    lifecycleState: "recovery-required",
    health: "missing",
    lock: null,
    updatedAt: isoFrom(nowMs),
    driftMarkers: ["worktree-missing"],
  });
  emit(ctx, {
    operation: "activate",
    outcome: "retry-required",
    type: "drift-detected",
    workspaceId: drifted.workspaceId,
    taskId: drifted.taskId,
    nowMs,
    fromState: instance.lifecycleState,
    toState: "recovery-required",
  });
  throw new TaskWorkspaceError("POINTER_DRIFT", "managed worktree is missing");
}

// The gated activation critical section, run under the `ws:<workspaceId>` mutex key (#449, ADR-0093 D1)
// so a concurrent activate/pause/repair/cleanup of the same workspace serializes. The advisory
// cross-actor LOCK_CONTENTION check (assertActivatable) stays INSIDE.
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
  if (!managedTargetExists(instance.managedWorktreePath)) {
    flagActivateDrift(ctx, instance, nowMs);
  }
  const { next, type } = activateActiveOrResume(instance);
  const lock = request.acquireLock ? makeLock(ctx, request.requestedBy, "activation", nowMs) : null;
  const persisted = ctx.deps.store.upsert({
    ...next,
    health: "healthy",
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
    ...(type === "resumed" ? { fromState: instance.lifecycleState } : {}),
    toState: "active",
    ...(lock !== null ? { lockId: lock.lockId } : {}),
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
  return ctx.deps.mutex.runExclusive([workspaceKey(request.workspaceId)], () =>
    activateLocked(ctx, request),
  );
}

// ─── factory ─────────────────────────────────────────────────────────────────────────────────────

export function createWorkspaceProvisioningService(
  deps: WorkspaceProvisioningServiceDeps,
): WorkspaceProvisioningService {
  const ctx: ProvisioningCtx = { deps, lockTtlMs: resolveLockTtl(deps.lockTtlMs) };
  return {
    provision: (request: WorkspaceProvisionRequest): Promise<WorkspaceProvisionResult> =>
      provisionImpl(ctx, request),
    activate: (request: WorkspaceActivateRequest): Promise<WorkspaceActivateResult> =>
      activateImpl(ctx, request),
    getInstance: (workspaceId: string): WorkspaceInstance | undefined =>
      deps.store.getById(workspaceId),
  };
}
