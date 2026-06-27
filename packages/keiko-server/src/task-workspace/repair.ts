// Controlled repair for managed task workspaces (Issue #447, Epic #443).
//
// Repair is the mutating counterpart to reconciliation. The #444 `repair` operation is lock-aware and
// operator-approval-gated, so this service NEVER mutates Git or the filesystem without (a) a fresh live
// reconciliation establishing the workspace genuinely needs the requested recovery, (b) the requested
// strategy being applicable to that reconciled state, and (c) explicit operator approval — and every
// repair appends content-free evidence (SC).
//
// It REUSES the existing engines, adds none (SC1): the worktree-recreating strategies delegate to the
// #445 provisioning re-materialization path (which rebuilds a missing worktree from the existing branch
// and refreshes a stale pointer through the SAME narrow worktree adapter, with its own rollback +
// evidence); `release-stale-lock` is a content-free store upsert clearing the lock field; and
// `abandon-and-cleanup` is a legal lifecycle transition to `abandoned` (physical cleanup stays #448's).
// Strategies that cannot be applied safely without a human — reattach a deleted branch, resolve a moved
// HEAD or uncommitted work, repair a containment escape — return an `operator-required` result with NO
// mutation.

import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  isLegalTaskWorkspaceTransition,
  isWorkspaceRecoveryStrategy,
  isWorkspaceRepairStrategyApplicable,
  reconciliationStatusFromInstance,
  validateTaskWorkspaceTransition,
  workspaceEntryOperatorActionRequired,
  type TaskWorkspaceLifecycleState,
  type WorkspaceEventType,
  type WorkspaceInstance,
  type WorkspaceLock,
  type WorkspaceReconciliationOutcome,
  type WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { buildBinding } from "./binding.js";
import { TaskWorkspaceError } from "./errors.js";
import { assertSafeFieldValue } from "./field-safety.js";
import { lockIsLive, makeWorkspaceLock, resolveLockTtl } from "./locks.js";
import { workspaceKey } from "./mutex.js";
import { reconcileSingleInstance } from "./reconciliation.js";
import {
  appendWorkspaceLifecycleEvidence,
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
  type WorkspaceLifecycleOutcome,
} from "./evidence.js";
import type {
  WorkspaceReconciliationServiceDeps,
  WorkspaceRepairRequest,
  WorkspaceRepairResult,
  WorkspaceRepairService,
  WorkspaceRepairServiceDeps,
} from "./types.js";

const MAX_FIELD_LENGTH = 512;

interface RepairCtx {
  readonly deps: WorkspaceRepairServiceDeps;
  readonly lockTtlMs: number;
}

function isBoundedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

// The #444 `repair` operation declares requiresLock:true. The service reserves the workspace lock for
// the requesting actor before any mutation and releases it afterwards, mirroring the #445 provisioning
// lock lifecycle. The whole repair runs under the `ws:` in-process mutex (#449, ADR-0093 D1) so the
// advisory check → reconcile → acquire → mutate sequence is atomic against same-process callers; the
// advisory lock builder is the consolidated locks.ts helper.
function makeRepairLock(ctx: RepairCtx, owner: string, nowMs: number): WorkspaceLock {
  return makeWorkspaceLock({
    newId: ctx.deps.newId,
    owner,
    reason: "repair",
    nowMs,
    ttlMs: ctx.lockTtlMs,
  });
}

// Releases a still-held repair lock owned by this actor. The provision/release/abandon paths already
// persist their own terminal lock state, so this only fires when a repair errored before clearing it.
function releaseRepairLock(ctx: RepairCtx, workspaceId: string, owner: string): void {
  const current = ctx.deps.store.getById(workspaceId);
  if (current?.lock?.owner === owner && current.lock.reason === "repair") {
    ctx.deps.store.upsert({ ...current, lock: null, updatedAt: isoFrom(ctx.deps.now()) });
  }
}

// The reconciliation deps are a subset of the repair deps, so the repair service re-classifies a single
// instance through the exact same fact-gathering and persistence path reconciliation uses.
function reconDeps(deps: WorkspaceRepairServiceDeps): WorkspaceReconciliationServiceDeps {
  return {
    store: deps.store,
    activePointerStore: deps.activePointerStore,
    evidenceStore: deps.evidenceStore,
    managedRoot: deps.managedRoot,
    createAdapter: deps.createAdapter,
    redactString: deps.redactString,
    now: deps.now,
    newId: deps.newId,
    ...(deps.lockTtlMs !== undefined ? { lockTtlMs: deps.lockTtlMs } : {}),
  };
}

function emitRepair(
  ctx: RepairCtx,
  instance: WorkspaceInstance,
  fromState: TaskWorkspaceLifecycleState,
  outcome: WorkspaceLifecycleOutcome,
  type: WorkspaceEventType,
  nowMs: number,
): void {
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    type,
    at: isoFrom(nowMs),
    correlationId: instance.auditCorrelationId,
    fromState,
    toState: instance.lifecycleState,
    health: instance.health,
    ...(instance.driftMarkers.length > 0 ? { driftMarkers: instance.driftMarkers } : {}),
  });
  appendWorkspaceLifecycleEvidence(
    ctx.deps.evidenceStore,
    {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: nowMs,
      operation: "repair",
      outcome,
      attempt: 1,
      durationMs: 0,
      worktreeCount: 0,
      event,
    },
    ctx.deps.redactString,
  );
}

function resultFor(
  instance: WorkspaceInstance,
  strategy: WorkspaceRecoveryStrategy,
  applied: boolean,
): WorkspaceRepairResult {
  const status = reconciliationStatusFromInstance({
    lifecycleState: instance.lifecycleState,
    health: instance.health,
    driftMarkers: instance.driftMarkers,
  });
  return {
    instance,
    binding: buildBinding(instance),
    strategy,
    applied,
    outcome: applied ? "repaired" : "operator-required",
    status,
    driftMarkers: instance.driftMarkers,
    operatorActionRequired: workspaceEntryOperatorActionRequired(instance.recoveryHints),
  };
}

// release-stale-lock: clear the lock field (no Git/filesystem mutation, just a content-free store
// upsert), then re-reconcile so the classification recomputes without the stale-lock marker.
async function applyReleaseStaleLock(
  ctx: RepairCtx,
  instance: WorkspaceInstance,
  requestedBy: string,
  nowMs: number,
): Promise<WorkspaceInstance> {
  const cleared = ctx.deps.store.upsert({ ...instance, lock: null, updatedAt: isoFrom(nowMs) });
  const reconciled = await reconcileSingleInstance(
    reconDeps(ctx.deps),
    cleared,
    ctx.deps.now(),
    requestedBy,
  );
  return reconciled.instance;
}

// abandon-and-cleanup: a legal lifecycle transition to `abandoned` (operator-approval gated). Physical
// worktree cleanup is deferred to #448; this only records the terminal decision and clears the active
// pointer if it referenced this workspace.
function applyAbandon(
  ctx: RepairCtx,
  instance: WorkspaceInstance,
  nowMs: number,
): WorkspaceInstance {
  const transition = validateTaskWorkspaceTransition({
    from: instance.lifecycleState,
    to: "abandoned",
    context: {
      lockHeldByActor: true,
      pathContained: false,
      worktreeClean: false,
      branchReady: false,
      providerReady: false,
      operatorApproved: true,
    },
  });
  if (!transition.ok) {
    throw new TaskWorkspaceError(
      "ILLEGAL_TRANSITION",
      `cannot abandon workspace from ${instance.lifecycleState}`,
      transition.reasons,
    );
  }
  const abandoned = ctx.deps.store.upsert({
    ...instance,
    lifecycleState: "abandoned",
    health: "unknown",
    lock: null,
    driftMarkers: [],
    recoveryHints: [],
    updatedAt: isoFrom(nowMs),
  });
  if (ctx.deps.activePointerStore.get()?.workspaceId === abandoned.workspaceId) {
    ctx.deps.activePointerStore.clear();
  }
  return abandoned;
}

// recreate-worktree / reconcile-pointer: delegate to the #445 provisioning re-materialization path,
// which rebuilds a missing worktree from the existing branch (or resume-completes an existing one and
// refreshes its pointer identity), with its own rollback + evidence. Reuse, not a second git engine.
//
// An EXTERNALLY deleted worktree directory leaves a stale entry in git's worktree admin metadata that
// still claims the task branch is "checked out" at the missing path, so a fresh `git worktree add`
// would be rejected. Pruning first (an allowlisted verb on the same narrow adapter) clears only the
// admin entries whose working directory is already gone — a still-present worktree is untouched — so
// the subsequent re-materialization can re-attach the branch.
async function applyProvisioningRepair(
  ctx: RepairCtx,
  instance: WorkspaceInstance,
  requestedBy: string,
): Promise<WorkspaceInstance> {
  await ctx.deps.createAdapter(detectWorkspaceAt(instance.repositoryRoot)).pruneWorktrees();
  const result = await ctx.deps.provisioning.provision({
    repositoryRequestPath: instance.repositoryRoot,
    taskId: instance.taskId,
    baseBranch: instance.baseBranch,
    requestedBy,
  });
  return result.instance;
}

async function executeStrategy(
  ctx: RepairCtx,
  instance: WorkspaceInstance,
  strategy: WorkspaceRecoveryStrategy,
  requestedBy: string,
  nowMs: number,
): Promise<WorkspaceInstance> {
  switch (strategy) {
    case "recreate-worktree":
    case "reconcile-pointer":
      return applyProvisioningRepair(ctx, instance, requestedBy);
    case "release-stale-lock":
      return applyReleaseStaleLock(ctx, instance, requestedBy, nowMs);
    case "abandon-and-cleanup":
      return applyAbandon(ctx, instance, nowMs);
    default:
      // reattach-branch / operator-repair / commit-or-stash-required never reach here (they are
      // operator-required and short-circuit earlier); this is a defensive guard.
      throw new TaskWorkspaceError(
        "REPAIR_NOT_APPLICABLE",
        `strategy ${strategy} is not an automatic repair`,
      );
  }
}

function validateRequest(request: WorkspaceRepairRequest): WorkspaceRecoveryStrategy {
  if (!isBoundedNonEmpty(request.workspaceId) || !isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "invalid repair request");
  }
  // requestedBy becomes the repair advisory-lock owner; reject control/zero-width/bidi code points.
  assertSafeFieldValue(request.requestedBy, "requestedBy");
  if (!isWorkspaceRecoveryStrategy(request.strategy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "unknown recovery strategy");
  }
  return request.strategy;
}

// Whether the requested strategy needs a human regardless of approval: either it is one of the
// inherently operator-guided strategies, or reconciliation mapped its drift to an operator-required
// hint (e.g. a deleted branch).
function needsOperator(
  outcome: WorkspaceReconciliationOutcome,
  strategy: WorkspaceRecoveryStrategy,
): boolean {
  if (
    strategy === "operator-repair" ||
    strategy === "commit-or-stash-required" ||
    strategy === "reattach-branch"
  ) {
    return true;
  }
  const hint = outcome.recoveryHints.find((candidate) => candidate.strategy === strategy);
  return hint?.operatorActionRequired === true;
}

// Emits the operator-required evidence and returns the no-mutation result for a recovery that needs a
// human (corrupt pointer, moved HEAD, uncommitted work, deleted branch).
function reportOperatorRequired(
  ctx: RepairCtx,
  reconciled: WorkspaceInstance,
  strategy: WorkspaceRecoveryStrategy,
): WorkspaceRepairResult {
  emitRepair(
    ctx,
    reconciled,
    reconciled.lifecycleState,
    "operator-required",
    "transition-rejected",
    ctx.deps.now(),
  );
  return resultFor(reconciled, strategy, false);
}

// The authorization gates before any mutation: operator approval (the #444 `repair` operation requires
// it), applicability of the requested strategy to the reconciled state, and — for abandon — that the
// current lifecycle can LEGALLY reach `abandoned` (an active/provisioning workspace must be paused or
// fail/recover first), refused cleanly as not-applicable rather than as a downstream illegal transition.
function assertRepairAuthorized(
  request: WorkspaceRepairRequest,
  reconciled: WorkspaceInstance,
  outcome: WorkspaceReconciliationOutcome,
  strategy: WorkspaceRecoveryStrategy,
): void {
  if (!request.operatorApproved) {
    throw new TaskWorkspaceError("OPERATOR_APPROVAL_REQUIRED", "repair requires operator approval");
  }
  if (
    !isWorkspaceRepairStrategyApplicable({
      status: outcome.status,
      recoveryHints: outcome.recoveryHints,
      strategy,
    })
  ) {
    throw new TaskWorkspaceError(
      "REPAIR_NOT_APPLICABLE",
      `strategy ${strategy} is not applicable to a ${outcome.status} workspace`,
    );
  }
  if (
    strategy === "abandon-and-cleanup" &&
    !isLegalTaskWorkspaceTransition(reconciled.lifecycleState, "abandoned")
  ) {
    throw new TaskWorkspaceError(
      "REPAIR_NOT_APPLICABLE",
      `a ${reconciled.lifecycleState} workspace must be paused or flagged for recovery before it can be abandoned`,
    );
  }
}

async function repairLocked(
  ctx: RepairCtx,
  request: WorkspaceRepairRequest,
): Promise<WorkspaceRepairResult> {
  const strategy = validateRequest(request);
  const existing = ctx.deps.store.getById(request.workspaceId);
  if (existing === undefined) {
    throw new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "workspace not found");
  }
  const nowMs = ctx.deps.now();
  if (
    lockIsLive(existing.lock, nowMs, ctx.lockTtlMs) &&
    existing.lock?.owner !== request.requestedBy
  ) {
    throw new TaskWorkspaceError("LOCK_CONTENTION", "workspace is locked by another actor");
  }

  // Ground truth: re-reconcile this instance live before deciding anything (the persisted state may be
  // stale — the worktree may have been fixed or drifted further since the last pass).
  const { instance: reconciled, outcome } = await reconcileSingleInstance(
    reconDeps(ctx.deps),
    existing,
    nowMs,
    request.requestedBy,
  );

  // No automatic mutation is safe: report the operator requirement without touching Git/filesystem.
  if (needsOperator(outcome, strategy)) {
    return reportOperatorRequired(ctx, reconciled, strategy);
  }
  assertRepairAuthorized(request, reconciled, outcome, strategy);

  // Acquire the workspace lock for the requesting actor before mutating (the #444 `repair` operation is
  // requiresLock:true). executeStrategy persists its own terminal lock state (provision clears it,
  // release-stale-lock/abandon set it null); the finally releases the repair lock only if it is still
  // ours — so an error mid-repair never leaves the workspace locked.
  const fromState = reconciled.lifecycleState;
  const locked = ctx.deps.store.upsert({
    ...reconciled,
    lock: makeRepairLock(ctx, request.requestedBy, nowMs),
    updatedAt: isoFrom(nowMs),
  });
  try {
    const repaired = await executeStrategy(ctx, locked, strategy, request.requestedBy, nowMs);
    // Read back the authoritative post-repair instance (the provisioning path persists its own state).
    const finalInstance = ctx.deps.store.getById(repaired.workspaceId) ?? repaired;
    emitRepair(ctx, finalInstance, fromState, "repaired", "repaired", ctx.deps.now());
    return resultFor(finalInstance, strategy, true);
  } finally {
    releaseRepairLock(ctx, request.workspaceId, request.requestedBy);
  }
}

// Serializes the whole repair (advisory check → live reconcile → lock acquire → strategy mutation) under
// the workspace's `ws:` key (#449, ADR-0093 D1). The nested provisioning re-materialization runs under
// the distinct `prov:` key, so there is no self-deadlock against this `ws:` hold.
function repairImpl(
  ctx: RepairCtx,
  request: WorkspaceRepairRequest,
): Promise<WorkspaceRepairResult> {
  return ctx.deps.mutex.runExclusive([workspaceKey(request.workspaceId)], () =>
    repairLocked(ctx, request),
  );
}

export function createWorkspaceRepairService(
  deps: WorkspaceRepairServiceDeps,
): WorkspaceRepairService {
  const ctx: RepairCtx = { deps, lockTtlMs: resolveLockTtl(deps.lockTtlMs) };
  return {
    repair: (request: WorkspaceRepairRequest): Promise<WorkspaceRepairResult> =>
      repairImpl(ctx, request),
  };
}
