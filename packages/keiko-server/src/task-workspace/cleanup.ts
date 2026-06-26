// Governed cleanup for managed task workspaces (Issue #448, Epic #443).
//
// Cleanup is the destructive counterpart to health. It NEVER removes anything without (a) operator
// approval (the #444 request-cleanup / complete-cleanup operations both require it), (b) a LIVE
// re-verification of containment + ownership + cleanliness + lock liveness at the moment of removal —
// the persisted `managedWorktreePath` is NEVER trusted (SC2) — and (c) the pure cleanup-safety gate
// allowing it. A refusal is a FIRST-CLASS successful safety outcome, audited and returned, never thrown
// (SC4). Removal goes through the governed worktree adapter first, falling back only to a single
// ownership-and-realpath-gated `safelyRemoveManagedPath` choke point — the ONLY place a filesystem
// deletion happens, defended so it can never escape the Keiko-owned managed root (SC1).
//
// It REUSES the existing engines and adds none: containment + ownership are the #445 managed-root
// helpers, worktree removal is the narrow #445 adapter, fact gathering is the #447 reconciliation path,
// the lifecycle transition is the #444 contract gate, and every outcome writes the same content-free
// lifecycle evidence as provisioning/reconciliation/repair.

import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  evaluateWorkspaceCleanupSafety,
  isCleanupEligibleLifecycleState,
  validateTaskWorkspaceTransition,
  type TaskWorkspaceLifecycleState,
  type WorkspaceCleanupRefusalReason,
  type WorkspaceEventType,
  type WorkspaceInstance,
  type WorkspaceLock,
} from "@oscharko-dev/keiko-contracts";
import { deriveRepositoryId } from "./naming.js";
import {
  assertManagedTargetContained,
  isManagedRootOwned,
  isManagedTargetContained,
} from "./managed-root.js";
import { deriveOrphanId } from "./health.js";
import { gatherInstanceReconciliationFacts } from "./reconciliation.js";
import { TaskWorkspaceError } from "./errors.js";
import {
  appendWorkspaceLifecycleEvidence,
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
  type WorkspaceLifecycleOutcome,
} from "./evidence.js";
import type {
  WorkspaceCleanupRequest,
  WorkspaceCleanupResult,
  WorkspaceCleanupService,
  WorkspaceCleanupServiceDeps,
  WorkspaceOrphanCleanupRequest,
  WorkspaceOrphanCleanupResult,
  WorkspaceOrphanRefusal,
} from "./types.js";

const DEFAULT_LOCK_TTL_MS = 5 * 60_000;
const MAX_FIELD_LENGTH = 512;

interface CleanupCtx {
  readonly deps: WorkspaceCleanupServiceDeps;
  readonly lockTtlMs: number;
}

function isBoundedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function lockIsLive(lock: WorkspaceInstance["lock"], nowMs: number, ttlMs: number): boolean {
  if (lock === null) return false;
  if (lock.expiresAt !== undefined) {
    const expiry = Date.parse(lock.expiresAt);
    return Number.isFinite(expiry) ? nowMs < expiry : false;
  }
  const acquired = Date.parse(lock.acquiredAt);
  return Number.isFinite(acquired) ? nowMs - acquired < ttlMs : false;
}

// The SINGLE filesystem-deletion choke point (SC1). Before `rmSync` it proves: (1) Keiko owns the
// managed root (the marker file is present — never created here), (2) the target realpath-resolves
// inside the managed root (rejects symlink escape, parent traversal, out-of-root absolute targets),
// and (3) the target is a strict `<repositoryId>/<leaf>` descendant (never the managed root itself nor
// a bare repository-id directory). Any failure throws a content-free error and removes nothing.
// Exported so the security negative matrix exercises the guard directly.
export function safelyRemoveManagedPath(managedRoot: string, target: string): void {
  if (!isManagedRootOwned(managedRoot)) {
    throw new TaskWorkspaceError("UNSAFE_PATH", "managed root ownership could not be proven");
  }
  // Throws UNSAFE_PATH on any lexical/realpath containment failure (delegated to keiko-workspace).
  assertManagedTargetContained(managedRoot, target);
  const rootReal = realpathSync(managedRoot);
  const targetReal = realpathSync(target);
  const rel = relative(rootReal, targetReal);
  const segments = rel.split(/[\\/]/u).filter((segment) => segment.length > 0);
  if (rel.length === 0 || rel.startsWith("..") || segments.includes("..") || segments.length < 2) {
    throw new TaskWorkspaceError("UNSAFE_PATH", "refusing to remove a non-leaf managed path");
  }
  rmSync(targetReal, { recursive: true, force: false });
}

function emit(
  ctx: CleanupCtx,
  input: {
    readonly outcome: WorkspaceLifecycleOutcome;
    readonly type: WorkspaceEventType;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly correlationId: string;
    readonly fromState?: TaskWorkspaceLifecycleState | undefined;
    readonly toState?: TaskWorkspaceLifecycleState | undefined;
    readonly nowMs: number;
  },
): void {
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    type: input.type,
    at: isoFrom(input.nowMs),
    correlationId: input.correlationId,
    ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
    ...(input.toState !== undefined ? { toState: input.toState } : {}),
  });
  appendWorkspaceLifecycleEvidence(
    ctx.deps.evidenceStore,
    {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: input.nowMs,
      operation: "cleanup",
      outcome: input.outcome,
      attempt: 1,
      durationMs: 0,
      worktreeCount: 0,
      event,
    },
    ctx.deps.redactString,
  );
}

function loadInstance(ctx: CleanupCtx, workspaceId: string): WorkspaceInstance {
  if (!isBoundedNonEmpty(workspaceId)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "invalid workspaceId");
  }
  const instance = ctx.deps.store.getById(workspaceId);
  if (instance === undefined) {
    throw new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "workspace not found");
  }
  return instance;
}

// request-cleanup: a settled (cleanup-eligible) instance → cleanup-pending. Operator-approval gated by
// the #444 transition precondition table; no physical removal happens here.
// The *->cleanup-pending transition gate (operator-approval is the precondition the contract table
// carries for it). Extracted so requestCleanupImpl stays small.
function assertCleanupTransitionApproved(
  instance: WorkspaceInstance,
  operatorApproved: boolean,
): void {
  const transition = validateTaskWorkspaceTransition({
    from: instance.lifecycleState,
    to: "cleanup-pending",
    context: {
      lockHeldByActor: true,
      pathContained: false,
      worktreeClean: false,
      branchReady: false,
      providerReady: false,
      operatorApproved,
    },
  });
  if (!transition.ok) {
    throw new TaskWorkspaceError(
      "OPERATOR_APPROVAL_REQUIRED",
      "cleanup request requires operator approval",
      transition.reasons,
    );
  }
}

function requestCleanupImpl(
  ctx: CleanupCtx,
  request: WorkspaceCleanupRequest,
): WorkspaceCleanupResult {
  const instance = loadInstance(ctx, request.workspaceId);
  if (!isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "requestedBy is required");
  }
  if (!isCleanupEligibleLifecycleState(instance.lifecycleState)) {
    throw new TaskWorkspaceError(
      "CLEANUP_NOT_ELIGIBLE",
      `workspace in ${instance.lifecycleState} is not eligible for cleanup`,
    );
  }
  if (instance.lifecycleState === "cleanup-pending") {
    // Idempotent: already requested.
    return { outcome: "requested", workspaceId: instance.workspaceId, instance };
  }
  assertCleanupTransitionApproved(instance, request.operatorApproved);
  const nowMs = ctx.deps.now();
  const fromState = instance.lifecycleState;
  const persisted = ctx.deps.store.upsert({
    ...instance,
    lifecycleState: "cleanup-pending",
    updatedAt: isoFrom(nowMs),
  });
  emit(ctx, {
    outcome: "cleanup-requested",
    type: "cleanup-requested",
    workspaceId: persisted.workspaceId,
    taskId: persisted.taskId,
    correlationId: persisted.auditCorrelationId,
    fromState,
    toState: persisted.lifecycleState,
    nowMs,
  });
  return { outcome: "requested", workspaceId: persisted.workspaceId, instance: persisted };
}

// Re-gathers the LIVE facts for one instance (never trusting the persisted row) and runs the pure
// safety gate. Builds its own repo-root adapter for structural facts and a worktree-bound adapter for
// the dirty probe.
async function evaluateLiveCleanupSafety(
  ctx: CleanupCtx,
  instance: WorkspaceInstance,
): Promise<{ readonly allowed: boolean; readonly refusalReason?: WorkspaceCleanupRefusalReason }> {
  const adapter = ctx.deps.createAdapter(detectWorkspaceAt(instance.repositoryRoot));
  const worktrees = await adapter.listWorktrees();
  const { facts } = await gatherInstanceReconciliationFacts(
    ctx.deps,
    adapter,
    worktrees,
    instance,
    ctx.deps.now(),
  );
  const worktreeDirty =
    facts.worktreeDirExists && facts.pathContained
      ? (
          await ctx.deps
            .createAdapter(detectWorkspaceAt(instance.managedWorktreePath))
            .worktreeStatus()
        ).dirty
      : false;
  return evaluateWorkspaceCleanupSafety({
    lifecycleState: instance.lifecycleState,
    hasRecord: true,
    pathContained: facts.pathContained,
    ownershipProven: isManagedRootOwned(ctx.deps.managedRoot),
    worktreeDirty,
    lockLive: facts.lockLive,
  });
}

// Governed physical removal of a managed worktree: the narrow adapter `remove --force` first (the
// safety gate already proved the tree is clean, contained, and owned), then a `prune` to clear the
// admin entry; if the directory git no longer tracks survives, the gated `safelyRemoveManagedPath`
// fallback removes it. Throws CLEANUP_FAILED only on an unexpected IO error.
async function removeManagedWorktree(
  ctx: CleanupCtx,
  repositoryRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const adapter = ctx.deps.createAdapter(detectWorkspaceAt(repositoryRoot));
    await adapter.removeWorktree({ worktreePath, force: true });
    await adapter.pruneWorktrees();
    if (existsSync(worktreePath)) safelyRemoveManagedPath(ctx.deps.managedRoot, worktreePath);
  } catch (error) {
    if (error instanceof TaskWorkspaceError) throw error;
    throw new TaskWorkspaceError("CLEANUP_FAILED", "governed worktree removal failed");
  }
}

function cleanupLock(ctx: CleanupCtx, requestedBy: string, nowMs: number): WorkspaceLock {
  return {
    lockId: ctx.deps.newId(),
    owner: requestedBy,
    reason: "cleanup",
    acquiredAt: isoFrom(nowMs),
    expiresAt: isoFrom(nowMs + ctx.lockTtlMs),
  };
}

// Emits the content-free refusal event and returns the refused result (a successful safety outcome).
function refuseCleanup(
  ctx: CleanupCtx,
  instance: WorkspaceInstance,
  refusalReason: WorkspaceCleanupRefusalReason | undefined,
): WorkspaceCleanupResult {
  emit(ctx, {
    outcome: "cleanup-refused",
    type: "transition-rejected",
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    correlationId: instance.auditCorrelationId,
    fromState: instance.lifecycleState,
    nowMs: ctx.deps.now(),
  });
  return {
    outcome: "refused",
    workspaceId: instance.workspaceId,
    ...(refusalReason !== undefined ? { refusalReason } : {}),
  };
}

// Performs the approved removal: acquire the cleanup lock (the #444 complete-cleanup operation requires
// one) as a concurrency marker, remove the worktree through the governed path, clear the active pointer,
// delete the retired row, and audit. The content-free history survives in the evidence ledger.
async function finalizeCleanup(
  ctx: CleanupCtx,
  instance: WorkspaceInstance,
  requestedBy: string,
  nowMs: number,
): Promise<WorkspaceCleanupResult> {
  const locked = ctx.deps.store.upsert({
    ...instance,
    lock: cleanupLock(ctx, requestedBy, nowMs),
    updatedAt: isoFrom(nowMs),
  });
  await removeManagedWorktree(ctx, locked.repositoryRoot, locked.managedWorktreePath);
  if (ctx.deps.activePointerStore.get()?.workspaceId === locked.workspaceId) {
    ctx.deps.activePointerStore.clear();
  }
  ctx.deps.store.delete(locked.workspaceId);
  emit(ctx, {
    outcome: "cleanup-completed",
    type: "cleanup-completed",
    workspaceId: locked.workspaceId,
    taskId: locked.taskId,
    correlationId: locked.auditCorrelationId,
    fromState: "cleanup-pending",
    nowMs: ctx.deps.now(),
  });
  return { outcome: "completed", workspaceId: locked.workspaceId };
}

// The pre-removal guards: bounded actor, operator approval, no foreign live lock, and a cleanup-pending
// lifecycle. Throws on any violation (these are caller errors, not safety refusals).
function assertCompleteCleanupAllowed(
  ctx: CleanupCtx,
  request: WorkspaceCleanupRequest,
  instance: WorkspaceInstance,
  nowMs: number,
): void {
  if (!request.operatorApproved) {
    throw new TaskWorkspaceError(
      "OPERATOR_APPROVAL_REQUIRED",
      "cleanup requires operator approval",
    );
  }
  if (
    lockIsLive(instance.lock, nowMs, ctx.lockTtlMs) &&
    instance.lock?.owner !== request.requestedBy
  ) {
    throw new TaskWorkspaceError("LOCK_CONTENTION", "workspace is locked by another actor");
  }
  if (instance.lifecycleState !== "cleanup-pending") {
    throw new TaskWorkspaceError(
      "CLEANUP_NOT_ELIGIBLE",
      "complete-cleanup requires a cleanup-pending workspace (request cleanup first)",
    );
  }
}

// complete-cleanup: the live-verified governed removal of a cleanup-pending instance (lock + operator
// approval). Re-verifies safety LIVE; on refusal it audits and returns (never throws).
async function completeCleanupImpl(
  ctx: CleanupCtx,
  request: WorkspaceCleanupRequest,
): Promise<WorkspaceCleanupResult> {
  if (!isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "requestedBy is required");
  }
  const instance = loadInstance(ctx, request.workspaceId);
  const nowMs = ctx.deps.now();
  assertCompleteCleanupAllowed(ctx, request, instance, nowMs);
  const safety = await evaluateLiveCleanupSafety(ctx, instance);
  if (!safety.allowed) return refuseCleanup(ctx, instance, safety.refusalReason);
  return finalizeCleanup(ctx, instance, request.requestedBy, nowMs);
}

// Governed removal of orphaned managed worktrees: directories under the managed root with no persisted
// record. Each is realpath-contained, ownership-proven, and dirty-probed before the gated fs removal;
// an unsafe orphan is refused with its content-free reason, never removed.
async function cleanupOneOrphan(
  ctx: CleanupCtx,
  repositoryId: string,
  leaf: string,
  ownershipProven: boolean,
): Promise<WorkspaceOrphanRefusal | undefined> {
  const orphanId = deriveOrphanId(repositoryId, leaf);
  const candidate = join(ctx.deps.managedRoot, repositoryId, leaf);
  const pathContained = isManagedTargetContained(ctx.deps.managedRoot, candidate);
  const worktreeDirty = pathContained
    ? (await ctx.deps.createAdapter(detectWorkspaceAt(candidate)).worktreeStatus()).dirty
    : false;
  const decision = evaluateWorkspaceCleanupSafety({
    lifecycleState: "abandoned",
    hasRecord: false,
    pathContained,
    ownershipProven,
    worktreeDirty,
    lockLive: false,
  });
  if (!decision.allowed) {
    return { orphanId, refusalReason: decision.refusalReason ?? "path-escape" };
  }
  safelyRemoveManagedPath(ctx.deps.managedRoot, candidate);
  emit(ctx, {
    outcome: "cleanup-completed",
    type: "cleanup-completed",
    workspaceId: orphanId,
    taskId: orphanId,
    correlationId: orphanId,
    nowMs: ctx.deps.now(),
  });
  return undefined;
}

function orphanLeavesFor(
  ctx: CleanupCtx,
  repositoryId: string,
  knownPaths: ReadonlySet<string>,
): readonly string[] {
  const repoDir = join(ctx.deps.managedRoot, repositoryId);
  if (!existsSync(repoDir)) return [];
  try {
    return readdirSync(repoDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((leaf) => !knownPaths.has(join(repoDir, leaf)));
  } catch {
    return [];
  }
}

// The repository-id set to sweep: the requested repository only, or — for a global sweep — every
// repository with a persisted record plus every repository-id directory still on disk.
function resolveOrphanRepositoryIds(
  ctx: CleanupCtx,
  request: WorkspaceOrphanCleanupRequest,
): ReadonlySet<string> {
  if (request.repositoryRoot !== undefined && request.repositoryRoot.length > 0) {
    return new Set([deriveRepositoryId(request.repositoryRoot)]);
  }
  const ids = new Set(ctx.deps.store.listAll().map((instance) => instance.repositoryId));
  for (const onDisk of managedRepoDirs(ctx)) ids.add(onDisk);
  return ids;
}

// The managed worktree paths a persisted record claims, grouped by repository id, so the orphan sweep
// can exclude them.
function buildKnownPathsByRepo(ctx: CleanupCtx): ReadonlyMap<string, Set<string>> {
  const knownByRepo = new Map<string, Set<string>>();
  for (const instance of ctx.deps.store.listAll()) {
    const set = knownByRepo.get(instance.repositoryId) ?? new Set<string>();
    set.add(instance.managedWorktreePath);
    knownByRepo.set(instance.repositoryId, set);
  }
  return knownByRepo;
}

async function cleanupOrphansImpl(
  ctx: CleanupCtx,
  request: WorkspaceOrphanCleanupRequest,
): Promise<WorkspaceOrphanCleanupResult> {
  if (!isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "requestedBy is required");
  }
  if (!request.operatorApproved) {
    throw new TaskWorkspaceError(
      "OPERATOR_APPROVAL_REQUIRED",
      "cleanup requires operator approval",
    );
  }
  const ownershipProven = isManagedRootOwned(ctx.deps.managedRoot);
  const knownByRepo = buildKnownPathsByRepo(ctx);
  let removed = 0;
  const refused: WorkspaceOrphanRefusal[] = [];
  for (const repositoryId of resolveOrphanRepositoryIds(ctx, request)) {
    const known = knownByRepo.get(repositoryId) ?? new Set<string>();
    for (const leaf of orphanLeavesFor(ctx, repositoryId, known)) {
      const refusal = await cleanupOneOrphan(ctx, repositoryId, leaf, ownershipProven);
      if (refusal === undefined) removed += 1;
      else refused.push(refusal);
    }
  }
  return { removed, refused };
}

function managedRepoDirs(ctx: CleanupCtx): readonly string[] {
  if (!existsSync(ctx.deps.managedRoot)) return [];
  try {
    return readdirSync(ctx.deps.managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function createWorkspaceCleanupService(
  deps: WorkspaceCleanupServiceDeps,
): WorkspaceCleanupService {
  const ctx: CleanupCtx = { deps, lockTtlMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS };
  return {
    // `async` so a synchronous validation throw from requestCleanupImpl surfaces as a rejected promise
    // (a consistent async contract) rather than escaping the call synchronously.
    cleanup: async (request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult> =>
      request.mode === "request"
        ? requestCleanupImpl(ctx, request)
        : completeCleanupImpl(ctx, request),
    cleanupOrphans: (
      request: WorkspaceOrphanCleanupRequest,
    ): Promise<WorkspaceOrphanCleanupResult> => cleanupOrphansImpl(ctx, request),
  };
}
