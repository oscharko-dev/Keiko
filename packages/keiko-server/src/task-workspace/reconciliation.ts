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
import type {
  TaskWorkspaceLifecycleState,
  WorkspaceEventType,
  WorkspaceInstance,
  WorkspaceReconciliationEntry,
  WorkspaceReconciliationFacts,
  WorkspaceReconciliationOutcome,
  WorkspaceReconciliationReport,
} from "@oscharko-dev/keiko-contracts";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  classifyWorkspaceReconciliation,
  deriveReconciliationEntry,
  reconciliationHealth,
  reconciliationRequiresRecoveryFlag,
  resolveActiveRestoration,
  validateTaskWorkspaceTransition,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { deriveRepositoryId } from "./naming.js";
import { lockIsLive, resolveLockTtl } from "./locks.js";
import { workspaceKey } from "./mutex.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { recordWorkspaceLifecycle } from "./activity-log.js";
import { buildWorkspaceEvent, WORKSPACE_LIFECYCLE_EVIDENCE_KIND } from "./evidence.js";
import type {
  WorkspaceReconciliationService,
  WorkspaceReconciliationServiceDeps,
} from "./types.js";

interface ReconcileCtx {
  readonly deps: WorkspaceReconciliationServiceDeps;
  readonly lockTtlMs: number;
  // The triggering operation's correlation id, so the worktree adapter's termination evidence joins
  // the same timeline as every other line of that operation (AGENTS.md §8). It lives on the CTX, not
  // in each helper's signature: the ctx is already threaded everywhere the adapter is built, so this
  // needed no new parameter on any private function (PR #3355 review, P2).
  readonly correlationId: string;
}

// The result of reconciling a single instance: the freshly persisted record plus the pure outcome.
export interface ReconcileInstanceResult {
  readonly instance: WorkspaceInstance;
  readonly outcome: WorkspaceReconciliationOutcome;
}

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

// Parses the raw content of a `.git` linked-worktree pointer file and returns its (trimmed) target, or
// undefined when the pointer is missing/malformed. Split out of safeGitdirIdentity so the parse itself —
// specifically its cost on adversarial whitespace padding (S8786) — is directly measurable with no file
// I/O in the timed path: see reconciliation-gitdir-pointer-parse.bench.ts, which imports this exact
// function (never a hand-copied regex) so the bench can never silently drift from the parse it measures.
// See provisioning.ts's gitdirIdentity: the removed leading/trailing `\s*` overlapped with `(.+)`, the
// overlapping-quantifier shape SonarCloud's S8786 rule flags as ReDoS-risky. `.trim()` below already
// strips the same whitespace, so behavior is unchanged. The bench's header states the honest empirical
// result plainly: for this always-matching, single-line pointer, no dynamic measurement (this bench
// included) reliably shows the pre-fix pattern as slower — the S8786 finding is a static, structural
// classification of the pattern's shape, not a demonstrated exploit in this usage. The simplification is
// kept regardless: it is a harmless, strictly-simpler pattern that satisfies the static gate
// (`gates:sonar`) without changing parse behavior.
export function parseGitdirPointerTarget(raw: string): string | undefined {
  const match = /^gitdir:(.+)$/mu.exec(raw);
  if (match?.[1] === undefined || match[1].length === 0) return undefined;
  return match[1].trim();
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
  const target = parseGitdirPointerTarget(raw);
  // Preserves the pre-extraction behavior exactly: only an UNDEFINED target (no match, or an entirely
  // empty capture pre-trim) short-circuits. A target that trims down to "" (e.g. an all-whitespace
  // capture) still reaches the hash below, unchanged from before this function was split out.
  if (target === undefined) return undefined;
  return createHash("sha256").update(target, "utf8").digest("hex").slice(0, 32);
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

// Either an already-resolved repository worktree-list snapshot (every caller that fetches it
// immediately before calling gatherFacts, with no intervening await: gatherInstanceReconciliationFacts,
// reconcileSingleInstance) OR a lazy factory that reconcileImpl's per-instance `ws:<workspaceId>`
// critical section uses instead, so the list is only ever fetched once that instance's lock is held.
type WorktreesSource = readonly WorktreeListEntry[] | (() => Promise<readonly WorktreeListEntry[]>);

async function resolveWorktrees(source: WorktreesSource): Promise<readonly WorktreeListEntry[]> {
  return typeof source === "function" ? source() : source;
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

// Gathers the content-free reconciliation facts for one instance. `worktrees` accepts either shape
// WorktreesSource documents — an already-resolved array, or a lazy factory — and is resolved (fetching
// it, for the lazy shape) ONLY when `worktreeDirExists` is true, since that is the one fact that ever
// consults it (findWorktreeEntry).
async function gatherFacts(
  ctx: ReconcileCtx,
  adapter: GitWorktreeAdapter,
  worktrees: WorktreesSource,
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
    ? findWorktreeEntry(await resolveWorktrees(worktrees), instance.managedWorktreePath)
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
  // The triggering request's own correlation id: the explicit-refresh route's ctx.correlationId, or
  // undefined for the startup reconciliation pass, which has no HTTP request behind it at all — that
  // is the one genuinely correlation-free call site in this module, so it alone falls back to
  // UNKNOWN_CORRELATION_ID rather than the workspace's own persisted identity (AGENTS.md §8).
  correlationId: string | undefined,
): void {
  const resolvedCorrelationId = correlationIdOrUnknown(correlationId);
  const event = buildWorkspaceEvent({
    eventId: ctx.deps.newId(),
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    type: reconcileEventType(outcome, flaggedRecovery),
    at: isoFrom(nowMs),
    correlationId: resolvedCorrelationId,
    fromState,
    toState: instance.lifecycleState,
    health: instance.health,
    ...(outcome.driftMarkers.length > 0 ? { driftMarkers: outcome.driftMarkers } : {}),
  });
  recordWorkspaceLifecycle(ctx.deps, {
    evidenceStore: ctx.deps.evidenceStore,
    record: {
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
    redactString: ctx.deps.redactString,
    errorCode: outcome.status === "healthy" ? undefined : outcome.status,
  });
}

// Decides whether this pass must flag the instance into `recovery-required` — only when the contract's
// own transition table permits the move; otherwise the lifecycle state is unchanged. Extracted from
// reconcileWithContext to keep that function under the repo's per-function line budget (AGENTS.md §6).
function resolveReconciledTargetState(
  facts: WorkspaceReconciliationFacts,
  outcome: WorkspaceReconciliationOutcome,
  fromState: TaskWorkspaceLifecycleState,
): TaskWorkspaceLifecycleState {
  if (!reconciliationRequiresRecoveryFlag(outcome.status, fromState)) return fromState;
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
  return transition.ok ? "recovery-required" : fromState;
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
  correlationId: string | undefined,
): ReconcileInstanceResult {
  const outcome = classifyWorkspaceReconciliation(facts);
  const health = reconciliationHealth(outcome.status);
  const fromState = instance.lifecycleState;
  const targetState = resolveReconciledTargetState(facts, outcome, fromState);
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
  emitReconcileEvidence(
    ctx,
    persisted,
    fromState,
    outcome,
    targetState !== fromState,
    nowMs,
    correlationId,
  );
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
  correlationId?: string,
): Promise<FactsAndHead> {
  const ctx: ReconcileCtx = {
    deps,
    lockTtlMs: resolveLockTtl(deps.lockTtlMs),
    correlationId: correlationIdOrUnknown(correlationId),
  };
  return gatherFacts(ctx, adapter, worktrees, instance, nowMs, actor);
}

// Reconciles a SINGLE instance end to end (builds its own adapter + worktree list). Exported so the
// repair service re-classifies an instance through the exact same fact-gathering and persistence path.
export async function reconcileSingleInstance(
  deps: WorkspaceReconciliationServiceDeps,
  instance: WorkspaceInstance,
  nowMs: number,
  actor?: string,
  correlationId?: string,
): Promise<ReconcileInstanceResult> {
  const ctx: ReconcileCtx = {
    deps,
    lockTtlMs: resolveLockTtl(deps.lockTtlMs),
    correlationId: correlationIdOrUnknown(correlationId),
  };
  const adapter = deps.createAdapter(detectWorkspaceAt(instance.repositoryRoot), ctx.correlationId);
  const worktrees = await adapter.listWorktrees();
  const { facts, observedHead } = await gatherFacts(
    ctx,
    adapter,
    worktrees,
    instance,
    nowMs,
    actor,
  );
  return reconcileWithContext(ctx, facts, observedHead, instance, nowMs, correlationId);
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

// Builds the report from a set of instances. `clearDangling` is true ONLY on the live reconcile path:
// clearing a dangling pointer is a state mutation, so the read-only report() must never perform it (it
// still REPORTS the `cleared-dangling` kind; the next live reconcile or getActive() self-heals it).
function buildReport(
  ctx: ReconcileCtx,
  instances: readonly WorkspaceInstance[],
  nowMs: number,
  clearDangling: boolean,
): WorkspaceReconciliationReport {
  const entries = instances.map(entryFromInstance);
  const pointer = ctx.deps.activePointerStore.get();
  const restoration = resolveActiveRestoration(pointer?.workspaceId, entries);
  if (clearDangling && restoration.kind === "cleared-dangling") {
    ctx.deps.activePointerStore.clear();
  }
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

// Live reconcile: group the in-scope instances by repository root so each repository's adapter is built
// once, reconcile every instance, then build the report from the freshly persisted records. The git
// worktree list is NOT fetched here — see the per-instance comment below for why it moved inside the
// lock.
async function reconcileImpl(
  ctx: ReconcileCtx,
  repositoryRoot: string | undefined,
  correlationId: string | undefined,
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
    const adapter = ctx.deps.createAdapter(detectWorkspaceAt(root), ctx.correlationId);
    for (const instance of group) {
      // Serialize the WHOLE per-instance critical section — re-read, fact-gathering, classification, and
      // the persisted write — under the SAME `ws:<workspaceId>` key every other mutating workspace flow
      // uses (#449, ADR-0093 D1), matching repair.ts's "advisory check -> live reconcile -> lock acquire
      // -> strategy mutation" and cleanup.ts's "re-check persisted liveness inside the critical section"
      // (KEIKO-0996, #3339). Both facts this pass classifies against are read AFTER the lock is held,
      // never before it: `fresh` re-reads the store row from inside the callback (a concurrent
      // activate/pause/repair/cleanup that mutated or deleted the workspace while this pass awaited the
      // lock is observed, not clobbered — and a deleted row is skipped rather than resurrected), and
      // `gatherFacts` is handed a LAZY `() => adapter.listWorktrees()` factory instead of a pre-fetched
      // snapshot. A PR #3348 review finding caught that the first version of this fix widened the lock
      // around fact-gathering but still fed it the SAME worktree list captured once per repository BEFORE
      // any instance in the group acquired its lock, so `observedHead`/`headMatches` could still be
      // classified against pre-mutation git state for an instance further down the group. gatherFacts only
      // invokes the factory when THIS instance's worktree still exists on disk (worktreeDirExists is
      // itself always live), so the documented common case — a backlog of paused instances whose worktree
      // is already gone — costs zero `listWorktrees` spawns, and a live worktree costs exactly one FRESH
      // spawn, taken under its own lock. ADR-0093 D4 bounds live worktrees to single digits per repository
      // in the realistic operating envelope (not the N=200 backlog scale that scale.test.ts seeds), so
      // this cannot reintroduce the O(N) `listWorktrees` blow-up the repository-grouping guard catches.
      // Deliberately NOT applied to reconcileSingleInstance: repair.ts already holds this exact key for
      // its whole operation and re-enters reconcileSingleInstance inside it (locking there would
      // self-deadlock), and that path already fetches its worktree list fresh immediately before use with
      // no intervening await, so it has no equivalent staleness gap to close.
      const result = await ctx.deps.mutex.runExclusive(
        [workspaceKey(instance.workspaceId)],
        async (): Promise<ReconcileInstanceResult | undefined> => {
          const fresh = ctx.deps.store.getById(instance.workspaceId);
          if (fresh === undefined) return undefined;
          const nowMs = ctx.deps.now();
          const { facts, observedHead } = await gatherFacts(
            ctx,
            adapter,
            () => adapter.listWorktrees(),
            fresh,
            nowMs,
            undefined,
          );
          return reconcileWithContext(ctx, facts, observedHead, fresh, nowMs, correlationId);
        },
      );
      if (result !== undefined) reconciled.push(result.instance);
    }
  }
  return buildReport(ctx, reconciled, ctx.deps.now(), true);
}

export function createWorkspaceReconciliationService(
  deps: WorkspaceReconciliationServiceDeps,
): WorkspaceReconciliationService {
  const lockTtlMs = resolveLockTtl(deps.lockTtlMs);
  // Built PER OPERATION, not once per service: the correlation id belongs to the request, and a
  // service-lifetime ctx is exactly what forced the previous UNKNOWN_CORRELATION_ID here.
  const ctxFor = (correlationId: string | undefined): ReconcileCtx => ({
    deps,
    lockTtlMs,
    correlationId: correlationIdOrUnknown(correlationId),
  });
  return {
    // Pure read over persisted rows — no child process, so no termination evidence to join.
    report: (repositoryRoot?: string): WorkspaceReconciliationReport =>
      buildReport(ctxFor(undefined), instancesFor(deps, repositoryRoot), deps.now(), false),
    reconcile: (
      repositoryRoot?: string,
      correlationId?: string,
    ): Promise<WorkspaceReconciliationReport> =>
      reconcileImpl(ctxFor(correlationId), repositoryRoot, correlationId),
  };
}
