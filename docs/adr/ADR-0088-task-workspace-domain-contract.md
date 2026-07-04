# ADR-0088: Governed Isolated Task-Workspace Domain Contract

## Status

Accepted

## Date

2026-06-26

## Version

1.0

## Context

Epic #443 introduces isolated task-scoped workspaces: each in-flight agent task gets its own dedicated
Git worktree at a managed path so concurrent tasks cannot stomp each other's working state. Issue #444
is the DESIGN/CONTRACT GATE for the epic: it must deliver the domain model, lifecycle state machine,
and a typed contract surface that every later slice (#445–#450) builds on, without creating any Git
worktree mutation, Studio UI, persistence engine, or cleanup jobs.

Four architectural forces frame every decision below.

**Force 1 — No-duplicate-subsystem.** The codebase already owns three concerns that overlap with
"managing a worktree":

- **Git mutation** — the governed Git delivery surface (Epic #470, ADR-0080–0087) defines the
  typed action kinds, policy packs, execution kernel, and evidence ledger for all Git writes. A
  second Git mutation path in this contract would produce two independent authority surfaces, two
  competing policy models, and two evidence ledgers.
- **Editor runtime context** — the agent-native editor surface (Epic #1491, ADR-0059–0063) owns
  editor sessions, editor workspace paths, and the agent-editor bridge. A second project-context
  or path-containment subsystem here would diverge from that authority.
- **Terminal mutation** — ADR-0018 defines the read-only terminal allowlist and ADR-0043 governs
  the single `runCommand` spawn boundary. No new terminal mutation surface may be introduced
  outside those gates.
- **Path containment** — `@oscharko-dev/keiko-workspace` is the authoritative path-containment
  engine (lexical + realpath). Re-implementing containment logic in this leaf would create a second
  containment surface with different edge-case semantics.

**Force 2 — Content-free auditability.** All persisted and audit fields must carry only opaque
ids/hashes, counts, flags, enums, ISO timestamps, or branch names. No source text, secrets, tokens,
raw provider payloads, or unbounded command output may appear in any `WorkspaceInstance`,
`WorkspaceBinding`, or `WorkspaceEvent` field. This is the same invariant as evidence artifacts
(ADR-0048) and Git delivery evidence (ADR-0083).

**Force 3 — Leaf-package purity.** `keiko-contracts` is a strict dependency leaf (ADR-0019 direction
rule 1): no `@oscharko-dev/*` imports, no IO, no clock, no crypto, no randomness. Every contract and
validator must be a pure function over plain JSON. Opaque ids and timestamps are produced by callers,
not by this module.

**Force 4 — Deterministic ownership.** Partial provisioning, stale pointers, external deletion, dirty
state, and lock contention are all real failure modes in a worktree-backed system. The lifecycle state
machine must encode explicit drift markers and per-transition preconditions so that every failure mode
maps to a named state transition with documented recovery semantics, not to an unspecified error.

### Existing vocabulary to compose

- `git-delivery.ts` / `git-repository.ts` (keiko-contracts) — action kinds, risk taxonomy, lifecycle
  envelopes, repository identity. Task-workspace contract imports NONE of these; it delegates to
  them via the `TASK_WORKSPACE_DELEGATED_SUBSYSTEMS` boundary table.
- `editor-agent.ts` / `editor-session.ts` / `editor-workspace-path.ts` (keiko-contracts) — agent
  editor sessions, write-action preconditions, root-relative file identifiers. Task-workspace binds
  `editorProjectRoot` to the worktree's `activeRoot` WITHOUT duplicating the project-context logic.
- `@oscharko-dev/keiko-workspace` — workspace discovery and path containment. Task-workspace carries
  `managedWorktreePath` and a `path-escape` drift marker; the enforcement logic (lexical + realpath
  check) is delegated entirely to keiko-workspace.
- Validator result shape `{ ok: true } | { ok: false; reasons: string[] }` — established by
  `git-repository.ts`. All validators in this module return the same shape.

### Scope boundary (Issue #444)

This ADR covers only the contract surface. It does not cover:

- Managed Git worktree provisioning and activation engine (Issue #445)
- Cross-surface binding across Studio, editor runtime, and Git Delivery surfaces (Issue #446)
- Persistence store for `WorkspaceInstance` with startup reconciliation and repair semantics (Issue #447)
- Workspace health, drift detection, audit trail, and governed cleanup controls (Issue #448)
- Security, concurrency control, and failure-recovery hardening (Issue #449)
- Verification matrix, release evidence, and operating runbooks (Issue #450)

## Decision

We will introduce one new module in `packages/keiko-contracts/src/`:

**`task-workspace.ts`** — the canonical, pure, leaf-package domain contract for task-scoped isolated
workspaces. It owns eight entities: lifecycle states, health states, drift markers, lock model,
recovery hints, workspace surfaces, the content-free audit event, the durable instance, the binding
(active surfaces), the activation intent, and the operation authority table.

We will add all public exports to `packages/keiko-contracts/src/index.ts` under an `Issue #444`
block, add a `"./task-workspace"` subpath export to `package.json`, bump `KEIKO_CONTRACTS_VERSION`
from `0.8.0` to `0.9.0`, and deliver contract-level tests in
`packages/keiko-contracts/src/task-workspace.test.ts`.

### D1 — Eight canonical entities

The module defines eight entities. All schema-versioned objects carry `schemaVersion:
TASK_WORKSPACE_SCHEMA_VERSION = "1"`.

**Entity 1 — Lifecycle states.** Ten states form the complete lifecycle of an isolated task
workspace:

```
provisioning | active | paused | handoff-ready | archived
merged | abandoned | recovery-required | failed | cleanup-pending
```

`TASK_WORKSPACE_LIFECYCLE_STATES` is a frozen array; `TaskWorkspaceLifecycleState` is the string
literal union; `isTaskWorkspaceLifecycleState(x)` is the runtime guard.

**Entity 2 — Health states.** Six states describe the observed health of a workspace at a point in
time, independent of lifecycle state:

```
healthy | degraded | drifted | locked-out | missing | unknown
```

`TASK_WORKSPACE_HEALTH_STATES`, `TaskWorkspaceHealth`, `isTaskWorkspaceHealth`.

**Entity 3 — Drift markers.** Eight markers classify the specific drift condition when health is
`drifted` or `missing`:

```
worktree-missing | gitdir-mismatch | head-moved | branch-deleted
uncommitted-changes | lock-stale | path-escape | pointer-stale
```

`TASK_WORKSPACE_DRIFT_MARKERS`, `TaskWorkspaceDriftMarker`, `isTaskWorkspaceDriftMarker`.

**Entity 4 — Lock model.** `WorkspaceLock` carries `lockId`, `owner`, `reason`, `acquiredAt`, and
optional `expiresAt`. `WorkspaceLockReason` is a closed five-member union:

```
provisioning | activation | mutation | repair | cleanup
```

**Entity 5 — Recovery hints.** `WorkspaceRecoveryHint` pairs a drift marker with a recovery strategy
and an `operatorActionRequired` flag. `WorkspaceRecoveryStrategy` is a closed seven-member union:

```
reconcile-pointer | recreate-worktree | reattach-branch
release-stale-lock | commit-or-stash-required | operator-repair | abandon-and-cleanup
```

This is WORKSPACE recovery only. Git-mutation recovery (e.g., resolving conflicts, rebasing, undoing
commits) stays owned by the governed Git delivery surface (ADR-0083).

**Entity 6 — Surfaces.** `WorkspaceSurface` is an eight-member closed union of the interaction
surfaces a task workspace can expose:

```
chat | files | terminal | browser | editor | runtime | git-delivery | review
```

**Entity 7 — Content-free audit event.** `WorkspaceEvent` carries:
`schemaVersion`, `eventId`, `workspaceId`, `taskId`, `type`, `at`, `correlationId`, and optional
`fromState`, `toState`, `health`, `driftMarkers`, `lockId`. Every field is an opaque id, enum,
boolean, count, or ISO timestamp. `WorkspaceEventType` is a closed seventeen-member union (see D3).
`validateWorkspaceEvent` enforces SC3 by rejecting unknown keys via `WORKSPACE_EVENT_ALLOWED_KEYS`.

**Entity 8 — Durable instance.** `WorkspaceInstance` is the persisted object. Every field is
content-free:

```
schemaVersion, workspaceId, taskId, repositoryId, repositoryRoot,
baseBranch, taskBranch, managedWorktreePath, gitdirIdentity,
lifecycleState, health, lock (WorkspaceLock | null),
createdAt, updatedAt, lastVerifiedAt?, lastVerifiedHead?,
driftMarkers, recoveryHints, auditCorrelationId
```

`gitdirIdentity` is an opaque hash produced by the provisioner; `lastVerifiedHead` is a Git commit
SHA (opaque string); `managedWorktreePath` is a server-side path (not surfaced to the browser). All
string fields that could carry secrets (`taskBranch`, `baseBranch`) are branch names only — no commit
message text, no diff content.

Additionally:

- **`WorkspaceBinding`** — the authoritative active project root for a running task. Carries
  `workspaceId`, `taskId`, `activeRoot`, `boundSurfaces`, `gitDeliveryRoot`, `editorProjectRoot`.
  Contract invariant (enforced by `validateWorkspaceBinding`): `gitDeliveryRoot === activeRoot` and
  `editorProjectRoot === activeRoot`. This means the cross-surface binding slice (#446) passes
  `gitDeliveryRoot` to the governed Git delivery kernel WITHOUT acquiring new authority, and passes
  `editorProjectRoot` to the editor session registry WITHOUT duplicating project-context logic.

- **`WorkspaceActivation`** — the mutating server-action input envelope. Carries `workspaceId`,
  `taskId`, `requestedBy`, `acquireLock`, and optional `expectedLifecycleState`. Structural parallel
  to `GitDeliveryActivation`; not interchangeable.

### D2 — Lifecycle state machine with full transition table and per-transition preconditions (AC2, SC4)

**Legal transition matrix.** `TASK_WORKSPACE_LEGAL_TRANSITIONS` is a frozen
`Readonly<Record<TaskWorkspaceLifecycleState, readonly TaskWorkspaceLifecycleState[]>>` encoding
every legal `from → to` pair. Self-transitions (`from === to`) are always illegal (not present in any
list). The complete matrix:

| From | Legal next states |
|---|---|
| `provisioning` | `active`, `recovery-required`, `failed`, `cleanup-pending` |
| `active` | `paused`, `handoff-ready`, `recovery-required`, `failed`, `cleanup-pending` |
| `paused` | `active`, `handoff-ready`, `archived`, `abandoned`, `recovery-required`, `cleanup-pending` |
| `handoff-ready` | `active`, `merged`, `archived`, `abandoned`, `recovery-required`, `cleanup-pending` |
| `merged` | `archived`, `cleanup-pending` |
| `archived` | `cleanup-pending` |
| `abandoned` | `cleanup-pending` |
| `recovery-required` | `active`, `paused`, `failed`, `abandoned`, `cleanup-pending` |
| `failed` | `recovery-required`, `abandoned`, `cleanup-pending` |
| `cleanup-pending` | `archived`, `abandoned`, `recovery-required` |

**Illegal transitions** (any pair not in the matrix above). Representative examples that implementors
of #445–#450 must not attempt:

| Illegal transition | Rationale |
|---|---|
| `active → provisioning` | Provisioning is a one-time entry state; re-entry would lose the worktree identity. |
| `active → merged` | Merge requires explicit handoff preparation to validate provider-readiness. |
| `merged → active` | A merged workspace's branch is closed; reactivation would reopen a stale branch. |
| `archived → active` | Archives are terminal; recovery is required first or a new workspace is created. |
| `abandoned → active` | Abandoned workspaces may have been partially cleaned; recreate instead. |
| `cleanup-pending → merged` | Cleanup cannot retroactively record a merge that didn't happen. |
| any → `provisioning` | Provisioning is only an entry point; no state transitions back to it. |
| `X → X` (self) | Self-transitions are always illegal; no no-op lifecycle moves. |

**Per-transition preconditions (SC4).** `TaskWorkspaceTransitionPrecondition` is a six-member closed
union:

```
lock-held-by-actor | path-contained | worktree-clean | branch-ready | provider-ready | operator-approval
```

`requiredTaskWorkspaceTransitionPreconditions(from, to)` is a pure function returning a frozen array
of required preconditions for each legal transition. The data table encodes:

| Transition | Required preconditions |
|---|---|
| `provisioning → active` | `lock-held-by-actor`, `path-contained`, `branch-ready` |
| `provisioning → failed` | _(none — failure is always permitted)_ |
| `provisioning → recovery-required` | `lock-held-by-actor` |
| `provisioning → cleanup-pending` | `operator-approval` |
| `active → paused` | `lock-held-by-actor` |
| `active → handoff-ready` | `lock-held-by-actor`, `worktree-clean` |
| `active → recovery-required` | _(none)_ |
| `active → failed` | _(none)_ |
| `active → cleanup-pending` | `operator-approval` |
| `paused → active` | `lock-held-by-actor`, `path-contained` |
| `paused → handoff-ready` | `lock-held-by-actor`, `worktree-clean` |
| `paused → archived` | `operator-approval` |
| `paused → abandoned` | `operator-approval` |
| `paused → recovery-required` | _(none)_ |
| `paused → cleanup-pending` | `operator-approval` |
| `handoff-ready → active` | `lock-held-by-actor`, `path-contained` |
| `handoff-ready → merged` | `provider-ready`, `operator-approval` |
| `handoff-ready → archived` | `operator-approval` |
| `handoff-ready → abandoned` | `operator-approval` |
| `handoff-ready → recovery-required` | _(none)_ |
| `handoff-ready → cleanup-pending` | `operator-approval` |
| `merged → archived` | `operator-approval` |
| `merged → cleanup-pending` | `operator-approval` |
| `archived → cleanup-pending` | `operator-approval` |
| `abandoned → cleanup-pending` | `operator-approval` |
| `recovery-required → active` | `lock-held-by-actor`, `path-contained` |
| `recovery-required → paused` | `lock-held-by-actor` |
| `recovery-required → failed` | _(none)_ |
| `recovery-required → abandoned` | `operator-approval` |
| `recovery-required → cleanup-pending` | `operator-approval` |
| `failed → recovery-required` | _(none)_ |
| `failed → abandoned` | `operator-approval` |
| `failed → cleanup-pending` | `operator-approval` |
| `cleanup-pending → archived` | `lock-held-by-actor`, `worktree-clean` |
| `cleanup-pending → abandoned` | `operator-approval` |
| `cleanup-pending → recovery-required` | _(none)_ |

Every legal transition has an explicit row above (the full set; unlisted/illegal pairs resolve to
`[]` only through the defensive `?? []` fallback). The `operator-approval` precondition gates all
`→ cleanup-pending` transitions and the operator-initiated `→ archived` decisions
(`paused`/`handoff-ready`/`merged → archived`); the mechanical `cleanup-pending → archived`
completion instead requires `lock-held-by-actor` + `worktree-clean`. Implementors of the governed
cleanup controls (#448) must check these before enqueuing cleanup or archival work.

**Partial-provisioning semantics (SC4).** When `provisioning → active` is attempted but
`path-contained` or `branch-ready` is unmet, `validateTaskWorkspaceTransition` returns
`{ ok: false, reasons: ["unmet precondition: path-contained"] }`. The caller stays in
`provisioning` and may retry or transition to `recovery-required`. There is no implicit promotion to
`active` on partial success.

**Stale-pointer semantics (SC4).** The `pointer-stale` drift marker signals that the stored
`managedWorktreePath` or `gitdirIdentity` no longer matches the filesystem. When health probing
detects this condition, the active/paused workspace transitions to `recovery-required` (the
`active`/`paused → recovery-required` detection transitions carry no preconditions) and populates
`recoveryHints` with
`{ marker: "pointer-stale", strategy: "reconcile-pointer", operatorActionRequired: false }`. The
binding is invalidated; downstream slices must re-validate the binding before use.

**Lock-contention semantics (SC4).** The `lock-stale` drift marker signals that a held lock's
`expiresAt` has passed without release. The recovery strategy is `release-stale-lock`; no operator
action is required because expiry is deterministic. The `repair` operation (see D3) acquires a new
lock after releasing the stale one.

**External-deletion semantics (SC4).** If the worktree is deleted outside Keiko (e.g., manual `rm`),
health probing detects `worktree-missing` and records it. The recommended recovery strategy is
`recreate-worktree`. If the base branch is also deleted externally, `branch-deleted` is added to
`driftMarkers`; `reattach-branch` is added as a second recovery hint with `operatorActionRequired:
true`.

**Dirty-state semantics (SC4).** The `uncommitted-changes` drift marker signals uncommitted work
detected at a transition point that requires `worktree-clean`. The recovery strategy is
`commit-or-stash-required`. This is a workspace-level signal; the decision of whether to commit,
stash, or discard belongs to the governed Git delivery surface (ADR-0080–0084).

**Transition validation.** `validateTaskWorkspaceTransition({ from, to, context })` applies the full
check chain:
1. If `to` is not in `TASK_WORKSPACE_LEGAL_TRANSITIONS[from]`: fail with reason
   `"illegal transition from X to Y"`. Self-transitions (`from === to`) fall through this single
   legality check — no state lists itself as a successor — so `X → X` is rejected as
   `"illegal transition from X to X"` (no distinct self-transition message is emitted).
2. For each precondition in `requiredTaskWorkspaceTransitionPreconditions(from, to)`: if unmet, fail
   listing each as `"unmet precondition: <name>"`.
3. Else: `{ ok: true }`.

`TaskWorkspaceTransitionContext` is a readonly record of six boolean flags: `lockHeldByActor`,
`pathContained`, `worktreeClean`, `branchReady`, `providerReady`, `operatorApproved`. Callers
assemble this context from runtime state; the validator never reads the filesystem.

All three functions fail **closed** on a non-state input (a post-deserialization or wire-supplied
value such as `""`, `null`, `"__proto__"`, `"constructor"`): `from`/`to` are guarded with
`isTaskWorkspaceLifecycleState` before the frozen-table lookup, so `isLegalTaskWorkspaceTransition`
returns `false`, `nextLegalTaskWorkspaceStates` returns `[]`, and `validateTaskWorkspaceTransition`
returns `{ ok: false }` — never a thrown `TypeError` and never a prototype-chain value. This keeps the
authority gate deterministic and throw-free on untrusted input, consistent with the sibling
validators (D6).

Helpers: `isLegalTaskWorkspaceTransition(from, to)`, `nextLegalTaskWorkspaceStates(from)`.

### D3 — Content-free audit event shape (SC3)

`WorkspaceEventType` is a closed seventeen-member union:

```
provisioned | activated | paused | resumed | handoff-prepared | merged
archived | abandoned | recovery-flagged | repaired | cleanup-requested
cleanup-completed | lock-acquired | lock-released | drift-detected
health-changed | transition-rejected
```

`WorkspaceEvent` fields: `schemaVersion`, `eventId`, `workspaceId`, `taskId`, `type`, `at`,
`correlationId`, optional `fromState`, `toState`, `health`, `driftMarkers`, `lockId`. Every field is
an opaque id, enum, boolean, count, or ISO timestamp string. There is no `message`, no `detail`, no
`output`, no `diff`, no `path` field.

SC3 is enforced by `validateWorkspaceEvent` via `WORKSPACE_EVENT_ALLOWED_KEYS`: the frozen set of
the exact field names listed above. Any input with an additional key (e.g., `commandOutput`,
`sourcePath`, `tokenValue`, `sourceText`) is rejected with reason
`"unknown key not allowed (content-free): <key>"`. This is a compile-time guarantee (the type)
reinforced by a runtime guard (the validator), making it impossible to accidentally persist source
content via the event stream.

The same closed-allowlist unknown-key rejection is applied by **every** persisted-object validator —
not only the audit event — so the content-free invariant holds across the whole durable surface:
`validateWorkspaceInstance` (`WORKSPACE_INSTANCE_ALLOWED_KEYS`), `validateWorkspaceBinding`
(`WORKSPACE_BINDING_ALLOWED_KEYS`), and `validateWorkspaceActivation`
(`WORKSPACE_ACTIVATION_ALLOWED_KEYS`). This closes a defense-in-depth gap: a #447 persistence layer
that trusts `validateWorkspaceInstance(input).ok` and stores the whole object cannot persist a record
carrying a smuggled `sourceDiff` / `commandOutput` / `tokenValue` field.

The `at` field is an ISO 8601 timestamp string supplied by the caller (not generated by the leaf
module). The `eventId` and `correlationId` are opaque strings produced by callers using
`sha256Hex` or a CSPRNG — never by this module.

### D4 — Read-only vs mutating-server-action authority (AC3)

`TASK_WORKSPACE_OPERATIONS` is a frozen array of operation descriptors:

```typescript
{
  name: WorkspaceOperationName;
  authority: WorkspaceOperationAuthority; // "read-only" | "mutating-server-action"
  requiresLock: boolean;
  requiresOperatorApproval: boolean;
}
```

The complete operation table:

| Operation | Authority | Lock | Operator Approval |
|---|---|---|---|
| `discover` | read-only | no | no |
| `get-instance` | read-only | no | no |
| `get-health` | read-only | no | no |
| `resolve-binding` | read-only | no | no |
| `append-event` | read-only | no | no |
| `provision` | mutating-server-action | yes | no |
| `activate` | mutating-server-action | yes | no |
| `pause` | mutating-server-action | no | no |
| `resume` | mutating-server-action | yes | no |
| `prepare-handoff` | mutating-server-action | no | no |
| `mark-merged` | mutating-server-action | no | no |
| `archive` | mutating-server-action | no | no |
| `abandon` | mutating-server-action | no | no |
| `flag-recovery` | mutating-server-action | no | no |
| `repair` | mutating-server-action | yes | yes |
| `request-cleanup` | mutating-server-action | no | yes |
| `complete-cleanup` | mutating-server-action | yes | yes |
| `acquire-lock` | mutating-server-action | no | no |
| `release-lock` | mutating-server-action | no | no |

`append-event` is classified `read-only` because it is a logging operation (idempotent, content-free,
no worktree mutation). The append boundary itself is enforced by the persistence layer (issue #447),
not by this contract.

Helpers: `taskWorkspaceOperation(name)`, `isReadOnlyTaskWorkspaceOperation(name)`,
`isMutatingTaskWorkspaceOperation(name)`.

### D5 — No-duplicate-subsystem delegation boundary (AC4)

`TASK_WORKSPACE_DELEGATED_SUBSYSTEMS` is a frozen array of `{ concern: TaskWorkspaceDelegatedConcern; owner: string }`:

| Concern | Owner |
|---|---|
| `git-mutation` | `git-delivery (#470, ADR-0080–ADR-0087)` |
| `editor-runtime-context` | `editor-agent / editor-session (#1491, ADR-0059–ADR-0063)` |
| `terminal-mutation` | `keiko-tools terminal policy (ADR-0018) — unchanged` |
| `workspace-discovery-and-containment` | `@oscharko-dev/keiko-workspace` |

Helpers: `isDelegatedTaskWorkspaceConcern(concern)`, `taskWorkspaceDelegatedOwner(concern)`.

**What this module does NOT define:**

1. **No Git mutation.** The contract carries `taskBranch` and `baseBranch` as opaque branch name
   strings. It does NOT define `git worktree add`, `git commit`, `git push`, or any Git execution
   adapter. When a slice needs to create or delete a worktree, it calls the governed Git delivery
   execution kernel (ADR-0081). The `WorkspaceBinding.gitDeliveryRoot` field is the pass-through
   path; the task-workspace contract does not widen the Git delivery authority.

2. **No editor runtime.** The contract carries `WorkspaceBinding.editorProjectRoot`. It does NOT
   define editor sessions, language service connections, hot-exit snapshots, or inline completion
   providers. All of those are owned by `editor-agent.ts` / `editor-session.ts` (ADR-0059). The
   `editor` member of `WorkspaceSurface` marks whether an editor surface is bound; it does not
   provision one.

3. **No terminal mutation.** The contract carries `terminal` as a `WorkspaceSurface` member to
   indicate that a terminal surface is bound to the workspace. It does NOT define any new
   terminal execution rules, allowlist expansions, or spawn boundaries. Terminal execution remains
   governed exclusively by ADR-0018 + ADR-0043.

4. **No new path-containment engine.** The contract carries `managedWorktreePath` as an opaque
   string and `path-escape` as a drift marker. Path containment enforcement (lexical + realpath
   check) is delegated entirely to `@oscharko-dev/keiko-workspace`. No `isContained`, `realpath`,
   or path-prefix logic appears in this module. The `path-contained` precondition is a boolean
   signal in `TaskWorkspaceTransitionContext`; the caller evaluates it using keiko-workspace APIs
   before calling `validateTaskWorkspaceTransition`.

This delegation boundary is enforced by the leaf-package rule (ADR-0019): `keiko-contracts` cannot
import `@oscharko-dev/*` packages, so it cannot call any of the four owning subsystems. The test
suite verifies `TASK_WORKSPACE_DELEGATED_SUBSYSTEMS` covers all four concerns and that
`isDelegatedTaskWorkspaceConcern` returns `true` for each and `false` for arbitrary non-concerns.

### D6 — Reuse map

| Item reused | Source | Reuse point |
|---|---|---|
| Validator result shape `{ ok: true } \| { ok: false; reasons: string[] }` | `git-repository.ts` | All validators in this module |
| File header comment pattern (ownership + disjointness + leaf rules) | `git-delivery.ts` | `task-workspace.ts` file header |
| `// eslint-disable-next-line complexity` above large validators | `git-repository.ts` | `validateWorkspaceInstance` |
| `TASK_WORKSPACE_SCHEMA_VERSION = "1"` pattern | `GIT_DELIVERY_SCHEMA_VERSION` | `schemaVersion` field on all objects |
| Content-free event pattern (ids/hashes/counts/flags/enums/timestamps only) | ADR-0048, ADR-0083 | `WorkspaceEvent` |
| Frozen const array + string literal union + runtime guard pattern | All contract modules | All enum surfaces |
| `operator-approval` precondition as a gate on destructive/irreversible transitions | ADR-0080 D4 approval-gated policy | `→ cleanup-pending`, `repair`, `complete-cleanup` |

## Consequences

### Positive

- A single authoritative type contract means issues #445–#450 import from one place and have
  compile-time guarantees about field shapes, state membership, and transition legality.
- The full transition table with preconditions makes every partial-provisioning, stale-pointer, and
  lock-contention failure mode explicit and addressable without consulting implementation code.
- The delegation boundary table (D5) enforces at the architecture level that four subsystems remain
  single-authority; no accidental re-implementation can pass `arch:check`.
- Content-free event shape + unknown-key rejection (D3) means no future developer can accidentally
  log source text, credentials, or command output through the event stream.
- `WorkspaceBinding`'s invariant `gitDeliveryRoot === activeRoot` and `editorProjectRoot ===
  activeRoot` means the governed Git delivery and editor surfaces get a correct root path by
  construction without an additional lookup; no binding divergence is possible.

### Negative

- A ten-state lifecycle machine has 90 potential state pairs. The transition table is the primary
  complexity burden for implementors of #445–#450. Any new state added in a future issue requires
  updating the transition table, the preconditions table, and the event type union (three coordinated
  edits).
- `validateTaskWorkspaceTransition` takes a context object whose six booleans must be truthfully
  assembled by the caller. If a caller assembles context incorrectly (e.g., sets `pathContained:
  true` without calling keiko-workspace), the validator is satisfied but the invariant is violated.
  The contract cannot enforce caller honesty — only documentation and code review can.
- The operation authority table classifies nineteen operations. Adding a new operation in a future
  issue requires a coordinated addition to the frozen table and the test suite.

### Neutral

- The `provisioning` state exists as an entry point only; no state transitions back to it. This is
  a deliberate simplification — if a provisioning attempt produces a bad result, it must fail to
  `failed` or `recovery-required`, not restart in `provisioning`. New provisioning attempts create a
  new `WorkspaceInstance`.
- Recovery hints are informational only in the contract layer. The actual repair logic (filesystem
  operations, Git operations, lock releases) belongs to the provisioning engine (#445), the repair
  semantics slice (#447), and the governed Git delivery kernel (ADR-0081). The contract does not
  restrict how many recovery hints a `WorkspaceInstance` may carry.
- `append-event` is classified `read-only` in the operation table even though it mutates the event
  ledger. This reflects the contract semantics: the event is content-free, the operation is
  idempotent (re-appending the same `eventId` is a no-op at the persistence layer), and the
  operation does not change lifecycle state. Implementors of the persistence layer (#447) must
  enforce the idempotency contract.

## Alternatives Considered

### Alternative 1: Merge the task-workspace contract into `git-delivery.ts`

- **Pros**: Fewer files; no barrel changes; the lifecycle concepts are similar (both involve Git
  worktrees and branch management).
- **Cons**: `git-delivery.ts` owns the ten Git action kinds, risk taxonomy, policy packs, and
  lifecycle envelopes for DELIVERY operations (commit, push, merge, etc.). Adding workspace
  lifecycle (provisioning, pausing, handoff, cleanup) to the same file would create a module with
  two distinct rates of change and two distinct owners: the Git delivery kernel evolves when provider
  APIs change; the workspace lifecycle evolves when the task isolation model changes. The resulting
  module would exceed 2,000 LOC within two slices of #445–#450. The no-duplicate-subsystem rule
  (AC4) explicitly forbids a second Git mutation surface in this contract, which would be
  structurally unavoidable in a merged file.
- **Why rejected**: Different rates of change, different owners, and the risk of accidentally
  creating a second Git mutation surface.

### Alternative 2: Omit the transition precondition table; record only legal/illegal pairs

- **Pros**: Simpler contract; fewer data entries to maintain; the preconditions can be encoded in
  the provisioning engine (#445) rather than in the leaf contract.
- **Cons**: SC4 explicitly requires transition semantics to be unambiguous for partial provisioning,
  stale pointers, external deletion, dirty state, and lock contention. If the preconditions live in
  the provisioning engine (#445) and not in the contract, then (a) there is no authoritative
  documentation of what checks are required before each transition, (b) issues #446–#450 may
  implement inconsistent checks, and (c) the ADR cannot fulfill its role as the AC2 evidence
  artifact. The preconditions are behavioral contracts, not implementation details.
- **Why rejected**: SC4 is a hard stop condition. The precondition table is the primary evidence for
  AC2.

### Alternative 3: Use a graph/DAG library to encode the state machine

- **Pros**: Machine-readable; could generate a validated state chart; type-safe transition queries.
- **Cons**: `keiko-contracts` is a strict leaf that may import no `@oscharko-dev/*` packages and no
  third-party libraries beyond those already present in `package.json`. A state-machine library would
  introduce a new dependency and a new import. The frozen `Record<State, readonly State[]>` pattern
  is already used in related contracts in this codebase and requires zero dependencies. A
  library-backed implementation would also carry the leaf-package violation risk every time the
  library is updated.
- **Why rejected**: Leaf-package purity (Force 3). The frozen data table approach is sufficient,
  dependency-free, and consistent with established codebase patterns.

### Alternative 4: Record workspace health as a derived field (not persisted)

- **Pros**: Health is always current; no stale health state in the persisted instance; simpler
  instance object.
- **Cons**: Health probing is I/O (filesystem stat, Git ref check). The leaf contract cannot perform
  I/O; health must be an explicit field populated by the provisioning engine (#445) after a probe.
  Omitting the health field from `WorkspaceInstance` would mean callers must always run a probe to
  get health, which couples every reader to I/O. Persisting the last-observed health (with
  `lastVerifiedAt`) allows read-only consumers to display a stale-but-present health without
  triggering a probe.
- **Why rejected**: Leaf-package purity and read-only consumer usability. The `lastVerifiedAt`
  field makes staleness observable.

### Alternative 5: Delegate all recovery strategy selection to the provisioning engine

- **Pros**: The contract is simpler; no `WorkspaceRecoveryStrategy` union to maintain.
- **Cons**: Recovery hints are cross-cutting: the same drift marker (`worktree-missing`) leads to
  the same strategy (`recreate-worktree`) regardless of which slice is responding. Encoding
  strategies in the contract makes that determinism verifiable by tests. Without the recovery hint
  contract, each slice (#445, #447, #449) might independently implement different strategy mappings
  for the same drift marker, producing divergent behavior that is invisible at code review.
- **Why rejected**: Deterministic recovery semantics require a single authoritative mapping;
  encoding it in the contract is the only way to make it testable without I/O.

## Related

- Issue [#443](https://github.com/oscharko-dev/Keiko/issues/443) — parent epic: governed isolated task workspaces
- Issue [#444](https://github.com/oscharko-dev/Keiko/issues/444) — this ADR's implementing issue (contract gate)
- Issue [#445](https://github.com/oscharko-dev/Keiko/issues/445) — implement managed Git worktree provisioning and activation (consumes D1/D2)
- Issue [#446](https://github.com/oscharko-dev/Keiko/issues/446) — bind task workspaces across Studio, editor runtime, and Git Delivery surfaces (consumes D1/D5, `WorkspaceBinding`/`activeRoot`/`gitDeliveryRoot`/`editorProjectRoot`)
- Issue [#447](https://github.com/oscharko-dev/Keiko/issues/447) — persist task-workspace state with startup reconciliation and repair semantics (consumes D1/D2/D3)
- Issue [#448](https://github.com/oscharko-dev/Keiko/issues/448) — workspace health, drift detection, audit trail, and governed cleanup controls (consumes D2/D3/D4)
- Issue [#449](https://github.com/oscharko-dev/Keiko/issues/449) — harden task-workspace security, concurrency control, and failure recovery (consumes D2/D4/D5)
- Issue [#450](https://github.com/oscharko-dev/Keiko/issues/450) — task-workspace verification matrix, release evidence, and operating runbooks (consumes all decisions)
- ADR-0018 — terminal allowlist / `isTerminalCommandAllowed` (read-only baseline, unchanged; `terminal-mutation` delegated to it; referenced as plain text per ADR-0080, no ADR-0018 file in `docs/adr/`)
- [ADR-0019](ADR-0019-modular-package-architecture.md) — leaf-package rule and dependency direction (Force 3)
- [ADR-0080](ADR-0080-governed-git-delivery-contracts.md) — governed Git delivery contracts (`git-mutation` delegated to this surface)
- [ADR-0081](ADR-0081-governed-git-mutation-execution-kernel.md) — Git mutation execution kernel (workspace branch operations pass through here)
- [ADR-0082](ADR-0082-governed-git-approval-and-preview-surface.md) — Git approval and preview surface
- [ADR-0083](ADR-0083-governed-git-mutation-evidence-ledger.md) — Git mutation evidence ledger (content-free event pattern reused from here)
- [ADR-0084](ADR-0084-governed-local-git-flows-and-commit-intent.md) — local Git flows and commit-intent composition
- [ADR-0085](ADR-0085-governed-remote-publish-gateway.md) — remote publish gateway
- [ADR-0086](ADR-0086-governed-github-pull-request-gateway.md) — GitHub PR gateway
- [ADR-0087](ADR-0087-governed-merge-gateway.md) — merge gateway
- [ADR-0059](ADR-0059-agent-editor-public-contracts.md) — agent editor public contracts (`editor-runtime-context` delegated to these)
- [ADR-0063](ADR-0063-root-relative-project-tree-contract.md) — root-relative project-tree file-identifier contract (`editorProjectRoot` binding)
