# ADR-0091: Task-Workspace Startup Reconciliation and Repair Semantics

## Status

Accepted

## Date

2026-06-26

## Version

1.0

## Context

Epic #443 introduces task-scoped isolated workspaces backed by Git worktrees.
ADR-0088 (#444) delivered the leaf-pure domain contract: 10-state lifecycle,
10 drift markers, 6 health states, lock model, recovery hints, content-free audit
events, the durable `WorkspaceInstance`, and the no-duplicate-subsystem delegation
table. ADR-0089 (#445) provisioned those workspaces: the narrow keiko-tools
`GIT_WORKTREE_COMMAND_RULES` worktree adapter, the `WorkspaceInstanceStore` over
the shared `node:sqlite` `DatabaseSync` handle (schema V7,
`task_workspace_instances`), and deterministic failure handling that always
leaves an instance in a named classified state. ADR-0090 (#446) added the
singleton active-workspace pointer (schema V8, `task_workspace_active_pointer`)
and the lifecycle service that retargets all eight surfaces atomically on switch.

**What does not yet exist is persistence durability in the operational sense.**
Between the contract (leaf types + transitions) and the provisioner (create /
activate), there is no system that re-establishes trust in persisted state after
a server restart, a partial failure mid-provisioning, an external filesystem
change (e.g., manual worktree deletion), a Git worktree drift (checked-out HEAD
moved by an external `git checkout`), or a stale lock from a crashed process.
Currently the only recovery path is explicit operator action. Issue #447 closes
this gap.

The governing forces for this slice are those from ADR-0088 plus three specific
stops:

- **AC1 — content-free invariant end-to-end.** Reconciliation results
  (status, drift markers, recovery hints, commit SHAs, branch names,
  `lastVerifiedAt`) are content-free: no source text, secrets, tokens, raw
  command output, or unbounded payload may appear in any persisted or BFF-surfaced
  reconciliation record.

- **AC2 — no silent disappearance.** A workspace whose worktree has drifted or
  gone missing must remain visible, classified `recovery-required`, and
  actionable — never silently deleted or demoted to an invisible error.

- **AC3 — authority must not be duplicated.** The reconciliation service must not
  re-implement path containment (keiko-workspace), worktree reading (the narrow
  adapter from #445), lock TTL (already encoded in the lock model), or any other
  subsystem already established by ADR-0088 D5.

- **AC4 — deterministic-first.** All classification and recovery-hint selection
  logic is pure (no IO) so it is testable in the contract layer without a
  filesystem.

- **AC5 — future consumers (UI, audit, cleanup, verification) read stored
  reconciliation state without inventing new semantics.** The semantics must live
  in the domain authority (`keiko-contracts`) so that issues #448–#450 and any
  later dashboard or cleanup engine consume the same vocabulary.

### What the existing slices already provide

The contract's `WorkspaceInstance` row already carries exactly the fields a
reconciler needs to persist its outcome: `health`, `driftMarkers`,
`recoveryHints`, `lastVerifiedAt`, and `lastVerifiedHead`. The evidence channel
(`WorkspaceEvent`) already has the event types `drift-detected`, `health-changed`,
and `recovery-flagged`. The lifecycle machine already includes the legal
transitions `active → recovery-required` and `paused → recovery-required`
(both carry no preconditions — detection is always permitted) and
`recovery-required → active|paused|failed|abandoned|cleanup-pending`.

What the existing slices do **not** provide:

1. A `listAll()` read method on the instance store (needed at startup to
   enumerate every known instance, not only those for one repository).
2. A named reconciliation status vocabulary (distinct from health states: health
   describes a point-in-time observation; reconciliation status describes the
   outcome of a structured classification pass).
3. A pure classifier that maps gathered IO facts to
   `{status, driftMarkers, recoveryHints}` with a documented precedence.
4. A pure active-workspace restoration decision given the pointer's target and
   the full reconciliation result set.
5. A controlled, operator-approval-gated repair action that reuses the #445
   provisioning path.
6. Three additive BFF routes (reconciliation read, reconciliation run, repair)
   and a best-effort server-bootstrap pass.

## Decision

**D1 — No new table. Reconciliation outcome is persisted on the existing V7 instance row.**

Reconciliation does not require a new store. The V7 `task_workspace_instances`
row already carries every field needed to persist a reconciliation result:
`health`, `driftMarkers`, `recoveryHints`, `lastVerifiedAt`, and
`lastVerifiedHead`. The reconciliation service UPDATES these fields on the
existing row after each classification pass. The V8 `task_workspace_active_pointer`
row carries `workspace_id`; restoration decisions update or clear it using the
existing `ActiveWorkspacePointerStore.set` / `.clear` path.

The only store addition is a new read method on `WorkspaceInstanceStore`:

```ts
readonly listAll: () => readonly WorkspaceInstance[];
```

`listAll` reads every row in `task_workspace_instances` with no `WHERE` clause.
It is used exclusively at startup (to enumerate all known instances regardless of
repository) and by the `GET /api/task-workspaces/reconciliation` BFF route (which
returns a stored-derived report). It must not be called on the hot path. The
instance count is bounded by the managed-root policy: only instances provisioned
by Keiko under the `<uiDbDir>/task-workspaces` root are ever inserted (ADR-0089
D2), so `listAll` reads a small, operator-bounded set.

**D2 — Reconciliation classification lives in the pure leaf contract (`keiko-contracts/task-workspace.ts`, contract version 0.9.0 → 0.10.0, additive).**

This decision follows the same pattern as ADR-0088 D2 (precondition table) and
ADR-0089 D7 (failure classification): behavioral contracts must be in the
authority package to be tested without IO and to give future slices (#448–#450)
a single import point (AC4, AC5). The additive extension to `task-workspace.ts`
introduces six pure exports:

**`WorkspaceReconciliationStatus` — 8-member closed union.**

```
healthy | missing | drifted | locked | partially-created
| stale-pointer | unmanaged-path | recovery-required
```

`WORKSPACE_RECONCILIATION_STATUSES` is a frozen array;
`isWorkspaceReconciliationStatus(x)` is the runtime guard.

The eight states are the complete vocabulary for Issue #447 acceptance criteria.
Each maps to an unambiguous action:

| Status | Meaning | Immediate action |
|---|---|---|
| `healthy` | Worktree present, contained, gitdir matches, HEAD matches stored `lastVerifiedHead`, branch exists, no stale lock | Restore if pointer target; record `lastVerifiedHead` |
| `missing` | Worktree path does not exist (external deletion) on an operational instance | Mark `recovery-required`, flag `worktree-missing` |
| `drifted` | Worktree present **and usable** but HEAD moved, branch deleted, uncommitted work, or a stale lock | Keep lifecycle, set health `drifted`, flag the marker + recovery hint (surface, do not force recovery) |
| `locked` | A live lock is held by another actor | Defer — leave the instance unchanged (no flag) |
| `partially-created` | Instance row is in `provisioning`/`failed` lifecycle — provisioning never completed | Leave for the provisioning retry path; flag `worktree-missing`/`pointer-stale` if the partial worktree is gone |
| `stale-pointer` | Worktree present but its `.git` pointer is missing/corrupt, its gitdir identity moved, its identity was registered under a retired rule (the inode-only rule or the pre-#3367 pointer-text rule), or its filesystem reports no durable creation time — for an operational instance, and for a `cleanup-pending` one whose tree is still present | Mark `recovery-required`, flag `pointer-stale`/`gitdir-mismatch`/`identity-schema-retired`/`identity-unsupported` |
| `unmanaged-path` | Stored `managedWorktreePath` resolves outside the Keiko-owned managed root (path-escape condition) | Mark `recovery-required`, flag `path-escape` |
| `recovery-required` | Instance is already in `recovery-required` lifecycle state — no fresh disk drift; carry-forward | Keep `recovery-required` |

**`WorkspaceReconciliationFacts` — the IO-gathered input to the pure classifier.**

A readonly plain object assembled by the server reconciliation service (IO). The
authoritative shape lives in `packages/keiko-contracts/src/task-workspace.ts` under
the `WorkspaceReconciliationFacts` interface; the fields below mirror it verbatim:

```ts
interface WorkspaceReconciliationFacts {
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  // realpath containment of the persisted managed-worktree path inside the managed
  // root — a persisted path is NEVER trusted without realpath verification.
  readonly pathContained: boolean;
  readonly worktreeDirExists: boolean;
  // the worktree's `.git` linked-worktree pointer file is present and well-formed.
  readonly gitPointerPresent: boolean;
  // the pointer's content-free gitdir identity equals the persisted `gitdirIdentity`.
  readonly gitdirIdentityMatches: boolean;
  // the persisted identity reproduces the RETIRED inode-only composition (#3376): a migration,
  // reported by its own marker, never as a replaced pointer.
  readonly gitdirIdentitySchemaRetired?: boolean;
  // the filesystem reports no durable creation time, so no current identity can be derived at
  // all; its own marker, never `pointer-stale` (the pointer IS present).
  readonly gitdirIdentityUnsupported?: boolean;
  // the dedicated task branch still exists / the worktree is still bound to it.
  readonly taskBranchPresent: boolean;
  // the worktree HEAD equals the persisted `lastVerifiedHead`
  // (true when no baseline was recorded).
  readonly headMatches: boolean;
  readonly uncommittedChanges: boolean;
  readonly lockPresent: boolean;
  readonly lockLive: boolean;
  readonly lockedByOtherActor: boolean;
}
```

All fields are content-free (booleans and the persisted lifecycle enum — no path,
no command output). The server assembles this struct from four distinct sources
WITHOUT duplicating any subsystem: `worktreeDirExists` from `node:fs` `existsSync`
against `managedWorktreePath`; `pathContained` from `keiko-workspace`
`assertManagedTargetContained` (delegated — ADR-0088 D5) — a distinct realpath
check that never trusts the existence probe as a substitute; `gitPointerPresent`,
`gitdirIdentityMatches`, `taskBranchPresent`, `headMatches`, and
`uncommittedChanges` from the narrow `listWorktrees` / `localBranchExists` /
status adapters already in `keiko-tools` (ADR-0089 D1); `lockPresent`, `lockLive`,
and `lockedByOtherActor` from the TTL/ownership rules already encoded in the lock
model.

**`classifyWorkspaceReconciliation(facts)` — pure, deterministic precedence chain.**

```ts
function classifyWorkspaceReconciliation(
  facts: WorkspaceReconciliationFacts,
): {
  readonly status: WorkspaceReconciliationStatus;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
}
```

The classifier applies checks in a strict top-down precedence order. The first
match wins; later checks are skipped. This makes the outcome deterministic and
the reasoning auditable. The order below matches the shipped
`classifyWorkspaceReconciliation` in `packages/keiko-contracts/src/task-workspace.ts`
verbatim (mnemonic: containment escape → live foreign lock → terminal lifecycle →
partial-creation → on-disk drift → lingering recovery-required → stale lock on an
otherwise-healthy workspace):

1. **`unmanaged-path`**: `!facts.pathContained` → status `unmanaged-path`, marker
   `path-escape`, hint `operator-repair` (`operatorActionRequired: true`). This is
   highest precedence because a contained path is a security invariant; the
   remaining checks assume containment.
2. **`locked`**: `facts.lockedByOtherActor` → status `locked`, no additional drift
   marker (the state itself is diagnostic; a *live* foreign lock is a wait
   condition, not a fault). The instance is left unchanged — reconciliation defers
   until the other actor releases the lock or its TTL expires and it is
   reclassified as a `stale` lock below.
3. **`healthy` (terminal lifecycle)**: `TERMINAL_LIFECYCLE_STATES` (`merged`,
   `archived`, `abandoned`, `cleanup-pending`) → status `healthy`, no markers. A
   missing worktree for a terminal lifecycle is expected (cleanup), so it is
   treated as settled rather than drifted. One exception precedes this step: a
   `cleanup-pending` worktree that is still present but no longer proves its
   identity (`cleanupPendingDrift`) is classified `stale-pointer` with the
   pointer/identity marker the facts name and flagged `recovery-required` (a
   legal, precondition-free transition). Reporting it settled left the row with
   no exit — the governed removal refuses an unproven tree as
   `ownership-unproven`, no repair applies to a `healthy` status, and the terminal
   branch of provisioning refuses to re-register it (2026-09-03 audit). The other
   terminal states never re-enter activity, so their disk state stays irrelevant.
4. **`partially-created`**: `PARTIAL_LIFECYCLE_STATES` (`provisioning`, `failed`)
   → status `partially-created`, with the partial-creation markers derived from
   what is actually gone on disk (a `stale-lock` marker is appended if
   `lockPresent && !lockLive`).
5. **On-disk drift** (`classifyOnDiskDrift`), in order:
   - `!worktreeDirExists` → status `missing`, marker `worktree-missing`, hint
     `recreate-worktree`. If additionally `!taskBranchPresent`, append marker
     `branch-deleted` and hint `reattach-branch` (`operatorActionRequired: true`).
   - `!gitPointerPresent` → status `stale-pointer`, marker `pointer-stale`, hint
     `operator-repair`; otherwise `!gitdirIdentityMatches` → status `stale-pointer` with the
     identity marker the facts name — `identity-unsupported` first, then
     `identity-schema-retired`, else `gitdir-mismatch` — and that marker's hint.
   - `!taskBranchPresent` → status `drifted`, marker `branch-deleted`, hint
     `reattach-branch` (`operatorActionRequired: true`).
   - `!headMatches` → status `drifted`, marker `head-moved`, hint `operator-repair`
     (`operatorActionRequired: true`).
   - `uncommittedChanges` → status `drifted`, marker `uncommitted-changes`, hint
     `commit-or-stash-required` (`operatorActionRequired: true`).
6. **`recovery-required`** (lingering-lifecycle): `facts.lifecycleState === "recovery-required"`
   and none of the above triggered → status `recovery-required` with empty
   markers/hints (only a `stale-lock` marker is appended if
   `lockPresent && !lockLive`). The classifier is pure and content-free, and
   the shipped `outcome("recovery-required", withStaleLock([], facts))` returns
   only what the CURRENT facts justify — it does NOT carry the persisted
   `driftMarkers`/`recoveryHints` forward. If the caller needs the persisted
   markers alongside a fresh recovery-required outcome (for a repair UI, for
   example), it must merge them itself outside this classifier.
7. **`drifted` (stale lock only)**: `facts.lockPresent && !facts.lockLive` on an
   otherwise-healthy workspace → status `drifted`, marker `lock-stale`, hint
   `release-stale-lock` (`operatorActionRequired: false`).
8. **`healthy`**: all checks passed → status `healthy`, empty markers and hints.

This precedence means a path-escape always surfaces before a missing-path report
(the path may technically "not exist" but the containment failure is the actionable
fact). A live foreign lock defers before any disk classification because the disk
may be mid-write on the other actor's side. A stale lock is *drift on an otherwise
healthy workspace* — not a lock condition — so it surfaces only after all other
classifications have been ruled out.

**`planWorkspaceRecoveryHints(driftMarkers)` — pure mapping of markers to strategies.**

A convenience pure function mapping each existing `TaskWorkspaceDriftMarker`
(ADR-0088 Entity 3) to the `WorkspaceRecoveryHint` the classifier would have
produced. This is the single authoritative mapping; `classifyWorkspaceReconciliation`
delegates to it internally. Future slices (#448, #449) that produce drift markers
via health probing use the same function rather than reimplementing the mapping.

```ts
function planWorkspaceRecoveryHints(
  driftMarkers: readonly TaskWorkspaceDriftMarker[],
): readonly WorkspaceRecoveryHint[];
```

The mapping (closed, derived from the ADR-0088 Entity 5 recovery strategy union):

| Drift marker | Strategy | `operatorActionRequired` |
|---|---|---|
| `worktree-missing` | `recreate-worktree` | `false` |
| `gitdir-mismatch` | `reconcile-pointer` | `false` |
| `head-moved` | `operator-repair` | `true` |
| `branch-deleted` | `reattach-branch` | `true` |
| `uncommitted-changes` | `commit-or-stash-required` | `true` |
| `lock-stale` | `release-stale-lock` | `false` |
| `path-escape` | `operator-repair` | `true` |
| `pointer-stale` | `operator-repair` | `true` |
| `identity-schema-retired` | `reconcile-pointer` | `false` |
| `identity-unsupported` | `operator-repair` | `true` |

Only `recreate-worktree`, `reconcile-pointer` (a moved-but-readable gitdir, or a
registration under the retired identity rule), and `release-stale-lock` are
executable by the repair service; a missing/corrupt `.git` pointer (`pointer-stale`),
a moved HEAD, a deleted branch, uncommitted work, and a filesystem without creation
times require an operator, because the narrow worktree adapter cannot repair them
without risking loss of the worktree's work. `operatorActionRequired: false` means the
strategy has an executable path, not that it runs unattended: every repair request
still carries `operatorApproved`, and reissuing a managed identity for an existing
worktree happens only on that approved path (#3376).

**`WorkspaceReconciliationEntry` and `WorkspaceReconciliationReport` — content-free result types.**

```ts
interface WorkspaceReconciliationEntry {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly reconciliationStatus: WorkspaceReconciliationStatus;
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly health: TaskWorkspaceHealth;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  readonly lastVerifiedAt: string;  // ISO timestamp
  readonly lastVerifiedHead: string | undefined;
}

interface WorkspaceReconciliationReport {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly reportId: string;            // opaque id supplied by caller
  readonly repoRoot: string;            // only to scope the report; no source content
  readonly generatedAt: string;         // ISO timestamp
  readonly totalInstances: number;
  readonly healthyCount: number;
  readonly recoveryRequiredCount: number;
  readonly entries: readonly WorkspaceReconciliationEntry[];
  readonly activeRestoration: WorkspaceActiveRestoration;
}
```

`validateWorkspaceReconciliationEntry` enforces the content-free closed-allowlist
invariant (`WORKSPACE_RECONCILIATION_ENTRY_ALLOWED_KEYS`) identical to
`validateWorkspaceInstance` (ADR-0088 D3): unknown keys are rejected with
`"unknown key not allowed (content-free): <key>"`. `validateWorkspaceReconciliationReport`
applies the same gate at the report level.

**`WorkspaceActiveRestoration` — the active-workspace restoration decision.**

A 4-variant closed union produced by the pure `resolveActiveRestoration` function:

```ts
type WorkspaceActiveRestoration =
  | { readonly decision: "restore"; readonly workspaceId: string }
  | { readonly decision: "flag-recovery"; readonly workspaceId: string; readonly reason: string }
  | { readonly decision: "ambiguous"; readonly reason: string }
  | { readonly decision: "none" };

function resolveActiveRestoration(
  pointerWorkspaceId: string | undefined,
  entries: readonly WorkspaceReconciliationEntry[],
): WorkspaceActiveRestoration;
```

The function is pure and has a crisp decision table:

| Condition | Decision |
|---|---|
| No active pointer (`pointerWorkspaceId === undefined`) and zero instances in `active` lifecycle | `none` |
| No active pointer and exactly one instance in `active` lifecycle (orphaned) | `flag-recovery` (the instance lost its pointer — mark it `recovery-required`) |
| No active pointer and ≥2 instances in `active` lifecycle | `ambiguous` (never silently choose) |
| Active pointer present, target entry `reconciliationStatus === "healthy"` | `restore` |
| Active pointer present, target entry status is anything other than `healthy` | `flag-recovery` (keep visible and classified; do not silently discard) |
| Active pointer present but no matching entry (target was externally deleted from DB) | `none` (pointer dangles; self-heal to unbound) |

The `ambiguous` case is a Stop Condition: if two or more instances are in `active`
lifecycle after a restart, the system cannot safely choose and must present the
operator with a flagged state. No silent choice is ever made.

**`KEIKO_CONTRACTS_VERSION` bumps `0.9.0` → `0.10.0`** (additive). All new exports
are added under an `Issue #447` block in `src/index.ts` and in the `"./task-workspace"`
subpath. This triggers the `arch:check:negative` exhaustiveness gate for any
consumer that switch-matches `KEIKO_CONTRACTS_VERSION`; reconciliation consumers
are additive (they import new types) and existing consumers are unaffected.

**D3 — The keiko-server reconciliation service is a thin IO layer.**

`packages/keiko-server/src/task-workspace/reconciliation.ts` exports
`createWorkspaceReconciliationService`. It does the IO that the pure classifier
cannot, calling existing subsystems in the correct delegation sequence:

```ts
interface WorkspaceReconciliationService {
  /** Run a live reconciliation pass for all known instances. Persists results. */
  readonly reconcile: (options?: { repoRoot?: string }) => Promise<WorkspaceReconciliationReport>;
  /** Return a stored-derived report from the last persisted reconciliation state. No IO except DB reads. */
  readonly getStoredReport: (repoRoot: string) => WorkspaceReconciliationReport;
}
```

Per-instance reconciliation sequence (the IO the service performs, in order):

1. Load instance from `WorkspaceInstanceStore.getById` (re-validates closed
   allowlist).
2. Check `worktreeDirExists` via `node:fs` `existsSync` on `managedWorktreePath`.
3. Check `pathContained` by calling `@oscharko-dev/keiko-workspace`
   `assertManagedTargetContained(managedRoot, managedWorktreePath)`. **NEVER trust
   a persisted path without realpath verification.** This is a security invariant
   (ADR-0088 D5 / ADR-0089 SC2): a manipulated or migrated path must be
   re-verified before any classification, evidence write, or repair.
4. Derive `gitPointerPresent`, `gitdirIdentityMatches`, `headMatches`,
   `taskBranchPresent`, and `uncommittedChanges` via the **existing** keiko-tools
   worktree adapter's `listWorktrees()` + `localBranchExists()` + status probes
   (ADR-0089 D1). No second git engine.
5. Derive `lockPresent`, `lockLive`, and `lockedByOtherActor` from
   `instance.lock`, `expiresAt` vs `nowIso`, and the persisted lock owner.
6. Call `classifyWorkspaceReconciliation(facts)` (pure, no IO).
7. Compute the legal `lifecycleState` transition via
   `reconciliationRequiresRecoveryFlag(status, lifecycleState)`: it returns `true`
   only when the current lifecycle state is `active`, `paused`, or `handoff-ready`
   AND the classification status is one of `missing`, `stale-pointer`, or
   `unmanaged-path` — the "worktree gone or structurally unusable" set. `locked`
   is a wait condition and never triggers a transition; `drifted` and
   `partially-created` are surfaced via health + drift markers + hints without
   forcing the workspace out of its lifecycle (crisp classification over
   aggressive auto-healing). When the flag is `true`, transition to
   `recovery-required` (legal per ADR-0088 transition table — no preconditions
   required). If the status is `healthy` and the current state was
   `recovery-required`, it stays `recovery-required` (automatic promotion to
   `active` is NOT performed — restoration is a controlled `setActive` call, not a
   background side-effect).
8. Persist the updated `WorkspaceInstance` via `WorkspaceInstanceStore.upsert`,
   gated by `validateWorkspaceInstance` (content-free closed-allowlist).
9. Append a content-free `WorkspaceEvent` of type `drift-detected` or
   `health-changed` via `appendWorkspaceLifecycleEvidence`.

After all instances are classified, call `resolveActiveRestoration` (pure) and
execute its decision:

- `restore`: call `ActiveWorkspacePointerStore.set(workspaceId)` (re-set the
  pointer to the healthy target).
- `flag-recovery`: update the target instance to `recovery-required` via the store
  + clear the pointer via `ActiveWorkspacePointerStore.clear()`. The workspace
  remains visible with its classified drift markers (AC2 — no silent disappearance).
- `ambiguous`: clear the pointer; append a `recovery-flagged` event noting the
  count. All ambiguous instances remain in their current lifecycle states with their
  drift markers — the operator must choose.
- `none`: clear the pointer (dangling or no prior pointer). Idempotent.

The active pointer is a SINGLETON across every repository, but `reconcile(root)`
reports only ONE repository's rows, so the pointer is never judged against the
scoped entry list alone: a pointer the list does not carry is resolved against the
GLOBAL instance store and only counted dangling when its workspace exists in no
repository at all. Reporting it dangling from a scoped list — and, on the live path,
clearing it — deleted a valid pointer held on another repository whenever a bind was
attempted elsewhere (corrected 2026-09-03).

**Concurrency guarantee (KEIKO-0996, #3339).** Step 8's per-instance re-read,
fact-gathering, classification, and persisted write (`WorkspaceInstanceStore.upsert`
inside `reconcileWithContext`, called from the live `reconcile()` path) run as ONE
critical section serialized under the SAME `ws:<workspaceId>` key every other
mutating workspace flow uses (ADR-0093 D1): `reconcileImpl` wraps the re-read +
`gatherFacts` + `reconcileWithContext` sequence in
`ctx.deps.mutex.runExclusive([workspaceKey(instance.workspaceId)], ...)`, mirroring
`repair.ts`'s "advisory check → live reconcile → lock acquire → strategy mutation"
and `cleanup.ts`'s "re-check persisted liveness inside the critical section". This
was originally a documented gap — ADR-0091 was silent on reconciliation's
concurrency semantics, and reconciliation's write did not take the shared mutex the
way `WorkspaceCleanupServiceDeps` (also mutating) already did. Widening the lock to
cover fact-gathering (not just the write) matters: once the lock is held, the
callback re-reads `store.getById(workspaceId)` and classifies from THAT record, so
a concurrent `activate`/`pause`/`repair`/`cleanup` that mutated or deleted the
workspace while this reconcile pass awaited the lock is observed rather than
clobbered; when the fresh read comes back `undefined` (the workspace was deleted,
e.g. by `completeCleanupImpl`), this pass skips it instead of resurrecting a
deleted row via a stale-instance `upsert`. An operator-triggered
`POST /api/task-workspaces/reconciliation` racing the startup bootstrap
reconciliation pass (`reconcileTaskWorkspacesAtStartup`), or racing an
already-in-flight `activate`/`pause`/`repair`/`cleanup` of the same workspace, can
no longer land its write inside another flow's critical section for that
workspace, nor can it write a persisted row that flow has since deleted or
retargeted. `reconcileSingleInstance` (used by #447 repair and internal callers)
stays unlocked because its callers (e.g. `repair.ts`) already hold the same
`ws:<workspaceId>` key for their whole operation before re-entering it — wrapping
it there again would self-deadlock.

**Worktree-list freshness (PR #3348 review finding, same lock).** The re-read above
closed the TOCTOU for the persisted store row, but a PR #3348 review pass on this
change caught that the SAME class of gap still existed one layer down: the git
worktree list `gatherFacts` classifies `observedHead`/`headMatches` against was, in
the first version of this fix, still fetched ONCE per repository BEFORE any
instance in that repository's group attempted its `ws:<workspaceId>` lock — a
pre-lock snapshot reused across every instance in the group regardless of how long
each one waited for its own key. A concurrent repair/cleanup that changed the
worktree while a later instance's reconcile was queued behind that exact key could
therefore still classify against pre-mutation git state, persisting a false
missing/mismatched-worktree outcome immediately after the concurrent mutation
completed. The fix: `gatherFacts` now accepts either an eager array (every caller
that fetches it immediately before use, with no intervening await —
`gatherInstanceReconciliationFacts`, `reconcileSingleInstance`) or a lazy
`() => adapter.listWorktrees()` factory, and the live batch `reconcile()` path
passes the lazy form, invoked only once this instance's lock is held AND only when
its worktree still exists on disk (`worktreeDirExists` is itself always freshly
observed via `existsSync`, never stale). This keeps the documented common case — a
backlog of paused instances whose worktree is already gone — at ZERO
`listWorktrees` spawns, and costs exactly one FRESH spawn per instance whose
worktree does exist, which D4 below bounds to single digits per repository at the
realistic operating scale, not the N=200 backlog scale the `#449` scale test seeds.

Deadlock re-analysis for the widened section: holding `ws:<workspaceId>` across a
git subprocess call (`adapter.localBranchExists` inside `gatherFacts`) for every
instance is not a new risk — `repair.ts` already holds the same key across an
equivalent `gatherFacts` call (via `reconcileSingleInstance`) for its entire
operation, so this section is no more exclusion-heavy than an existing one at the
same key tier. No caller invokes the batch `reconcile()` while already holding a
`ws:` key — only two call sites invoke it at all, `deps.ts`'s startup wiring and
the `POST /api/task-workspaces/reconciliation` route handler, neither of which
holds any mutex key first — so widening the hold cannot create a hold-and-wait
cycle against `repair`/`cleanup`/`activate`/`pause`, which take at most the single
`ws:` tier (or `ws:` plus a strictly-lower tier, per the canonical acquisition
order in `mutex.ts`) and never call back into `reconcile()`.

**D4 — Active-workspace restoration on startup is conservative.**

Conservative means: classify first, restore only if clean. The reconciliation
service does not auto-promote `recovery-required` → `active`. It does not
automatically recreate a missing worktree. It does not automatically resolve
ambiguous active instances. These are all operator-approval-gated repair actions
(D5). An EXPLICIT operator activation of a `recovery-required` workspace is a
different thing: the provisioning service admits it (since 2026-09-03; it used to
answer `ILLEGAL_TRANSITION` while the switcher, reading the ADR-0088 transition
table, offered the action) and re-proves the persisted path, the worktree's
presence and its managed identity live before the row becomes `active`, dropping
only the markers those proofs refuted. A row whose drift persists still refuses
through the same proofs. The conservative posture reflects two principles from
ADR-0088:

- `recovery-required → active` requires `lock-held-by-actor` and `path-contained`
  preconditions (ADR-0088 D2 transition table). Those preconditions cannot be
  satisfied by a background startup pass without operator intent.
- The `operator-approval` precondition on all destructive transitions is a
  product-level safety commitment; it cannot be waived by a startup routine.

Startup reconciliation runs as a **best-effort pass** after the DB and stores are
open but before route registration completes, mirroring the QI-retention startup
pass (ADR-0048). It uses `reconciliationService.reconcile()` wrapped in
`try/catch`: any error is logged (content-free: error code + workspace IDs only,
no stack trace with paths or source content) and swallowed. Bootstrap never throws
from this pass. Inside the pass, a failure to GATHER a row's live facts is
isolated to the row or repository it belongs to: a repository the worktree
adapter cannot consult at all (a vanished root, a denied path, a spawn failure)
is logged once as the retryable `REPOSITORY_UNREACHABLE` with its frames and
cause chain, its rows are carried forward unverified (health `unknown`, nothing
persisted), and the pass continues with every other repository — the health
report applies the same rule. Once per repository is literal: the first failure of
a REPOSITORY-WIDE operation latches that repository for the remainder of the
pass, so twenty rows of a vanished root produce one line and one `git` spawn, not
twenty of each. Fact-gathering asks exactly two such questions — the adapter build
and `listWorktrees` — and each classifies its own failure as
`REPOSITORY_UNREACHABLE` at its call site; nothing else may set the latch. Latching
on the CLASSIFICATION instead (any unclassified gathering failure, the shape before
2026-09-03) let a ROW-LOCAL rejection suppress the repository: the durable validator
accepts any non-empty `taskBranch` while the production adapter rejects one that is
not a safe ref name, so a single malformed row skipped every healthy row behind it
in the deterministic enumeration order, indefinitely. A row-local failure is logged
and carried forward for that row alone. A CLASSIFIED failure (`IDENTITY_PROOF_FAILED`)
is likewise a fact about one
worktree and never latches, and a SUCCESSFUL worktree listing is never memoized —
the freshness rule above requires each row to classify against the list observed
after its own `ws:<workspaceId>` lock. `reconcileSingleInstance`, which every
operator-approved repair re-enters, classifies its own adapter build and worktree
listing under the same code, so a repair attempted while the repository root is
unavailable is a logged, retryable refusal rather than an unclassified 500. Only
the gathering is isolated: a failure to
persist or evidence a verdict is not a fact about the repository, is never
relabelled as one, and propagates under its own name. Before 2026-09-03 a
gathering failure escaped the per-instance boundary and silently aborted the
pass for every repository after the failing one.

**D5 — Repair is a controlled, operator-approval-gated server action that reuses, never duplicates.**

`packages/keiko-server/src/task-workspace/repair.ts` exports
`createWorkspaceRepairService`:

```ts
interface WorkspaceRepairRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly strategy: WorkspaceRecoveryStrategy;
  readonly operatorApproved: boolean;
}

interface WorkspaceRepairResult {
  readonly workspaceId: string;
  readonly strategy: WorkspaceRecoveryStrategy;
  readonly outcome: "repaired" | "operator-required" | "no-op";
  readonly instance: WorkspaceInstance;
}

interface WorkspaceRepairService {
  readonly repair: (request: WorkspaceRepairRequest) => Promise<WorkspaceRepairResult>;
}
```

Each strategy maps to exactly one action, using only existing subsystems:

| Strategy | Action | Reuse |
|---|---|---|
| `recreate-worktree` | Call `WorkspaceProvisioningService.provision()` re-materialization path (ADR-0089 D7: handles `provisioning`/`failed`/`recovery-required`, prunes the stale worktree admin entry, rebuilds the missing worktree via the adapter, rolls back partial state, emits evidence) | #445 provisioning |
| `reconcile-pointer` | Re-run the `WorkspaceProvisioningService.provision()` path with `operatorApprovedRepair: true`: it resume-completes the still-present worktree and recomputes the content-free `gitdirIdentity` from the live `.git` pointer, refreshing a moved-but-readable gitdir or reissuing a proof registered under the retired identity rule. Applies to `gitdir-mismatch` and `identity-schema-retired` (a missing/corrupt pointer is `operator-repair`); without the approval flag the provisioning path refuses to reissue an identity for an existing worktree (#3376). | #445 provisioning |
| `reattach-branch` | Return `outcome: "operator-required"` with no mutation (recreating a deleted branch is a Git delivery operation — ADR-0080; the operator must act via the #470 surface, not via a workspace repair route) | None (no mutation) |
| `release-stale-lock` | `WorkspaceInstanceStore.upsert` clearing `lock: null`, then re-reconcile so the classification drops the `lock-stale` marker | #445 store |
| `commit-or-stash-required` | Return `outcome: "operator-required"` with no mutation (uncommitted-changes disposition is a Git delivery decision — ADR-0084; the operator must act via the #470 surface) | None (no mutation) |
| `operator-repair` | Return `outcome: "operator-required"` with no mutation | None (no mutation) |
| `abandon-and-cleanup` | Transition instance to `abandoned` (legal only from `paused`/`handoff-ready`/`recovery-required`/`failed`/`cleanup-pending`, requires `operator-approval`; an `active`/`provisioning` source is refused as `REPAIR_NOT_APPLICABLE`); actual worktree cleanup deferred to #448 (governed cleanup controls) | #445 store transition |

`repair` is classified `mutating-server-action` with `requiresLock: true` and
`requiresOperatorApproval: true` in the ADR-0088 D4 operation authority table.
Every repair invocation acquires the workspace lock first (using the existing
`WorkspaceInstanceStore` lock acquire path) and releases it on completion or
error. Every repair — including `operator-required` outcomes — appends a
content-free `WorkspaceEvent` of type `repaired` or `recovery-flagged` via
`appendWorkspaceLifecycleEvidence`. No repair strategy introduces a new git
engine, a new containment engine, or a new terminal spawn boundary.

**D6 — Three additive BFF routes (CSRF posture inherited from the existing route table).**

All three handlers are added to `packages/keiko-server/src/task-workspace/routes.ts`
and registered in `packages/keiko-server/src/routes.ts`. They reuse
`runHandler`, `redacted`, `mapError`, `readJsonObject`, `boundedString`,
`resolveRoot`, and `TaskWorkspaceError` already in that file.

| Method | URL pattern | Mutation | Request | 200 body |
|---|---|---|---|---|
| `GET` | `/api/task-workspaces/reconciliation?root=<repoRoot>` | None (read-only) | `root` query param | `{ report: WorkspaceReconciliationReport }` — derived from stored instance rows; no live filesystem IO |
| `POST` | `/api/task-workspaces/reconciliation` | Writes to instance rows + evidence | `{ root: string }` body | `{ report: WorkspaceReconciliationReport }` — live reconcile pass; persists results |
| `POST` | `/api/task-workspaces/:workspaceId/repair` | Writes to instance rows + evidence | `{ requestedBy: string; strategy: WorkspaceRecoveryStrategy; operatorApproved: boolean }` | `{ result: WorkspaceRepairResult }` |

The `GET` reconciliation route is read-only (no CSRF required by the existing
gate posture). The `POST` reconciliation and `POST` repair routes are
state-changing and inherit the server's global CSRF gate (same as the existing
`POST /api/task-workspaces`, `POST /api/task-workspaces/active`, and the
#445/#446 mutation routes).

Route registration order in `routes.ts` (literals before params, consistent with
ADR-0090 D6 ordering):

```
GET  /api/task-workspaces/reconciliation       (before :workspaceId)
POST /api/task-workspaces/reconciliation
POST /api/task-workspaces/:workspaceId/repair
... existing #445 / #446 routes ...
```

All responses pass through `deps.redactor` (content-free invariant at the BFF
boundary). `WorkspaceReconciliationReport.repoRoot` is passed through `deps.redactor`
before returning to the browser.

### Reuse map

| Item reused | Source | Reuse point |
|---|---|---|
| `WorkspaceInstance` row fields (`health`, `driftMarkers`, `recoveryHints`, `lastVerifiedAt`, `lastVerifiedHead`) | ADR-0088 Entity 8 | Reconciliation writes to existing columns — no new columns |
| `WorkspaceEvent` types (`drift-detected`, `health-changed`, `recovery-flagged`, `repaired`) | ADR-0088 D3 (17-member closed union) | Reconciliation and repair evidence |
| `validateWorkspaceInstance` closed-allowlist gate | ADR-0088 D3 | Every store write after reconciliation re-validates |
| `TaskWorkspaceDriftMarker` 8-member union | ADR-0088 Entity 3 | `WorkspaceReconciliationFacts.driftMarkers` + `planWorkspaceRecoveryHints` mapping |
| `WorkspaceRecoveryStrategy` 7-member union | ADR-0088 Entity 5 | `WorkspaceRepairRequest.strategy` + per-strategy repair dispatch |
| `WorkspaceRecoveryHint` type | ADR-0088 Entity 5 | `classifyWorkspaceReconciliation` return type |
| `legal transition active|paused → recovery-required` (no preconditions) | ADR-0088 D2 transition table | Classification step 8 (D3 above) — no new transition semantics |
| `repair` operation (`requiresLock: true`, `requiresOperatorApproval: true`) | ADR-0088 D4 operation authority table | Repair service enforces the same gate |
| `appendWorkspaceLifecycleEvidence` + `buildWorkspaceEvent` | ADR-0089 D6 | All reconciliation and repair outcomes write evidence via the same path |
| `WorkspaceInstanceStore.upsert` + re-validate-on-read | ADR-0089 D4 | Reconciliation outcome persist |
| `WorkspaceProvisioningService.provision()` re-materialization path | ADR-0089 D7 | `recreate-worktree` repair strategy |
| `assertManagedTargetContained` (keiko-workspace) | ADR-0089 D2 | `pathContained` fact gathering (realpath — never trust persisted path) |
| `listWorktrees` / `localBranchExists` (keiko-tools narrow adapter, `GIT_WORKTREE_COMMAND_RULES`) | ADR-0089 D1 | `gitPointerPresent`, `gitdirIdentityMatches`, `headMatches`, `taskBranchPresent`, `uncommittedChanges` fact gathering |
| `ActiveWorkspacePointerStore.get` / `.set` / `.clear` | ADR-0090 D1 | Restoration decisions and repair `reconcile-pointer` |
| `buildBinding(instance)` (exported from #446) | ADR-0090 D2 | `WorkspaceReconciliationReport.entries` derive binding if needed by callers |
| Validator result shape `{ ok: true } \| { ok: false; reasons: string[] }` | `git-repository.ts` | `validateWorkspaceReconciliationEntry`, `validateWorkspaceReconciliationReport` |
| Content-free closed-allowlist unknown-key rejection | ADR-0088 D3 | `WORKSPACE_RECONCILIATION_ENTRY_ALLOWED_KEYS` |
| Best-effort startup pass pattern | ADR-0048 (QI-retention startup pass) | Bootstrap reconciliation: `try/catch`, never throws into bootstrap |
| `runHandler` / `redacted` / `mapError` / `resolveRoot` BFF utilities | ADR-0089 D5 / ADR-0090 D6 | All three new route handlers |

## Consequences

### Positive

- Worktrees are trustworthy after restarts. Persisted state is re-verified against
  the filesystem and the git ref log before any surface consumes it; stale metadata
  cannot silently drive the UI to a non-existent root.
- The content-free invariant is preserved end-to-end across the new reconciliation
  types: `classifyWorkspaceReconciliation` input and output are hashes, booleans,
  enums, and ISO timestamps; the report carries no source text, no command output,
  no credentials.
- Future slices (#448 health/drift, #449 hardening, #450 verification) import the
  same `WorkspaceReconciliationStatus` and `planWorkspaceRecoveryHints` vocabulary
  without discovering or inventing their own (AC5).
- Every repair strategy either reuses an existing path (#445 provisioning, #445
  store, #446 pointer store) or explicitly returns `operator-required` —
  the set of things a repair can change is closed and auditable.
- No new table, no new store, no new git engine. The system footprint is smaller
  than the feature it delivers.

### Negative

- `KEIKO_CONTRACTS_VERSION` bumps to `0.10.0`. Consumers that
  exhaustiveness-switch on the version must add a case. The `arch:check:negative`
  gate will catch any consumer that does not — this is a feature of the gate, not
  a bug, but it requires a coordinated update.
- The 8-member `WorkspaceReconciliationStatus` union is a new vocabulary on top of
  the existing 6-member `TaskWorkspaceHealth` union. Developers must understand
  the distinction: health is a point-in-time observation (can be read without a
  reconciliation pass); reconciliation status is the structured output of a
  classification pass with explicit precedence. The distinction is necessary
  (health is used by #448 drift detection independently) but is an additional
  concept to internalize.
- `listAll()` reads every row with no `WHERE`. If the operator provisions hundreds
  of workspaces across many repositories, the startup pass reads all of them.
  This is bounded by the managed-root policy (all rows were Keiko-provisioned) and
  is a single sequential read at startup, but implementors of the bootstrap pass
  must not call `listAll()` on any hot path.
- The conservative restoration posture means a user whose workspace was healthy but
  whose server crashed mid-operation will not automatically return to `active` on
  restart — they must explicitly `setActive`. This is safer than silent promotion
  but adds one user step.

### Neutral

- `reattach-branch`, `commit-or-stash-required`, and `operator-repair` strategies
  return `outcome: "operator-required"` with no mutation. This means repair
  is not a universal cure — three of the seven strategies explicitly require
  operator action via a different surface. The repair route returning a result
  rather than throwing is the correct boundary: the caller (UI or CLI) decides how
  to surface the `operator-required` outcome.
- The `abandon-and-cleanup` strategy transitions to `abandoned` but defers physical
  worktree cleanup to #448. This leaves the `managedWorktreePath` on disk until
  the cleanup controls (#448) remove it. The instance is clearly in `abandoned`
  state, so there is no ambiguity about its intended final disposition.
- Bootstrap reconciliation is best-effort and swallows errors. This is a conscious
  choice: a startup reconciliation failure must not prevent Keiko from starting.
  Operators can trigger a live reconciliation via `POST /api/task-workspaces/reconciliation`
  after startup.

## Alternatives Considered

### Alternative 1: New reconciliation store table (separate from `task_workspace_instances`)

- **Pros**: reconciliation history would be queryable; the instance row would not
  need to carry `lastVerifiedAt` / `lastVerifiedHead`.
- **Cons**: The instance row already carries every needed field (ADR-0088 Entity 8
  specified them anticipating this use). A second table would require a V9
  migration, a new store interface, a new join, and a second validated write per
  reconciliation pass — tripling the write surface for no additional semantic
  coverage. It would also create two competing sources of truth for the health and
  drift state of an instance.
- **Why rejected**: the existing fields are the single source of truth. A separate
  table would be premature abstraction: three distinct audit-history use cases would
  need to exist before the extraction is justified (ADR hard rule: no premature
  abstraction).

### Alternative 2: Place `classifyWorkspaceReconciliation` in `keiko-server` rather than `keiko-contracts`

- **Pros**: avoids bumping `KEIKO_CONTRACTS_VERSION`; keeps the classifier close
  to the IO that feeds it.
- **Cons**: the classifier is pure — it takes a plain struct and returns a struct,
  no IO. ADR-0088 established the pattern that behavioral contracts (precondition
  table, recovery strategy mapping) live in the authority package so they are (a)
  dependency-free, (b) testable without a server, and (c) available to any
  consumer without pulling in server dependencies. Moving the classifier to the
  server means #448–#450 must either import `keiko-server` (a layer violation per
  ADR-0019) or re-implement the mapping (a duplication violation).
- **Why rejected**: AC4 and AC5 are hard requirements. The leaf-package pattern
  established by ADR-0088 is the correct home; the version bump is the price and
  the gate exists precisely to catch consumers that miss it.

### Alternative 3: Auto-promote healthy `recovery-required` workspaces to `active` on startup

- **Pros**: zero user steps to restore context after a clean restart.
- **Cons**: `recovery-required → active` requires `lock-held-by-actor` and
  `path-contained` preconditions (ADR-0088 D2). A background startup pass cannot
  acquire a lock on behalf of the operator without an explicit request. More
  fundamentally, the `operator-approval` posture of the lifecycle means the system
  never makes unilateral decisions that change what surfaces are active — this
  commitment exists at the architecture level, not just the API level.
- **Why rejected**: violates the ADR-0088 transition precondition table and the
  product-level `operator-approval` safety commitment. Conservative restoration
  (restore only if healthy, flag otherwise) is the correct posture for a
  single-operator Studio where the operator must understand what workspace is
  active.

### Alternative 4: Eager repair at reconciliation time (automatically recreate missing worktrees)

- **Pros**: the system self-heals without operator involvement; a crashed worktree
  would reappear transparently.
- **Cons**: `recreate-worktree` calls `WorkspaceProvisioningService.provision()`,
  which acquires a lock, creates a worktree, and emits evidence. Running this
  eagerly at startup for every missing workspace could take seconds per workspace
  and fail in unexpected ways (e.g., the base branch was deleted — `branch-deleted`
  is a separate drift marker for exactly this reason). A startup pass that blocks
  on IO for every workspace undermines the best-effort posture. More importantly,
  the operator may not want to recreate a workspace that is missing — they may
  prefer to abandon it.
- **Why rejected**: the repair decision must be operator-gated. Eager repair at
  reconciliation time conflates observation with action. The two-step model
  (reconcile → explicit repair) is safer and reversible: a reconciliation pass is
  always safe to run; a repair has side effects and must be explicitly requested.

### Alternative 5: Re-implement path containment and worktree reading inline in the reconciliation service

- **Pros**: the reconciliation service would be self-contained with no external
  dependencies.
- **Cons**: this is the exact duplication that ADR-0088 D5 and ADR-0089 D2 are
  designed to prevent. `@oscharko-dev/keiko-workspace` is the authoritative
  containment engine; a second implementation would diverge on symlink-traversal
  edge cases. The narrow keiko-tools adapter is the authoritative Git worktree
  reader; a second adapter would widen the terminal spawn surface beyond
  `GIT_WORKTREE_COMMAND_RULES` (SC1 violation) and introduce a second instance of
  the adapter's argv-validation logic.
- **Why rejected**: the no-duplicate-subsystem rule (ADR-0088 AC4) is a hard stop.
  Delegation via established APIs is the entire point of the boundary table.

## Related

- Issue [#443](https://github.com/oscharko-dev/Keiko/issues/443) — parent epic: governed isolated task workspaces
- Issue [#447](https://github.com/oscharko-dev/Keiko/issues/447) — this ADR's implementing issue
- Issue [#444](https://github.com/oscharko-dev/Keiko/issues/444) — domain contract gate (ADR-0088); provides the types, drift markers, recovery strategies, operation authority, and evidence event shape this ADR extends
- Issue [#445](https://github.com/oscharko-dev/Keiko/issues/445) — managed worktree provisioning (ADR-0089); provides the store, provisioning service, worktree adapter, and evidence infrastructure this ADR reuses
- Issue [#446](https://github.com/oscharko-dev/Keiko/issues/446) — active-workspace binding and surface retargeting (ADR-0090); provides the active pointer store and `buildBinding` this ADR uses for restoration decisions
- Issue [#448](https://github.com/oscharko-dev/Keiko/issues/448) — workspace health, drift detection, audit trail, governed cleanup controls; consumes `WorkspaceReconciliationStatus`, `planWorkspaceRecoveryHints`, and the stored reconciliation state this ADR establishes
- Issue [#449](https://github.com/oscharko-dev/Keiko/issues/449) — security, concurrency, failure-recovery hardening; consumes D3 (reconciliation service) and D5 (repair service) boundaries
- Issue [#450](https://github.com/oscharko-dev/Keiko/issues/450) — verification matrix and operating runbooks; consumes all decisions
- [ADR-0088](ADR-0088-task-workspace-domain-contract.md) — leaf-pure domain contract; 10-state lifecycle, drift markers, recovery strategies, content-free event shape, operation authority table (all reused)
- [ADR-0089](ADR-0089-managed-task-worktree-provisioning.md) — managed worktree provisioning; `WorkspaceInstanceStore`, provisioning service, worktree adapter, evidence infrastructure (all reused in D3 and D5)
- [ADR-0090](ADR-0090-active-task-workspace-binding-and-surface-retargeting.md) — active-workspace binding and lifecycle service; `ActiveWorkspacePointerStore`, `buildBinding` (both reused in D3 and D5)
- [ADR-0019](ADR-0019-modular-package-architecture.md) — leaf-package rule and dependency direction (enforces classifier placement in `keiko-contracts`)
- [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md) — QI-retention startup pass pattern (best-effort, never throws into bootstrap); content-free evidence posture
- ADR-0013 — SQLite schema + `PRAGMA user_version` migration runner (no new migration needed; D1 confirms no new table)
- [ADR-0080](ADR-0080-governed-git-delivery-contracts.md)–[ADR-0087](ADR-0087-governed-merge-gateway.md) — governed Git delivery surface; `reattach-branch` and `commit-or-stash-required` repair strategies explicitly defer to this surface, never duplicate it
