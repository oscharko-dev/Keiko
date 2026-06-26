// Startup reconciliation for managed task workspaces (Issue #447, Epic #443).
//
// This turns the durable WorkspaceInstance store (#445) and the active pointer (#446) into trustworthy
// OPERATIONAL state after restarts, partial failures, external filesystem changes, or git worktree
// drift. For each persisted instance it gathers content-free FACTS by IO — realpath containment of the
// persisted path inside the managed root (a persisted path is NEVER trusted without realpath
// verification, SC), the `.git` linked-worktree pointer state + its content-free identity, the task
// branch presence and the worktree HEAD via the narrow #445 worktree adapter, and the lock liveness —
// then defers ALL the decision logic to the pure #444/#447 contract classifier. The classification is
// persisted within LEGAL lifecycle transitions (an operational workspace whose disk state is no longer
// trustworthy is flagged `recovery-required`, never silently dropped, AC2), and one content-free
// evidence document is appended per instance.
//
// It REUSES the existing subsystems and adds none: containment is delegated to the same
// managed-root/keiko-workspace helper provisioning uses, git inspection runs through the SAME narrow
// keiko-tools worktree adapter (no `git status`, no allowlist widening), and the durable home is the
// SAME store. Restoration of the last active workspace is conservative — it never auto-selects among
// ambiguous active workspaces (SC).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertContainedRealPath,
  detectWorkspaceAt,
  PathEscapeError,
  resolveWithinWorkspace,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type {
  GitWorktreeAdapter,
  WorktreeListEntry,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  classifyWorkspaceReconciliation,
  deriveReconciliationEntry,
  reconciliationHealth,
  reconciliationRequiresRecoveryFlag,
  resolveActiveRestoration,
  validateTaskWorkspaceTransition,
  type TaskWorkspaceLifecycleState,
  type WorkspaceEventType,
  type WorkspaceInstance,
  type WorkspaceReconciliationEntry,
  type WorkspaceReconciliationFacts,
  type WorkspaceReconciliationOutcome,
  type WorkspaceReconciliationReport,
} from "@oscharko-dev/keiko-contracts";
import { deriveRepositoryId } from "./naming.js";
import {
  appendWorkspaceLifecycleEvidence,
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
} from "./evidence.js";
import type {
  WorkspaceReconciliationService,
  WorkspaceReconciliationServiceDeps,
} from "./types.js";

const DEFAULT_LOCK_TTL_MS = 5 * 60_000;

interface ReconcileCtx {
  readonly deps: WorkspaceReconciliationServiceDeps;
  readonly lockTtlMs: number;
}

// The result of reconciling a single instance: the freshly persisted record plus the pure outcome.
export interface ReconcileInstanceResult {
  readonly instance: WorkspaceInstance;
  readonly outcome: WorkspaceReconciliationOutcome;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

// Same lock-liveness rule as the provisioning + lifecycle services: an explicit expiry wins, otherwise
// the TTL since acquisition; a non-finite timestamp fails closed (treated as not live).
function lockIsLive(lock: WorkspaceInstance["lock"], nowMs: number, ttlMs: number): boolean {
  if (lock === null) return false;
  if (lock.expiresAt !== undefined) {
    const expiry = Date.parse(lock.expiresAt);
    return Number.isFinite(expiry) ? nowMs < expiry : false;
  }
  const acquired = Date.parse(lock.acquiredAt);
  return Number.isFinite(acquired) ? nowMs - acquired < ttlMs : false;
}

// Non-throwing content-free identity of a worktree's git admin dir, or undefined when the `.git`
// linked-worktree pointer is missing/malformed. Mirrors the throwing variant in provisioning.ts but
// returns undefined so reconciliation can classify a stale pointer instead of failing.
function safeGitdirIdentity(worktreePath: string): string | undefined {
  let raw: string;
  try {
    const dotGit = join(worktreePath, ".git");
    if (statSync(dotGit).isDirectory()) return undefined;
    raw = readFileSync(dotGit, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)\s*$/mu.exec(raw);
  if (match?.[1] === undefined || match[1].length === 0) return undefined;
  return createHash("sha256").update(match[1].trim(), "utf8").digest("hex").slice(0, 32);
}

// Realpath-aware containment check delegated to keiko-workspace (same engine provisioning uses). True
// when the persisted managed path still resolves inside the managed root after symlink resolution; any
// escape OR an unverifiable parent chain is treated conservatively as not-contained, so reconciliation
// never trusts a persisted path it cannot prove (SC).
function isContained(managedRoot: string, worktreePath: string): boolean {
  try {
    resolveWithinWorkspace(managedRoot, worktreePath);
    assertContainedRealPath(nodeWorkspaceFs, managedRoot, worktreePath, "managed worktree path");
    return true;
  } catch (error) {
    if (error instanceof PathEscapeError) return false;
    return false;
  }
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

// Finds the porcelain worktree-list entry whose path resolves to the managed worktree path. Compares
// realpaths so a symlinked managed root still matches the canonical path git reports.
function findWorktreeEntry(
  worktrees: readonly WorktreeListEntry[],
  worktreePath: string,
): WorktreeListEntry | undefined {
  const target = realpathOrSelf(worktreePath);
  return worktrees.find((entry) => realpathOrSelf(entry.path) === target);
}

export interface FactsAndHead {
  readonly facts: WorkspaceReconciliationFacts;
  readonly observedHead: string | undefined;
}

interface LockFacts {
  readonly lockPresent: boolean;
  readonly lockLive: boolean;
  readonly lockedByOtherActor: boolean;
}

// `actor` scopes lock ownership: in a system reconciliation pass it is undefined, so ANY live lock
// defers (status `locked`); for a repair re-classification it is the requesting actor, so only a
// foreign live lock defers.
function computeLockFacts(
  lock: WorkspaceInstance["lock"],
  nowMs: number,
  ttlMs: number,
  actor: string | undefined,
): LockFacts {
  const lockLive = lockIsLive(lock, nowMs, ttlMs);
  return {
    lockPresent: lock !== null,
    lockLive,
    lockedByOtherActor: lockLive && (actor === undefined || lock?.owner !== actor),
  };
}

// Gathers the content-free reconciliation facts for one instance.
async function gatherFacts(
  ctx: ReconcileCtx,
  adapter: GitWorktreeAdapter,
  worktrees: readonly WorktreeListEntry[],
  instance: WorkspaceInstance,
  nowMs: number,
  actor: string | undefined,
): Promise<FactsAndHead> {
  const pathContained = isContained(ctx.deps.managedRoot, instance.managedWorktreePath);
  const worktreeDirExists = pathContained && existsSync(instance.managedWorktreePath);
  const identity = worktreeDirExists ? safeGitdirIdentity(instance.managedWorktreePath) : undefined;
  const taskBranchPresent = worktreeDirExists
    ? await adapter.localBranchExists(instance.taskBranch)
    : false;
  const entry = worktreeDirExists
    ? findWorktreeEntry(worktrees, instance.managedWorktreePath)
    : undefined;
  const observedHead = entry?.head;
  const lock = computeLockFacts(instance.lock, nowMs, ctx.lockTtlMs, actor);
  return {
    observedHead,
    facts: {
      lifecycleState: instance.lifecycleState,
      pathContained,
      worktreeDirExists,
      gitPointerPresent: identity !== undefined,
      gitdirIdentityMatches: identity !== undefined && identity === instance.gitdirIdentity,
      taskBranchPresent,
      headMatches:
        instance.lastVerifiedHead === undefined || instance.lastVerifiedHead === observedHead,
      // Worktree cleanliness is NOT live-detected: the narrow #445 adapter has no `git status` verb and
      // widening it would weaken the governed-mutation boundary. A previously recorded dirty signal is
      // preserved so it still surfaces; live cleanliness is #448's responsibility.
      uncommittedChanges: instance.driftMarkers.includes("uncommitted-changes"),
      lockPresent: lock.lockPresent,
      lockLive: lock.lockLive,
      lockedByOtherActor: lock.lockedByOtherActor,
    },
  };
}

function reconcileEventType(
  outcome: WorkspaceReconciliationOutcome,
  flaggedRecovery: boolean,
): WorkspaceEventType {
  if (flaggedRecovery) return "recovery-flagged";
  if (outcome.driftMarkers.length > 0) return "drift-detected";
  return "health-changed";
}

function emitReconcileEvidence(
  ctx: ReconcileCtx,
  instance: WorkspaceInstance,
  fromState: TaskWorkspaceLifecycleState,
  outcome: WorkspaceReconciliationOutcome,
  flaggedRecovery: boolean,
  nowMs: number,
): void {
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    type: reconcileEventType(outcome, flaggedRecovery),
    at: isoFrom(nowMs),
    correlationId: instance.auditCorrelationId,
    fromState,
    toState: instance.lifecycleState,
    health: instance.health,
    ...(outcome.driftMarkers.length > 0 ? { driftMarkers: outcome.driftMarkers } : {}),
  });
  appendWorkspaceLifecycleEvidence(
    ctx.deps.evidenceStore,
    {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: nowMs,
      operation: "reconcile",
      outcome: "reconciled",
      attempt: 1,
      durationMs: 0,
      worktreeCount: 0,
      event,
    },
    ctx.deps.redactString,
  );
}

// Classifies one instance against pre-fetched git state, persists the classification within a legal
// transition, and appends evidence. Pure decision-making is delegated to the contract; this only does
// IO + persistence.
function reconcileWithContext(
  ctx: ReconcileCtx,
  facts: WorkspaceReconciliationFacts,
  observedHead: string | undefined,
  instance: WorkspaceInstance,
  nowMs: number,
): ReconcileInstanceResult {
  const outcome = classifyWorkspaceReconciliation(facts);
  const health = reconciliationHealth(outcome.status);
  const fromState = instance.lifecycleState;
  let targetState = fromState;
  if (reconciliationRequiresRecoveryFlag(outcome.status, fromState)) {
    const transition = validateTaskWorkspaceTransition({
      from: fromState,
      to: "recovery-required",
      context: {
        lockHeldByActor: false,
        pathContained: facts.pathContained,
        worktreeClean: false,
        branchReady: false,
        providerReady: false,
        operatorApproved: false,
      },
    });
    if (transition.ok) targetState = "recovery-required";
  }
  const iso = isoFrom(nowMs);
  const persisted = ctx.deps.store.upsert({
    ...instance,
    lifecycleState: targetState,
    health,
    driftMarkers: outcome.driftMarkers,
    recoveryHints: outcome.recoveryHints,
    lastVerifiedAt: iso,
    updatedAt: iso,
    ...(outcome.status === "healthy" && observedHead !== undefined
      ? { lastVerifiedHead: observedHead }
      : {}),
  });
  emitReconcileEvidence(ctx, persisted, fromState, outcome, targetState !== fromState, nowMs);
  return { instance: persisted, outcome };
}

// Gathers the content-free reconciliation facts for one instance against a PRE-FETCHED adapter +
// worktree list, WITHOUT persisting or classifying. Exported so the #448 health service can build the
// same WorkspaceReconciliationFacts the reconciler uses (no second containment/git engine) and then
// layer its live dirty + ownership signals on top.
export function gatherInstanceReconciliationFacts(
  deps: WorkspaceReconciliationServiceDeps,
  adapter: GitWorktreeAdapter,
  worktrees: readonly WorktreeListEntry[],
  instance: WorkspaceInstance,
  nowMs: number,
  actor?: string,
): Promise<FactsAndHead> {
  const ctx: ReconcileCtx = { deps, lockTtlMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS };
  return gatherFacts(ctx, adapter, worktrees, instance, nowMs, actor);
}

// Reconciles a SINGLE instance end to end (builds its own adapter + worktree list). Exported so the
// repair service re-classifies an instance through the exact same fact-gathering and persistence path.
export async function reconcileSingleInstance(
  deps: WorkspaceReconciliationServiceDeps,
  instance: WorkspaceInstance,
  nowMs: number,
  actor?: string,
): Promise<ReconcileInstanceResult> {
  const ctx: ReconcileCtx = { deps, lockTtlMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS };
  const adapter = deps.createAdapter(detectWorkspaceAt(instance.repositoryRoot));
  const worktrees = await adapter.listWorktrees();
  const { facts, observedHead } = await gatherFacts(
    ctx,
    adapter,
    worktrees,
    instance,
    nowMs,
    actor,
  );
  return reconcileWithContext(ctx, facts, observedHead, instance, nowMs);
}

function entryFromInstance(instance: WorkspaceInstance): WorkspaceReconciliationEntry {
  return deriveReconciliationEntry({
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    lifecycleState: instance.lifecycleState,
    health: instance.health,
    driftMarkers: instance.driftMarkers,
    recoveryHints: instance.recoveryHints,
    ...(instance.lastVerifiedAt !== undefined ? { lastVerifiedAt: instance.lastVerifiedAt } : {}),
  });
}

function buildReport(
  ctx: ReconcileCtx,
  instances: readonly WorkspaceInstance[],
  nowMs: number,
): WorkspaceReconciliationReport {
  const entries = instances.map(entryFromInstance);
  const pointer = ctx.deps.activePointerStore.get();
  const restoration = resolveActiveRestoration(pointer?.workspaceId, entries);
  if (restoration.kind === "cleared-dangling") ctx.deps.activePointerStore.clear();
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    generatedAt: isoFrom(nowMs),
    entries,
    activeRestoration: restoration,
  };
}

function instancesFor(
  deps: WorkspaceReconciliationServiceDeps,
  repositoryRoot: string | undefined,
): readonly WorkspaceInstance[] {
  if (repositoryRoot === undefined || repositoryRoot.length === 0) return deps.store.listAll();
  return deps.store.listByRepository(deriveRepositoryId(repositoryRoot));
}

// Live reconcile: group the in-scope instances by repository root so each repository's worktree list
// is fetched once, reconcile every instance, then build the report from the freshly persisted records.
async function reconcileImpl(
  ctx: ReconcileCtx,
  repositoryRoot: string | undefined,
): Promise<WorkspaceReconciliationReport> {
  const instances = instancesFor(ctx.deps, repositoryRoot);
  const byRepo = new Map<string, WorkspaceInstance[]>();
  for (const instance of instances) {
    const group = byRepo.get(instance.repositoryRoot) ?? [];
    group.push(instance);
    byRepo.set(instance.repositoryRoot, group);
  }
  const reconciled: WorkspaceInstance[] = [];
  for (const [root, group] of byRepo) {
    const adapter = ctx.deps.createAdapter(detectWorkspaceAt(root));
    const worktrees = await adapter.listWorktrees();
    for (const instance of group) {
      const nowMs = ctx.deps.now();
      const { facts, observedHead } = await gatherFacts(
        ctx,
        adapter,
        worktrees,
        instance,
        nowMs,
        undefined,
      );
      reconciled.push(reconcileWithContext(ctx, facts, observedHead, instance, nowMs).instance);
    }
  }
  return buildReport(ctx, reconciled, ctx.deps.now());
}

export function createWorkspaceReconciliationService(
  deps: WorkspaceReconciliationServiceDeps,
): WorkspaceReconciliationService {
  const ctx: ReconcileCtx = { deps, lockTtlMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS };
  return {
    report: (repositoryRoot?: string): WorkspaceReconciliationReport =>
      buildReport(ctx, instancesFor(deps, repositoryRoot), deps.now()),
    reconcile: (repositoryRoot?: string): Promise<WorkspaceReconciliationReport> =>
      reconcileImpl(ctx, repositoryRoot),
  };
}
