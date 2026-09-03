// Restamping `lastVerifiedHead` after a commit KEIKO ITSELF executed inside a managed task
// workspace (issue #3382, Epic #443).
//
// `lastVerifiedHead` had exactly ONE production writer — `reconcileWithContext`, and only on a
// `healthy` outcome — while `classifyWorkspaceReconciliation` answers `drifted` + `head-moved` for
// any observed head that differs from it. Every commit therefore moved the worktree HEAD away from
// the recorded baseline, the very next pass persisted `head-moved`, and
// `productionRuntimeWorkspaceAuthority` refuses any row with a drift marker (and requires
// `instance.lastVerifiedHead === <live HEAD>` on top): the workspace could never start another run.
//
// A commit Keiko performed under its own governed mutation path is not drift — Keiko wrote that
// head. Recording it is bookkeeping, not a trust decision: this module persists ONE field, re-proves
// nothing it does not need to, and mutates neither Git nor the filesystem. A head Keiko did NOT
// write is untouched and still classifies as `head-moved`; the operator-approved `accept-moved-head`
// repair (repair.ts) is the exit for that case.
//
// It REUSES the existing engines and adds none: the row is resolved through the SAME managed-root
// lookup the access boundary composes (`resolveManagedTaskWorkspaceInstanceFromLookup`), the head is
// observed through the SAME repository consultation and porcelain entry match reconciliation
// classifies against (`observeManagedWorktreeHead`), and the write is audited through the SAME
// content-free lifecycle evidence + `task-workspace.lifecycle` activity line every other #445-#448
// operation emits.

import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { TASK_WORKSPACE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { correlationIdOrUnknown } from "../correlation.js";
import { logWorkspaceLifecycleFailure, recordWorkspaceLifecycle } from "./activity-log.js";
import { resolveManagedTaskWorkspaceInstanceFromLookup } from "./authorization.js";
import { TaskWorkspaceError } from "./errors.js";
import { buildWorkspaceEvent, WORKSPACE_LIFECYCLE_EVIDENCE_KIND } from "./evidence.js";
import { workspaceKey } from "./mutex.js";
import { observeManagedWorktreeHead } from "./reconciliation.js";
import type { RecordVerifiedHeadInput, WorkspaceProvisioningServiceDeps } from "./types.js";

type VerifiedHeadDeps = Pick<
  WorkspaceProvisioningServiceDeps,
  | "store"
  | "managedRoot"
  | "createAdapter"
  | "evidenceStore"
  | "redactString"
  | "now"
  | "newId"
  // The SAME shared in-process serializer every other mutating workspace flow holds (#449,
  // ADR-0093 D1). Already required on `WorkspaceProvisioningServiceDeps`, so the composition that
  // builds this port passes it unchanged.
  | "mutex"
  | "activityLog"
>;

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function resolveInstance(
  deps: VerifiedHeadDeps,
  managedWorktreePath: string,
): WorkspaceInstance | undefined {
  return resolveManagedTaskWorkspaceInstanceFromLookup(
    {
      managedRoot: deps.managedRoot,
      getInstance: (workspaceId): WorkspaceInstance | undefined => deps.store.getById(workspaceId),
    },
    managedWorktreePath,
  );
}

// One classified, body-free line per refused or failed restamp. A silent `return false` would leave
// the NEXT pass's `head-moved` with no explanation of why the head Keiko wrote was never recorded
// (AGENTS.md §7 no-silent-failures, §8 Rule 1).
function logFailure(
  deps: VerifiedHeadDeps,
  identitySeed: string,
  correlationId: string | undefined,
  error: TaskWorkspaceError,
): void {
  logWorkspaceLifecycleFailure(
    deps,
    { operation: "verify-head", workspaceIdentitySeed: identitySeed, correlationId },
    error,
  );
}

function emitRestamp(
  deps: VerifiedHeadDeps,
  instance: WorkspaceInstance,
  nowMs: number,
  startedAtMs: number,
  correlationId: string | undefined,
): void {
  recordWorkspaceLifecycle(deps, {
    evidenceStore: deps.evidenceStore,
    record: {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt: nowMs,
      operation: "verify-head",
      outcome: "reconciled",
      attempt: 1,
      durationMs: Math.max(0, nowMs - startedAtMs),
      // Exactly the one managed worktree whose head was recorded.
      worktreeCount: 1,
      event: buildWorkspaceEvent({
        eventId: deps.newId(),
        workspaceId: instance.workspaceId,
        taskId: instance.taskId,
        type: "health-changed",
        at: isoFrom(nowMs),
        correlationId: correlationIdOrUnknown(correlationId),
        fromState: instance.lifecycleState,
        toState: instance.lifecycleState,
        health: instance.health,
      }),
    },
    redactString: deps.redactString,
  });
}

// The head this restamp records, observed against the row as it stands INSIDE the critical section.
// Re-proving the path chain here (not just re-reading by id) keeps the write bound to the root the
// caller was admitted for: a concurrent re-materialization that moved `managedWorktreePath` must not
// have this call record the head of a different worktree onto the same row.
async function observeHeadForFreshRow(
  deps: VerifiedHeadDeps,
  input: RecordVerifiedHeadInput,
  expectedWorkspaceId: string,
): Promise<string> {
  const fresh = resolveInstance(deps, input.managedWorktreePath);
  if (fresh?.workspaceId !== expectedWorkspaceId) {
    throw new TaskWorkspaceError(
      "WORKSPACE_NOT_FOUND",
      "the managed workspace no longer resolves this root",
    );
  }
  const head = await observeManagedWorktreeHead(
    deps,
    fresh,
    correlationIdOrUnknown(input.correlationId),
  );
  if (head === undefined) {
    // The repository is reachable but lists no worktree at this path any more. That is a pointer
    // fact about the row, not a head Keiko may record, so the baseline stays untouched and the next
    // pass classifies it from live facts.
    throw new TaskWorkspaceError(
      "POINTER_DRIFT",
      "the repository lists no worktree entry for the managed workspace",
    );
  }
  return head;
}

// The whole critical section, under the workspace's own `ws:<workspaceId>` key.
//
// The row is re-read TWICE and the snapshot the caller admitted is never written back. Observing the
// head is a git spawn, so the previous version's `upsert({ ...instance, … })` replayed a snapshot
// captured before that await: it could resurrect a lock a concurrent repair had just taken, or undo
// lifecycle and drift state a concurrent reconcile had just persisted (CodeRabbit, PR #3381). The
// mutex closes the in-process race, and merging onto the row read immediately BEFORE the write keeps
// this a single-field update — `lastVerifiedHead` plus its timestamps — for any writer the mutex
// cannot serialize.
async function restampLocked(
  deps: VerifiedHeadDeps,
  input: RecordVerifiedHeadInput,
  expectedWorkspaceId: string,
  startedAtMs: number,
): Promise<boolean> {
  const head = await observeHeadForFreshRow(deps, input, expectedWorkspaceId);
  const current = deps.store.getById(expectedWorkspaceId);
  if (current === undefined) {
    throw new TaskWorkspaceError(
      "WORKSPACE_NOT_FOUND",
      "the managed workspace row was removed while its head was observed",
    );
  }
  const nowMs = deps.now();
  const iso = isoFrom(nowMs);
  const persisted = deps.store.upsert({
    ...current,
    lastVerifiedHead: head,
    lastVerifiedAt: iso,
    updatedAt: iso,
  });
  emitRestamp(deps, persisted, nowMs, startedAtMs, input.correlationId);
  return true;
}

/**
 * Records the managed worktree's CURRENT head as its verified head after Keiko's own governed commit.
 *
 * Returns whether a row was restamped. Best-effort by construction — the commit has already
 * happened, so a failure here must never turn a successful governed mutation into an error — but
 * NEVER silent: every refusal and every thrown failure leaves one classified `task-workspace.lifecycle`
 * line under the caller's correlation id.
 *
 * The admission lookup below runs OUTSIDE the lock and yields only the key to lock on; the
 * authoritative row is re-proved and re-read inside it (`restampLocked`). Only the git-delivery
 * commit path calls this, and that path holds no `ws:` key, so the acquisition cannot self-deadlock.
 */
export async function recordVerifiedManagedHead(
  deps: VerifiedHeadDeps,
  input: RecordVerifiedHeadInput,
): Promise<boolean> {
  const startedAtMs = deps.now();
  const instance = resolveInstance(deps, input.managedWorktreePath);
  if (instance === undefined) {
    logFailure(
      deps,
      input.managedWorktreePath,
      input.correlationId,
      new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "no managed workspace resolves this root"),
    );
    return false;
  }
  try {
    return await deps.mutex.runExclusive([workspaceKey(instance.workspaceId)], () =>
      restampLocked(deps, input, instance.workspaceId, startedAtMs),
    );
  } catch (error) {
    logFailure(
      deps,
      instance.workspaceId,
      input.correlationId,
      error instanceof TaskWorkspaceError
        ? error
        : new TaskWorkspaceError(
            "REPOSITORY_UNREACHABLE",
            "verified head could not be recorded",
            [],
            {
              cause: error,
            },
          ),
    );
    return false;
  }
}
