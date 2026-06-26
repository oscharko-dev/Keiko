// Active task-workspace binding + lifecycle-action service (Issue #446, Epic #443).
//
// This is the cross-surface binding AUTHORITY. It owns the singleton active pointer (active-store.ts)
// and the operator-driven switch / pause / resume / handoff-preparation actions. The WorkspaceBinding
// every surface consumes is DERIVED from the active instance (binding.ts) — there is one derivation,
// never a recomputed second copy of the root, so a switch atomically retargets all surfaces.
//
// It REUSES #445 and does NOT duplicate any worktree / lock / transition engine (SC1):
//   - setActive / resume delegate the lifecycle walk into `active` to provisioning.activate(), which
//     already gates validateTaskWorkspaceTransition, resolves preconditions, persists, emits evidence,
//     and rejects drift; this service only then records the active pointer.
//   - pause / prepareHandoff load the instance, resolve the #444 TaskWorkspaceTransitionContext,
//     gate validateTaskWorkspaceTransition, persist through the SAME store, and append the SAME
//     content-free lifecycle evidence.
//
// The worktree-clean precondition is derived from the persisted instance's drift markers
// (uncommitted-changes ⇒ dirty) — the SAME signal the switcher renders as the dirty badge — so the
// service stays within the deliberately narrow #445 worktree adapter (no `git status` subcommand, no
// adapter allowlist widening). Live re-verification of cleanliness is #447/#448's responsibility.

import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  validateTaskWorkspaceTransition,
  type TaskWorkspaceLifecycleState,
  type TaskWorkspaceTransitionContext,
  type WorkspaceEventType,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { buildBinding } from "./binding.js";
import { deriveRepositoryId } from "./naming.js";
import { managedTargetExists } from "./managed-root.js";
import { TaskWorkspaceError } from "./errors.js";
import {
  appendWorkspaceLifecycleEvidence,
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
  type WorkspaceLifecycleOperation,
  type WorkspaceLifecycleOutcome,
} from "./evidence.js";
import type {
  ActiveWorkspaceView,
  SetActiveWorkspaceRequest,
  WorkspaceLifecycleActionRequest,
  WorkspaceLifecycleActionResult,
  WorkspaceLifecycleService,
  WorkspaceLifecycleServiceDeps,
} from "./types.js";

const DEFAULT_LOCK_TTL_MS = 5 * 60_000;
const MAX_FIELD_LENGTH = 512;

interface LifecycleCtx {
  readonly deps: WorkspaceLifecycleServiceDeps;
  readonly lockTtlMs: number;
}

// Mirrors the direct transitions this service performs (active→paused, *→handoff-ready) to the
// matching content-free operation/outcome/event-type triple recorded in evidence.
interface DirectTransitionSpec {
  readonly to: TaskWorkspaceLifecycleState;
  readonly operation: WorkspaceLifecycleOperation;
  readonly outcome: WorkspaceLifecycleOutcome;
  readonly eventType: WorkspaceEventType;
  readonly clearPointerIfActive: boolean;
}

function isBoundedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

// Lock liveness mirrors the provisioning service: an expiry wins if present, otherwise the TTL since
// acquisition. A non-finite timestamp fails closed (treated as not live).
function lockIsLive(lock: WorkspaceInstance["lock"], nowMs: number, ttlMs: number): boolean {
  if (lock === null) return false;
  if (lock.expiresAt !== undefined) {
    const expiry = Date.parse(lock.expiresAt);
    return Number.isFinite(expiry) ? nowMs < expiry : false;
  }
  const acquired = Date.parse(lock.acquiredAt);
  return Number.isFinite(acquired) ? nowMs - acquired < ttlMs : false;
}

function emit(
  ctx: LifecycleCtx,
  input: {
    readonly operation: WorkspaceLifecycleOperation;
    readonly outcome: WorkspaceLifecycleOutcome;
    readonly type: WorkspaceEventType;
    readonly instance: WorkspaceInstance;
    readonly fromState: TaskWorkspaceLifecycleState;
    readonly nowMs: number;
  },
): void {
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: input.instance.workspaceId,
    taskId: input.instance.taskId,
    type: input.type,
    at: isoFrom(input.nowMs),
    correlationId: input.instance.workspaceId,
    fromState: input.fromState,
    toState: input.instance.lifecycleState,
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

function loadInstance(ctx: LifecycleCtx, workspaceId: string): WorkspaceInstance {
  if (!isBoundedNonEmpty(workspaceId)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "invalid workspaceId");
  }
  const instance = ctx.deps.store.getById(workspaceId);
  if (instance === undefined) {
    throw new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "workspace not found");
  }
  return instance;
}

// Resolves the #444 transition context for a direct (pause / handoff) action. The actor holds the
// mutation lock by construction unless ANOTHER actor holds a live lock (then it is contention, not a
// transition rejection). worktree-clean is the persisted drift signal; path-contained is the managed
// worktree still being present on disk.
function resolveTransitionContext(
  ctx: LifecycleCtx,
  instance: WorkspaceInstance,
  requestedBy: string,
  nowMs: number,
): TaskWorkspaceTransitionContext {
  if (lockIsLive(instance.lock, nowMs, ctx.lockTtlMs) && instance.lock?.owner !== requestedBy) {
    throw new TaskWorkspaceError("LOCK_CONTENTION", "workspace is locked by another actor");
  }
  return {
    lockHeldByActor: true,
    pathContained: managedTargetExists(instance.managedWorktreePath),
    worktreeClean: !instance.driftMarkers.includes("uncommitted-changes"),
    branchReady: true,
    providerReady: false,
    operatorApproved: false,
  };
}

function runDirectTransition(
  ctx: LifecycleCtx,
  request: WorkspaceLifecycleActionRequest,
  spec: DirectTransitionSpec,
): WorkspaceLifecycleActionResult {
  if (!isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "requestedBy is required");
  }
  const instance = loadInstance(ctx, request.workspaceId);
  const nowMs = ctx.deps.now();
  const context = resolveTransitionContext(ctx, instance, request.requestedBy, nowMs);
  const validation = validateTaskWorkspaceTransition({
    from: instance.lifecycleState,
    to: spec.to,
    context,
  });
  if (!validation.ok) {
    throw new TaskWorkspaceError(
      "ILLEGAL_TRANSITION",
      `cannot ${spec.operation} workspace from ${instance.lifecycleState}`,
      validation.reasons,
    );
  }
  const fromState = instance.lifecycleState;
  const persisted = ctx.deps.store.upsert({
    ...instance,
    lifecycleState: spec.to,
    lock: null,
    updatedAt: isoFrom(nowMs),
  });
  if (
    spec.clearPointerIfActive &&
    ctx.deps.activePointerStore.get()?.workspaceId === persisted.workspaceId
  ) {
    ctx.deps.activePointerStore.clear();
  }
  emit(ctx, {
    operation: spec.operation,
    outcome: spec.outcome,
    type: spec.eventType,
    instance: persisted,
    fromState,
    nowMs,
  });
  return { instance: persisted, binding: buildBinding(persisted) };
}

async function setActiveImpl(
  ctx: LifecycleCtx,
  request: SetActiveWorkspaceRequest,
): Promise<ActiveWorkspaceView> {
  if (!isBoundedNonEmpty(request.requestedBy)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "requestedBy is required");
  }
  // Delegate the lifecycle walk (paused/active → active, drift + lock checks, persistence, evidence)
  // to the #445 service. Only on success do we record the active pointer — the switch is atomic from
  // the surfaces' view because the derived binding flips in one persisted step.
  const result = await ctx.deps.provisioning.activate({
    workspaceId: request.workspaceId,
    taskId: "",
    requestedBy: request.requestedBy,
    acquireLock: request.acquireLock,
  });
  const pointer = ctx.deps.activePointerStore.set({
    workspaceId: result.instance.workspaceId,
    setBy: request.requestedBy,
    atIso: isoFrom(ctx.deps.now()),
  });
  return { instance: result.instance, binding: result.binding, pointer };
}

function getActiveImpl(ctx: LifecycleCtx): ActiveWorkspaceView | undefined {
  const pointer = ctx.deps.activePointerStore.get();
  if (pointer === undefined) return undefined;
  const instance = ctx.deps.store.getById(pointer.workspaceId);
  if (instance === undefined) {
    // Defensive: a dangling pointer (instance deleted without the FK cascade firing) self-heals to
    // unbound mode rather than reporting a phantom active workspace.
    ctx.deps.activePointerStore.clear();
    return undefined;
  }
  return { instance, binding: buildBinding(instance), pointer };
}

function listImpl(ctx: LifecycleCtx, repositoryRoot: string): readonly WorkspaceInstance[] {
  if (!isBoundedNonEmpty(repositoryRoot)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "repository root is required");
  }
  return ctx.deps.store.listByRepository(deriveRepositoryId(repositoryRoot));
}

async function resumeImpl(
  ctx: LifecycleCtx,
  request: WorkspaceLifecycleActionRequest,
): Promise<WorkspaceLifecycleActionResult> {
  const view = await setActiveImpl(ctx, {
    workspaceId: request.workspaceId,
    requestedBy: request.requestedBy,
    acquireLock: false,
  });
  return { instance: view.instance, binding: view.binding };
}

const PAUSE_SPEC: DirectTransitionSpec = {
  to: "paused",
  operation: "pause",
  outcome: "paused",
  eventType: "paused",
  clearPointerIfActive: true,
};

const HANDOFF_SPEC: DirectTransitionSpec = {
  to: "handoff-ready",
  operation: "handoff",
  outcome: "handoff-prepared",
  eventType: "handoff-prepared",
  clearPointerIfActive: false,
};

export function createWorkspaceLifecycleService(
  deps: WorkspaceLifecycleServiceDeps,
): WorkspaceLifecycleService {
  const ctx: LifecycleCtx = { deps, lockTtlMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS };
  return {
    list: (repositoryRoot: string): readonly WorkspaceInstance[] => listImpl(ctx, repositoryRoot),
    getActive: (): ActiveWorkspaceView | undefined => getActiveImpl(ctx),
    setActive: (request: SetActiveWorkspaceRequest): Promise<ActiveWorkspaceView> =>
      setActiveImpl(ctx, request),
    clearActive: (): void => {
      deps.activePointerStore.clear();
    },
    pause: (request: WorkspaceLifecycleActionRequest): Promise<WorkspaceLifecycleActionResult> =>
      Promise.resolve(runDirectTransition(ctx, request, PAUSE_SPEC)),
    resume: (request: WorkspaceLifecycleActionRequest): Promise<WorkspaceLifecycleActionResult> =>
      resumeImpl(ctx, request),
    prepareHandoff: (
      request: WorkspaceLifecycleActionRequest,
    ): Promise<WorkspaceLifecycleActionResult> =>
      Promise.resolve(runDirectTransition(ctx, request, HANDOFF_SPEC)),
  };
}
