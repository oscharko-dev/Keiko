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

import { existsSync, realpathSync } from "node:fs";
import {
  detectWorkspaceAt,
  PathEscapeError,
  resolveWithinWorkspace,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertContainedRealPathWithinOwnedRoot } from "@oscharko-dev/keiko-workspace/internal/owned-root";
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
import { inspectManagedGitdirIdentityOutcome, managedIdentityDriftFor } from "./gitdir-identity.js";
import { lockIsLive, resolveLockTtl } from "./locks.js";
import { workspaceKey } from "./mutex.js";
import { correlationIdOrUnknown } from "../correlation.js";
import {
  logWorkspaceLifecycleFailure,
  recordWorkspaceLifecycle,
  runWithWorkspaceLifecycleFailureLogging,
} from "./activity-log.js";
import { asRepositoryUnreachable, TaskWorkspaceError } from "./errors.js";
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

// Realpath-aware containment check delegated to keiko-workspace (same engine provisioning uses). True
// when the persisted managed path still resolves inside the managed root after symlink resolution; any
// escape OR an unverifiable parent chain is treated conservatively as not-contained, so reconciliation
// never trusts a persisted path it cannot prove (SC).
function isContained(managedRoot: string, worktreePath: string): boolean {
  try {
    resolveWithinWorkspace(managedRoot, worktreePath);
    assertContainedRealPathWithinOwnedRoot(
      nodeWorkspaceFs,
      managedRoot,
      worktreePath,
      "managed worktree path",
    );
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
  // The repository's worktree count as the adapter listed it — a real measurement for the
  // evidence line — or 0 when the list was not consulted because the managed worktree is gone.
  readonly worktreeCount: number;
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
// The identity half of the facts: the live proof's outcome and the one verdict every boundary
// shares. A worktree that is gone proves nothing.
function identityFacts(
  instance: WorkspaceInstance,
  worktreeDirExists: boolean,
): Pick<
  WorkspaceReconciliationFacts,
  | "gitPointerPresent"
  | "gitdirIdentityMatches"
  | "gitdirIdentitySchemaRetired"
  | "gitdirIdentityUnsupported"
> {
  const identityOutcome = worktreeDirExists
    ? inspectManagedGitdirIdentityOutcome(instance.managedWorktreePath, instance.repositoryRoot)
    : ({ kind: "unproven" } as const);
  const identity =
    identityOutcome.kind === "identified" ? identityOutcome.inspection.identity : undefined;
  // The same verdict the access boundary and the provisioning resume use, so live reconciliation
  // cannot re-label a migration or a platform limitation as a replaced pointer and overwrite the
  // marker provisioning persisted.
  // A proof that could not run throws the classified IDENTITY_PROOF_FAILED here; the live pass and
  // the health report isolate it per instance, repair and cleanup fail closed on it.
  const drift = managedIdentityDriftFor(identityOutcome, instance.gitdirIdentity);
  return {
    // A pointer that IS there but sits on a volume without creation time is present; only a
    // missing or malformed pointer is not. Without this the platform limitation collapses into
    // `pointer-stale` one branch earlier and its own marker never fires.
    gitPointerPresent: identityOutcome.kind !== "unproven",
    gitdirIdentityMatches: identity !== undefined && identity === instance.gitdirIdentity,
    gitdirIdentitySchemaRetired: drift === "schema-retired",
    gitdirIdentityUnsupported: drift === "unsupported",
  };
}

// The repository's worktree list — consulted only for a worktree that still exists on disk — and
// the managed worktree's entry in it.
async function listedWorktrees(
  worktrees: WorktreesSource,
  instance: WorkspaceInstance,
  worktreeDirExists: boolean,
): Promise<{ readonly worktreeCount: number; readonly observedHead: string | undefined }> {
  if (!worktreeDirExists) return { worktreeCount: 0, observedHead: undefined };
  const listed = await resolveWorktrees(worktrees);
  return {
    worktreeCount: listed.length,
    observedHead: findWorktreeEntry(listed, instance.managedWorktreePath)?.head,
  };
}

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
  const identity = identityFacts(instance, worktreeDirExists);
  const taskBranchPresent = worktreeDirExists
    ? await adapter.localBranchExists(instance.taskBranch)
    : false;
  const { worktreeCount, observedHead } = await listedWorktrees(
    worktrees,
    instance,
    worktreeDirExists,
  );
  const lock = computeLockFacts(instance.lock, nowMs, ctx.lockTtlMs, actor);
  return {
    observedHead,
    worktreeCount,
    facts: {
      lifecycleState: instance.lifecycleState,
      pathContained,
      worktreeDirExists,
      ...identity,
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

// What one instance's pass measured: how long the fact-gathering and classification took, and how
// many worktrees the repository listed. Both were placeholder zeros before (audit, 2026-09-03).
interface ReconcileMeasurement {
  readonly durationMs: number;
  readonly worktreeCount: number;
}

interface ReconcileEvidenceInput {
  readonly instance: WorkspaceInstance;
  readonly fromState: TaskWorkspaceLifecycleState;
  readonly outcome: WorkspaceReconciliationOutcome;
  readonly flaggedRecovery: boolean;
  readonly nowMs: number;
  // The triggering request's own correlation id: the explicit-refresh route's ctx.correlationId, or
  // undefined for the startup reconciliation pass, which has no HTTP request behind it at all — that
  // is the one genuinely correlation-free call site in this module, so it alone falls back to
  // UNKNOWN_CORRELATION_ID rather than the workspace's own persisted identity (AGENTS.md §8).
  readonly correlationId: string | undefined;
  readonly measurement: ReconcileMeasurement;
}

function emitReconcileEvidence(ctx: ReconcileCtx, input: ReconcileEvidenceInput): void {
  const { instance, fromState, outcome, flaggedRecovery, nowMs, correlationId, measurement } =
    input;
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
    // The primary marker rides on the activity-log line too, so `server.log` alone tells a
    // migration, a platform limitation and a replacement apart (#3376 review).
    ...(outcome.driftMarkers[0] === undefined ? {} : { driftMarker: outcome.driftMarkers[0] }),
    record: {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: nowMs,
      operation: "reconcile",
      outcome: "reconciled",
      attempt: 1,
      durationMs: measurement.durationMs,
      worktreeCount: measurement.worktreeCount,
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
  gathered: FactsAndHead,
  instance: WorkspaceInstance,
  // When this instance's pass began (before fact-gathering), for the measured duration.
  startedAtMs: number,
  correlationId: string | undefined,
): ReconcileInstanceResult {
  const { facts, observedHead } = gathered;
  const nowMs = ctx.deps.now();
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
  emitReconcileEvidence(ctx, {
    instance: persisted,
    fromState,
    outcome,
    flaggedRecovery: targetState !== fromState,
    nowMs,
    correlationId,
    measurement: {
      durationMs: Math.max(0, nowMs - startedAtMs),
      worktreeCount: gathered.worktreeCount,
    },
  });
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
  const { adapter, worktrees } = await consultRepository(ctx, instance.repositoryRoot);
  const gathered = await gatherFacts(ctx, adapter, worktrees, instance, nowMs, actor);
  return reconcileWithContext(ctx, gathered, instance, nowMs, correlationId);
}

interface RepositoryConsultation {
  readonly adapter: GitWorktreeAdapter;
  readonly worktrees: readonly WorktreeListEntry[];
}

// The single-instance path's repository consultation, classified by the SAME rule the pass and the
// health report apply. An operator-approved repair runs against a repository root that can be exactly
// as unavailable as the pass's — an unmounted network volume, a root that vanished, a denied path —
// and the adapter build plus the worktree listing are the two calls that meet it. Left bare, that
// failure reached `runWithWorkspaceLifecycleFailureLogging` (which logs only a TaskWorkspaceError)
// unclassified: no `task-workspace.lifecycle` line for the repair's correlation id, and the route's
// `mapped === undefined` branch turned it into a generic 500 (PR #3381 review). Classified here it is
// the same retryable REPOSITORY_UNREACHABLE, with its frames and cause chain, that ADR-0091 D4
// documents for every pass.
async function consultRepository(
  ctx: ReconcileCtx,
  repositoryRoot: string,
): Promise<RepositoryConsultation> {
  try {
    const adapter = ctx.deps.createAdapter(detectWorkspaceAt(repositoryRoot), ctx.correlationId);
    return { adapter, worktrees: await adapter.listWorktrees() };
  } catch (error) {
    throw repositoryUnreachable(error);
  }
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
    const adapter = adapterForRepository(ctx, root, group, correlationId);
    if (adapter === undefined) {
      // The repository could not be consulted at all (its root vanished, a denied path): every row
      // of that repository is carried forward unverified and the pass continues with the next one.
      reconciled.push(...group.map(carriedForward));
      continue;
    }
    reconciled.push(...(await reconcileRepositoryGroup(ctx, adapter, group, correlationId)));
  }
  return buildReport(ctx, reconciled, ctx.deps.now(), true);
}

// A repository the adapter cannot consult AT ALL is ONE fact about that repository, not one fact per
// row. This latch is the group-scoped memory of it: the first UNCLASSIFIED gathering failure sets it,
// and every remaining row of the group is carried forward without a second git spawn and without a
// duplicate line — so ADR-0091 D4's "logged once as the retryable `REPOSITORY_UNREACHABLE`" is what a
// 20-workspace repository actually produces, the shape `health.ts`'s `evaluateRepositoryGroup` already
// had. Before this, a vanished root wrote N warn lines and spawned git N times for the same fact,
// while the health report wrote one (PR #3381 review).
//
// A CLASSIFIED failure never latches: `IDENTITY_PROOF_FAILED` is a fact about ONE worktree, so the
// next row of the same repository is still gathered, classified and persisted.
//
// The SUCCESSFUL listing is deliberately NOT memoized, and this is the whole reason the latch carries
// the failure rather than the list: the PR #3348 review finding requires every row to classify against
// the worktree list observed AFTER its own `ws:<workspaceId>` lock, so a snapshot shared across the
// group would reintroduce exactly the staleness that fix closed for every instance after the first.
// A repository that cannot be consulted has no fresh observation to lose.
interface RepositoryReachability {
  readonly unreachable: () => boolean;
  readonly markUnreachable: () => void;
}

function repositoryReachability(): RepositoryReachability {
  let unreachable = false;
  return {
    unreachable: (): boolean => unreachable,
    markUnreachable: (): void => {
      unreachable = true;
    },
  };
}

// Every row of one repository, in order, against that repository's already-built adapter.
async function reconcileRepositoryGroup(
  ctx: ReconcileCtx,
  adapter: GitWorktreeAdapter,
  group: readonly WorkspaceInstance[],
  correlationId: string | undefined,
): Promise<readonly WorkspaceInstance[]> {
  const reachability = repositoryReachability();
  const reconciled: WorkspaceInstance[] = [];
  for (const instance of group) {
    if (reachability.unreachable()) {
      // The repository is already known unreachable for this pass: nothing here can be verified, so
      // the row is carried forward exactly as the adapter-build failure above carries its group.
      reconciled.push(carriedForward(instance));
      continue;
    }
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
    const result = await reconcileOneOrCarryForward(
      ctx,
      adapter,
      reachability,
      instance,
      correlationId,
    );
    if (result !== undefined) reconciled.push(result);
  }
  return reconciled;
}

// The pass reports a row it could not verify as itself with health `unknown`: nothing is written,
// the last classification stands, and the report says so honestly.
//
// `unknown` is the whole signal, and the contract reads it: `reconciliationStatusFromInstance` maps
// it to `recovery-required`, so the entry cannot come back `healthy` and `resolveActiveRestoration`
// cannot report the active pointer as `restored` onto it. Before that mapping existed the report
// answered `healthy` for an unverifiable row — an adapter failure used to abort the whole pass, so
// the UI's restore-verification failed closed; isolating the failure per repository turned that into
// a claimed-verified binding against a worktree whose repository was unreachable (PR #3381 review).
function carriedForward(instance: WorkspaceInstance): WorkspaceInstance {
  return { ...instance, health: "unknown" };
}

// A failure that is not one of this module's classified errors — the adapter could not spawn
// because the repository root is gone, a path was denied, a store write failed — is logged as the
// retryable REPOSITORY_UNREACHABLE with its frames and cause chain under the pass's correlation. It
// was previously re-thrown out of the per-instance boundary, which aborted the whole pass: every
// repository after the failing one in iteration order was silently never reconciled, and the
// startup caller's catch swallowed all of it into one diagnostic line (audit finding, 2026-09-03).
function repositoryUnreachable(error: unknown): TaskWorkspaceError {
  return asRepositoryUnreachable(error, "reconciliation could not consult the repository");
}

// Builds the repository's adapter, or logs why it could not be built and returns undefined so the
// caller carries that repository's rows forward instead of aborting the pass.
function adapterForRepository(
  ctx: ReconcileCtx,
  root: string,
  group: readonly WorkspaceInstance[],
  correlationId: string | undefined,
): GitWorktreeAdapter | undefined {
  try {
    return ctx.deps.createAdapter(detectWorkspaceAt(root), ctx.correlationId);
  } catch (error) {
    logWorkspaceLifecycleFailure(
      ctx.deps,
      {
        operation: "reconcile",
        workspaceIdentitySeed: group[0]?.workspaceId ?? deriveRepositoryId(root),
        correlationId,
      },
      repositoryUnreachable(error),
    );
    return undefined;
  }
}

// One instance of the live pass. A row whose live facts cannot be gathered — a proof that could
// not run (IDENTITY_PROOF_FAILED), an adapter that could not spawn, a denied path — is logged with
// its frames under this run's correlation and carried forward unchanged: the last classification
// stands until the facts can be gathered again, so one unreadable worktree or unreachable
// repository never aborts the reconciliation of every other workspace (Cursor review on f50133b95;
// widened from the identity-proof failure to every gathering failure by the 2026-09-03 audit).
// Only the gathering is isolated: a failure to persist or evidence the verdict is not a fact about
// the repository and propagates under its own name, never relabelled as an unreachable repository.
async function reconcileOneOrCarryForward(
  ctx: ReconcileCtx,
  adapter: GitWorktreeAdapter,
  reachability: RepositoryReachability,
  instance: WorkspaceInstance,
  correlationId: string | undefined,
): Promise<WorkspaceInstance | undefined> {
  return runWithWorkspaceLifecycleFailureLogging(
    ctx.deps,
    { operation: "reconcile", workspaceIdentitySeed: instance.workspaceId, correlationId },
    () =>
      ctx.deps.mutex.runExclusive(
        [workspaceKey(instance.workspaceId)],
        async (): Promise<WorkspaceInstance | undefined> => {
          const fresh = ctx.deps.store.getById(instance.workspaceId);
          if (fresh === undefined) return undefined;
          const nowMs = ctx.deps.now();
          const gathered = await gatherFactsOrLogFailure(
            ctx,
            adapter,
            reachability,
            fresh,
            nowMs,
            correlationId,
          );
          // The persisted classification stands (nothing is written), but THIS report says so
          // honestly: the carried entry reports health `unknown` — this pass could not verify the
          // row — without persisting a drift that was not observed (#3376 review).
          if (gathered === undefined) return carriedForward(fresh);
          return reconcileWithContext(ctx, gathered, fresh, nowMs, correlationId).instance;
        },
      ),
  );
}

// The live facts of one row, or `undefined` once the failure to gather them is on the log: a
// classified failure under its own code, an unclassified one as REPOSITORY_UNREACHABLE — the only
// thing an unclassified error inside the adapter and filesystem reads can mean.
async function gatherFactsOrLogFailure(
  ctx: ReconcileCtx,
  adapter: GitWorktreeAdapter,
  reachability: RepositoryReachability,
  instance: WorkspaceInstance,
  nowMs: number,
  correlationId: string | undefined,
): Promise<FactsAndHead | undefined> {
  try {
    return await gatherFacts(
      ctx,
      adapter,
      () => adapter.listWorktrees(),
      instance,
      nowMs,
      undefined,
    );
  } catch (error) {
    const classified = error instanceof TaskWorkspaceError ? error : repositoryUnreachable(error);
    // An unclassified failure of the adapter and filesystem reads can only mean the repository
    // itself could not be consulted, which is a fact about the whole GROUP: latch it, so the rows
    // after this one are carried forward without a second spawn and without a duplicate line.
    // A classified failure (IDENTITY_PROOF_FAILED) is a fact about this ROW and never latches.
    if (classified.code === "REPOSITORY_UNREACHABLE") reachability.markUnreachable();
    logWorkspaceLifecycleFailure(
      ctx.deps,
      { operation: "reconcile", workspaceIdentitySeed: instance.workspaceId, correlationId },
      classified,
    );
    return undefined;
  }
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
