# ADR-0091: Task-Workspace Startup Reconciliation and Repair Semantics

## Status

Proposed

## Date

2026-06-26

## Version

1.0

## Context

Epic #443 introduces task-scoped isolated workspaces backed by Git worktrees.
ADR-0088 (#444) delivered the leaf-pure domain contract: 10-state lifecycle,
8 drift markers, 6 health states, lock model, recovery hints, content-free audit
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
| `stale-pointer` | Worktree present but its `.git` pointer is missing/corrupt or its gitdir identity moved | Mark `recovery-required`, flag `pointer-stale`/`gitdir-mismatch` |
| `unmanaged-path` | Stored `managedWorktreePath` resolves outside the Keiko-owned managed root (path-escape condition) | Mark `recovery-required`, flag `path-escape` |
| `recovery-required` | Instance is already in `recovery-required` lifecycle state — no fresh disk drift; carry-forward | Keep `recovery-required` |

**`WorkspaceReconciliationFacts` — the IO-gathered input to the pure classifier.**

A readonly plain object assembled by the server reconciliation service (IO):

```ts
interface WorkspaceReconciliationFacts {
  readonly workspaceId: string;
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly managedWorktreePath: string;
  readonly gitdirIdentity: string;        // stored identity hash
  readonly lastVerifiedHead: string | undefined;
  readonly lock: WorkspaceLock | null;
  readonly nowIso: string;                // ISO timestamp for TTL evaluation
  // Server-gathered IO facts (booleans derived from filesystem/git):
  readonly pathExists: boolean;
  readonly pathContained: boolean;        // realpath check via keiko-workspace
  readonly gitdirMatches: boolean;        // .git pointer identity == stored gitdirIdentity
  readonly currentHead: string | undefined;  // current HEAD SHA from worktree adapter
  readonly branchExists: boolean;         // task branch still present in refs
  readonly lockExpired: boolean;          // lock !== null && expiresAt < nowIso
  readonly isActivePointerTarget: boolean; // pointer's workspace_id === this workspaceId
}
```

All fields are content-free (hashes, booleans, ISO timestamps, enums, opaque IDs).
The server assembles this struct from four distinct sources WITHOUT duplicating any
subsystem: `pathExists` and `pathContained` from `keiko-workspace`
`assertManagedTargetContained` (delegated — ADR-0088 D5); `gitdirMatches`,
`currentHead`, and `branchExists` from the narrow `listWorktrees` /
`localBranchExists` adapter already in `keiko-tools` (ADR-0089 D1); `lockExpired`
from the TTL rule already encoded in the lock model; `isActivePointerTarget` from
the active pointer store (ADR-0090 D1).

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
the reasoning auditable:

1. **`unmanaged-path`**: `!facts.pathContained` → status `unmanaged-path`, marker
   `path-escape`, hint `operator-repair` (`operatorActionRequired: true`). This is
   highest precedence because a contained path is a security invariant; the
   remaining checks assume containment.
2. **`missing`**: `!facts.pathExists` → status `missing`, marker `worktree-missing`,
   hint `recreate-worktree` (`operatorActionRequired: false`). If additionally
   `!facts.branchExists`, append marker `branch-deleted` and hint `reattach-branch`
   (`operatorActionRequired: true`).
3. **`partially-created`**: `facts.lifecycleState === "provisioning"` → status
   `partially-created`, no additional drift marker (the state itself is
   diagnostic), hint `recreate-worktree` (`operatorActionRequired: false`).
4. **`locked`**: `facts.lockExpired` → status `locked`, marker `lock-stale`,
   hint `release-stale-lock` (`operatorActionRequired: false`).
5. **`stale-pointer`**: `facts.isActivePointerTarget && !facts.gitdirMatches` →
   status `stale-pointer`, marker `pointer-stale`, hint `reconcile-pointer`
   (`operatorActionRequired: false`).
6. **`drifted`**: the worktree is present and usable but has diverged — a deleted
   task branch (`branch-deleted` → `reattach-branch`, operator-required), a moved
   HEAD (`head-moved` → `operator-repair`, operator-required), uncommitted work
   (`uncommitted-changes` → `commit-or-stash-required`, operator-required), or a
   stale lock (`lock-stale` → `release-stale-lock`, automatic). A `drifted`
   workspace keeps its lifecycle (it is not forced to `recovery-required`); only a
   gone/structurally-unusable worktree (`missing`/`stale-pointer`/`unmanaged-path`)
   is flagged.
7. **`recovery-required`** (carry-forward): `facts.lifecycleState === "recovery-required"`
   and none of the above triggered → status `recovery-required`, preserve the
   stored `driftMarkers` and `recoveryHints` from the persisted instance (caller
   passes them through unchanged).
8. **`healthy`**: all checks passed → status `healthy`, empty markers and hints.

This precedence means a path-escape always surfaces before a missing-path report
(the path may technically "not exist" but the containment failure is the actionable
fact). A stale lock surfaces before gitdir drift (the lock must be released before
a worktree re-check is meaningful).

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

Only `recreate-worktree`, `reconcile-pointer` (a moved-but-readable gitdir), and
`release-stale-lock` are applied automatically; a missing/corrupt `.git` pointer
(`pointer-stale`), a moved HEAD, a deleted branch, and uncommitted work require an
operator, because the narrow worktree adapter cannot repair them without risking
loss of the worktree's work.

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
2. Check `pathExists` via `node:fs` `existsSync` on `managedWorktreePath`.
3. Check `pathContained` by calling `@oscharko-dev/keiko-workspace`
   `assertManagedTargetContained(managedRoot, managedWorktreePath)`. **NEVER trust
   a persisted path without realpath verification.** This is a security invariant
   (ADR-0088 D5 / ADR-0089 SC2): a manipulated or migrated path must be
   re-verified before any classification, evidence write, or repair.
4. Check `gitdirMatches` and gather `currentHead` and `branchExists` via the
   **existing** keiko-tools worktree adapter's `listWorktrees()` +
   `localBranchExists()` (ADR-0089 D1). No second git engine.
5. Check `lockExpired` from `instance.lock?.expiresAt` vs `nowIso`.
6. Check `isActivePointerTarget` from `activePointerStore.get()?.workspaceId`.
7. Call `classifyWorkspaceReconciliation(facts)` (pure, no IO).
8. Compute the legal `lifecycleState` transition: if the classification status is
   not `healthy` and the current lifecycle state is `active` or `paused`, transition
   to `recovery-required` (legal per ADR-0088 transition table — no preconditions
   required). If the status is `healthy` and the current state was
   `recovery-required`, it stays `recovery-required` (automatic promotion to
   `active` is NOT performed — restoration is a controlled `setActive` call, not a
   background side-effect).
9. Persist the updated `WorkspaceInstance` via `WorkspaceInstanceStore.upsert`,
   gated by `validateWorkspaceInstance` (content-free closed-allowlist).
10. Append a content-free `WorkspaceEvent` of type `drift-detected` or
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

**D4 — Active-workspace restoration on startup is conservative.**

Conservative means: classify first, restore only if clean. The reconciliation
service does not auto-promote `recovery-required` → `active`. It does not
automatically recreate a missing worktree. It does not automatically resolve
ambiguous active instances. These are all operator-approval-gated repair actions
(D5). The conservative posture reflects two principles from ADR-0088:

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
from this pass.

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
  readonly outcome: "repaired" | "operator-action-required" | "no-op";
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
| `reconcile-pointer` | Re-run the `WorkspaceProvisioningService.provision()` resume path: it resume-completes the still-present worktree and recomputes the content-free `gitdirIdentity` from the live `.git` pointer, refreshing a moved-but-readable gitdir. Applies to `gitdir-mismatch` only (a missing/corrupt pointer is `operator-repair`). | #445 provisioning |
| `reattach-branch` | Return `outcome: "operator-required"` with no mutation (recreating a deleted branch is a Git delivery operation — ADR-0080; the operator must act via the #470 surface, not via a workspace repair route) | None (no mutation) |
| `release-stale-lock` | `WorkspaceInstanceStore.upsert` clearing `lock: null`, then re-reconcile so the classification drops the `lock-stale` marker | #445 store |
| `commit-or-stash-required` | Return `outcome: "operator-required"` with no mutation (uncommitted-changes disposition is a Git delivery decision — ADR-0084; the operator must act via the #470 surface) | None (no mutation) |
| `operator-repair` | Return `outcome: "operator-required"` with no mutation | None (no mutation) |
| `abandon-and-cleanup` | Transition instance to `abandoned` (legal only from `paused`/`handoff-ready`/`recovery-required`/`failed`/`cleanup-pending`, requires `operator-approval`; an `active`/`provisioning` source is refused as `REPAIR_NOT_APPLICABLE`); actual worktree cleanup deferred to #448 (governed cleanup controls) | #445 store transition |

`repair` is classified `mutating-server-action` with `requiresLock: true` and
`requiresOperatorApproval: true` in the ADR-0088 D4 operation authority table.
Every repair invocation acquires the workspace lock first (using the existing
`WorkspaceInstanceStore` lock acquire path) and releases it on completion or
error. Every repair — including `operator-action-required` outcomes — appends a
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
| `listWorktrees` / `localBranchExists` (keiko-tools narrow adapter, `GIT_WORKTREE_COMMAND_RULES`) | ADR-0089 D1 | `gitdirMatches`, `currentHead`, `branchExists` fact gathering |
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
  store, #446 pointer store) or explicitly returns `operator-action-required` —
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
  return `outcome: "operator-action-required"` with no mutation. This means repair
  is not a universal cure — three of the seven strategies explicitly require
  operator action via a different surface. The repair route returning a result
  rather than throwing is the correct boundary: the caller (UI or CLI) decides how
  to surface the `operator-action-required` outcome.
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
