# ADR-0093: Task-Workspace Security, Concurrency Control, and Failure Recovery Hardening

## Status

Proposed

## Date

2026-06-27

## Version

1.0

## Context

Epic #443 delivers task-scoped isolated workspaces backed by Git worktrees.
ADR-0088 (#444) defined the leaf-pure domain contract (10-state lifecycle, drift
markers, health states, the advisory lock model, content-free audit events, the
durable `WorkspaceInstance`, the operation-authority table, and the
no-duplicate-subsystem delegation table). ADR-0089 (#445) provisioned those
workspaces over the narrow `GIT_WORKTREE_COMMAND_RULES` adapter and a
`WorkspaceInstanceStore` (schema V7). ADR-0090 (#446) added the singleton active
pointer (schema V8) and atomic cross-surface retargeting. ADR-0091 (#447) made
persisted state trustworthy after restarts (a pure reconciliation classifier, a
thin reconciliation service, and an operator-approval-gated repair service).
ADR-0092 (#448) added a read-only `status` verb, a pure operational-health
classification, a pure cleanup-safety gate, and a governed cleanup service whose
`safelyRemoveManagedPath` is the single filesystem-deletion choke point.

**What does not yet exist is a server-side concurrency guarantee, a consolidated
lock model, and a caller-facing failure vocabulary.** The subsystem today has
three concrete weaknesses that the issue requires closing:

1. **No in-process mutual exclusion — every mutating flow is optimistic
   check-then-write.** Each flow reads the instance, evaluates `lockIsLive(...)`,
   `await`s a Git-adapter spawn, then `store.upsert(...)`. The window between the
   live check and the persisted write is a TOCTOU gap. Confirmed instances:
   `provisioning.ts` `assertProvisionable` (`assertNotLocked` at :310-323,
   `assertNoTargetOrBranchConflict` at :325-342) runs **before** the
   `git worktree add` mutation and the row write; `activateImpl` (:647-684) checks
   `assertActivatable` (:595-619) then writes at :665; `cleanup.ts`
   `assertCompleteCleanupAllowed` (:355-379) checks the foreign-lock at :367-372
   then `finalizeCleanup` (:325-351) acquires the cleanup lock at :331 and removes
   the worktree at :336. Two concurrent `provision()` calls for the **same**
   `(repository, task)` both observe `existing === undefined`, both pass the gates,
   both race `git worktree add`: one wins, the other fails `PROVISIONING_FAILED`.
   The unique `(repository_id, task_id)` DB index prevents duplicate **rows** but
   never the racy worktree mutation or the wasted spawn. There is no server-side
   serializer; safety today rests partly on callers not issuing concurrent
   mutations — a discipline assumption the issue forbids (SC1).

2. **The advisory-lock helpers are duplicated five times.** `lockIsLive` is copied
   into `provisioning.ts:129`, `lifecycle.ts:77`, `reconciliation.ts:80`,
   `cleanup.ts:72`, and `repair.ts:67`, each with its own
   `DEFAULT_LOCK_TTL_MS = 5 * 60_000` (provisioning.ts:63, lifecycle.ts:49,
   reconciliation.ts:61, cleanup.ts:56, repair.ts:51). `makeLock`
   (provisioning.ts:139), `makeRepairLock` (repair.ts:80), and `cleanupLock`
   (cleanup.ts:290) each rebuild the same `WorkspaceLock` shape independently. Five
   copies of a security-relevant predicate is five places a TTL or expiry-parsing
   fix can silently diverge.

3. **The error taxonomy is two-dimensional, not caller-actionable.** `errors.ts`
   maps 17 `TaskWorkspaceErrorCode`s to `{status, outcome}` where
   `outcome ∈ {blocked, failed, retry-required}`. That `outcome` is an
   **evidence-recording** dimension, not a caller-decision dimension: it cannot
   tell a caller whether to *retry as-is*, *route to #447 repair*, *surface a
   policy denial*, or *give up*. The issue requires callers to distinguish FIVE
   classes — `retryable | repairable | blocked | policy-denied | terminal`.

The advisory `WorkspaceLock` (contracts `task-workspace.ts:358`,
`{lockId, owner, reason, acquiredAt, expiresAt?}`) is, and remains, the
**across-restart, across-actor** coordination record persisted in the instance
row (`store.ts` `lock_json`). It is content-free and survives process death; on a
crash it TTL-expires and #447 reconciliation classifies the stale lock so #447
repair can release it. What it is **not** is an *intra-process* serializer: it is
checked optimistically, never held across the `await`. This ADR adds the missing
intra-process serializer **without** changing the meaning of the persisted lock.

The governing forces are those of ADR-0088 plus the four issue stop conditions:

- **SC1 — safety must be server-side, not UI/operator discipline.** Concurrency
  correctness must hold even when two callers race the same workspace.
- **SC2 — lock/cleanup must leave no hidden ambiguity after interruption.** A
  crash mid-mutation must resolve to a classified, recoverable state.
- **SC3 — a hardening fix must not widen terminal/Git/FS/provider/container
  authority.** No new adapter verb, no allowlist change.
- **SC4 — performance bounds must be statable AND measurable** for reconciliation
  and rapid switching.

### What the existing slices already provide

The `WorkspaceEvent` union already includes `lock-acquired` and `lock-released`
(contracts `task-workspace.ts:443-444`), and `buildWorkspaceEvent` already accepts
an optional `lockId` (:485) — but no flow emits these today. The advisory lock,
the unique DB index, the managed-root containment/ownership choke points
(`managed-root.ts`), the `safelyRemoveManagedPath` deletion gate (#448), and the
reconciliation classifier (#447) all exist and are reused unchanged.

What does not exist: an in-process serializer, a single lock-helper home, a
caller-facing failure-class vocabulary, and stated/measurable performance bounds.

## Decision

**D1 — Add an in-process keyed async mutex, `WorkspaceMutexRegistry`, that
serializes mutating critical sections within the single server process. It
composes with — never replaces — the persisted advisory `WorkspaceLock`.**

A new module `packages/keiko-server/src/task-workspace/mutex.ts` exports a pure,
dependency-free, in-process keyed async mutex:

```ts
export interface WorkspaceMutexRegistry {
  // Runs fn() with exclusive access to every key in `keys`, queuing behind any
  // in-flight holder of an overlapping key. Keys are always acquired in the
  // canonical order below to make deadlock structurally impossible. The result
  // (value or throw) of fn propagates to the caller unchanged.
  runExclusive: <T>(keys: readonly string[], fn: () => Promise<T> | T) => Promise<T>;
}

export function createWorkspaceMutexRegistry(): WorkspaceMutexRegistry;
```

Internally the registry holds a `Map<string, Promise<unknown>>` chaining one tail
promise per key; `runExclusive` appends `fn` to the chain of each requested key
(after sorting keys into canonical order) and removes a key's entry when its chain
drains, so the map never grows unbounded. It is **pure in-process JavaScript**: no
spawn, no filesystem, no new adapter verb, no allowlist entry (SC3). A single
`WorkspaceMutexRegistry` instance is created once at server wiring and injected
into the provisioning, lifecycle, repair, and cleanup service deps, so all four
services share one keyspace.

**Three lock scopes, one keyspace.** Mutating flows contend on three logical
resources; each maps to a string key:

| Scope | Key | Guards |
|---|---|---|
| Individual workspace instance | `ws:<workspaceId>` | provision-resume, activate, pause, handoff, repair, request/complete-cleanup of a known instance |
| Shared managed root for a `(repo, task)` not yet provisioned | `prov:<repositoryId>:<taskId>` | first-time `provision()` — the workspaceId does not exist yet, so the instance key cannot be used; the `(repo,task)` pair is the contended resource (the racy `git worktree add` target) |
| Activation / active-pointer retargeting | `active:<repositoryId>` | `setActive` / resume — serializes pointer flips so the singleton active pointer for a repository cannot interleave with a concurrent switch |

`prov:<repositoryId>:<taskId>` and `ws:<workspaceId>` are deterministically
related: `workspaceId = deriveWorkspaceId(repositoryId, taskId)` (`naming.ts`).
The provisioning flow therefore **first** takes `prov:<repositoryId>:<taskId>` (it
must serialize before it knows whether a row exists), and once it has loaded or
created the instance it operates entirely under that key for the remainder of the
call. Because the prov-key is derived from the same `(repo,task)` that derives the
instance id, a concurrent `activate`/`pause` on an *already-provisioned* instance
contends on `ws:<workspaceId>` while provisioning holds `prov:<...>` — these are
**different** keys for the same logical instance only during the first-provision
window, which is exactly when no other flow can target the instance (its id is not
yet returned to any caller). After first provision, every flow uses
`ws:<workspaceId>`.

**Canonical lock-acquisition order (deadlock avoidance).** When a flow needs more
than one key (only activation/retargeting does: it touches both the instance and
the repository's active pointer), keys are acquired in the single canonical order
**`active:*` before `ws:*` before `prov:*`**, and within a tier lexicographically.
`runExclusive` enforces this by sorting its `keys` argument with this comparator
before chaining, so a caller cannot accidentally request keys out of order. Since
every flow that takes multiple keys takes them in one `runExclusive` call under
the same global order, no hold-and-wait cycle can form — deadlock is structurally
impossible (this is the standard resource-ordering deadlock-prevention result).

**Composition with the persisted advisory lock (the critical interaction).** The
mutex and the advisory lock answer two different questions:

- The **mutex** answers *"is another in-process flow mutating this resource right
  now?"* It queues the second flow; it never rejects.
- The **advisory `WorkspaceLock`** answers *"does another actor (possibly from a
  prior process, possibly a different requester) hold this workspace?"* Its check
  (`lockIsLive(...) && lock.owner !== requestedBy → LOCK_CONTENTION`) is a
  deterministic **rejection** and is **preserved unchanged inside** the critical
  section.

The flow is therefore: `runExclusive([key], async () => { … existing advisory
LOCK_CONTENTION check …; … await git mutation …; … store.upsert … })`. Two
requests from the **same** actor/process queue and run one-at-a-time (no more
corrupting races, no wasted duplicate `git worktree add`); a request from a
**different** actor still hits the advisory check **after** the queue drains and
is still rejected with `LOCK_CONTENTION`. The mutex closes the TOCTOU window; it
must never be allowed to convert a deterministic cross-actor `LOCK_CONTENTION`
rejection into a silent serialize-and-succeed (see Risk Callouts and the
Consequences).

**End-to-end crash-recovery story (SC2).** The mutex is in-process only; on
process death it vanishes — which is correct, because nothing it was protecting
survives either. The durable safety record is the persisted advisory lock plus the
visible lifecycle state that every flow already writes on failure
(`provisioning.ts` `failProvisioning` :390-424 writes `failed`/`recovery-required`
with `lock: null`; cleanup writes `cleanup-pending` before removal). After a crash
mid-mutation: (1) the in-proc mutex entry is gone (no leak); (2) the persisted
advisory lock, if one was written, TTL-expires
(`expiresAt`/`acquiredAt + DEFAULT_LOCK_TTL_MS`); (3) on next startup #447
reconciliation gathers live facts and classifies the stale lock / partial worktree
into a recoverable status; (4) #447 repair (`release-stale-lock`,
worktree re-materialization) clears it under operator approval. No state is left in
hidden ambiguity — the persisted lock and lifecycle column are the source of truth,
and the mutex never owned anything durable to leak.

**D2 — Consolidate the duplicated lock helpers into one
`packages/keiko-server/src/task-workspace/locks.ts`, behavior-preserving.**

`locks.ts` becomes the single home for `DEFAULT_LOCK_TTL_MS`, `lockIsLive`,
`makeWorkspaceLock` (generalizing `makeLock`/`makeRepairLock`/`cleanupLock` over a
`reason: WorkspaceLockReason`), and a `resolveLockTtl(depsLockTtlMs?)` helper that
applies the existing `?? DEFAULT_LOCK_TTL_MS` default in one place. The five
duplicated `lockIsLive` definitions and the three lock-builders are deleted and
re-imported. This is a pure refactor: the consolidated `lockIsLive` must be
byte-for-byte equivalent in behavior (same `expiresAt`-first / `acquiredAt + ttl`
fallback, same `Number.isFinite` guards). The existing per-service `ctx.lockTtlMs`
remains the value passed in; only the *definition* is centralized. No test
assertion changes.

**D3 — Add a caller-facing five-class failure vocabulary in the leaf contract;
map every error code to a class in keiko-server.**

Following ADR-0088 D2 / ADR-0091 D2 / ADR-0092 D2 (behavioral vocabularies live in
the authority package so callers import one point — AC5-style domain authority),
`keiko-contracts/task-workspace.ts` gains the additive pure exports
(`KEIKO_CONTRACTS_VERSION` 0.11.0 → 0.12.0):

```ts
export type WorkspaceFailureClass =
  | "retryable"      // transient/contended; the same request may succeed if retried as-is
  | "repairable"    // a drift/partial state that #447 reconciliation+repair resolves
  | "blocked"       // a precondition/validation/conflict gate the caller must change inputs to clear
  | "policy-denied" // an authority/approval gate; needs operator approval or higher privilege
  | "terminal";     // a non-recoverable server fault; do not retry without intervention

export const WORKSPACE_FAILURE_CLASSES: readonly WorkspaceFailureClass[]; // frozen
export function isWorkspaceFailureClass(value: unknown): value is WorkspaceFailureClass;
```

The **code → class** mapping function lives in keiko-server `errors.ts` (the codes
themselves are server-defined, so the mapping stays where the codes live), exported
as:

```ts
export function classifyTaskWorkspaceError(code: TaskWorkspaceErrorCode): WorkspaceFailureClass;
```

The deterministic, total mapping of all 17 current codes:

| Code | Class | Rationale (one line) |
|---|---|---|
| `INVALID_REQUEST` | `blocked` | malformed input; caller must fix the request |
| `MISSING_REPOSITORY` | `blocked` | unknown repository; caller must supply a valid one |
| `INVALID_BASE_BRANCH` | `blocked` | base ref does not resolve; caller must change input |
| `UNSAFE_PATH` | `blocked` | containment/validation rejection; not retryable as-is |
| `BRANCH_CONFLICT` | `blocked` | task branch already exists; caller must rename/resolve |
| `EXISTING_UNMANAGED_PATH` | `blocked` | target exists and is not Keiko-managed; caller must clear it |
| `LOCK_CONTENTION` | `retryable` | another actor holds a live lock; safe to retry after it releases/expires |
| `POINTER_DRIFT` | `repairable` | persisted worktree pointer is stale/missing → #447 repair re-materializes |
| `PROVISIONING_FAILED` | `terminal` | a worktree mutation errored; non-transient, needs investigation |
| `WORKSPACE_NOT_FOUND` | `blocked` | no such instance; caller must change the id |
| `ILLEGAL_TRANSITION` | `blocked` | requested lifecycle move is not legal from the current state |
| `OPERATOR_APPROVAL_REQUIRED` | `policy-denied` | gated operation lacked operator approval |
| `REPAIR_NOT_APPLICABLE` | `blocked` | requested strategy does not fit the reconciled state |
| `REPAIR_FAILED` | `terminal` | an authorized repair mutation errored |
| `CLEANUP_NOT_ELIGIBLE` | `blocked` | lifecycle is not cleanup-eligible; caller must archive/abandon first |
| `CLEANUP_FAILED` | `terminal` | a governed removal errored after the safety gate passed |

Notes on the two non-obvious choices, defended explicitly:

- `LOCK_CONTENTION` is **retryable**, not blocked: the contended lock is
  time-bounded by TTL, so retry is the correct caller behavior. (Its evidence
  `outcome` was already `retry-required` — the new class agrees, intentionally.)
- `POINTER_DRIFT` is **repairable**, not retryable: a bare retry re-hits the same
  stale pointer; the resolution path is #447 reconciliation+repair, which the
  `repairable` class names explicitly. (Its evidence `outcome` is `retry-required`
  for the ledger, but the *caller* action differs — this is exactly why the
  caller-facing class is a separate dimension from the evidence outcome.)

`classifyTaskWorkspaceError` is a `switch` with no `default`, so adding any future
`TaskWorkspaceErrorCode` without classifying it is a TypeScript exhaustiveness
error — the taxonomy can never silently fall out of date. The
`WorkspaceFailureClass` is additionally surfaced on `TaskWorkspaceError` as a
read-only `failureClass` getter (derived, not stored) so route mappers and callers
read it without re-importing the function.

**D4 — State concrete, measurable performance bounds at an agreed scale; these are
the bounds the #450 scale test asserts.**

Agreed scale: **N = 200 persisted workspace instances** for a single Keiko
installation. Justification: Keiko is local-first, one developer-or-small-team per
machine; 200 concurrently-persisted task workspaces (most `paused`/`archived`) is
already generous "enterprise-grade local use" — an active developer rarely exceeds
single-digit *live* worktrees, and reconciliation/health enumerate the persisted
rows, not live worktrees. The bounds:

| Operation | Complexity | Wall-clock budget at N=200 | Reuses |
|---|---|---|---|
| (a) Startup reconciliation over N instances | O(N) — one fact-gather + pure classify per instance, no nested scan | ≤ 2000 ms total (≤ 10 ms/instance amortized incl. fs probes) | #447 `reconcileAll` + `gatherReconciliationFacts` |
| (b) Repeated health checks | O(N) per full report; O(1) per single-instance health | ≤ 2000 ms per full report; ≤ 15 ms single instance | #448 `health.report` |
| (c) Rapid workspace switching | O(1) per switch (single instance load + pointer write under `active:` key) | ≤ 25 ms p95 per `setActive`, fully serialized (no interleave) | #446 active pointer + D1 mutex |
| (d) `listAll` enumeration | O(N) single store query, no per-row IO | ≤ 50 ms | #447/#448 `store.listAll` |

These are intentionally generous (≈10× expected) so the test is a regression guard
against accidental O(N²) (e.g. a nested managed-root rescan per instance), not a
micro-benchmark. The mutex adds **zero** asymptotic cost to read paths (health,
list, reconciliation gathering are not wrapped) and bounded queuing only to
*mutating* paths, which are not on the enumeration hot path. Rapid switching is
O(1) per switch and serialized, so K switches complete in O(K) with no
interleaving corruption — the measurable assertion is "K serial `setActive` calls
each within budget and the final pointer equals the last requested workspace."

### Stop-condition compliance

- **SC1 (server-side, not discipline).** D1 makes concurrent same-resource
  mutations *serialize in the server*; correctness no longer depends on callers
  avoiding concurrency. The advisory cross-actor `LOCK_CONTENTION` check remains a
  server-side gate inside every critical section.
- **SC2 (no hidden ambiguity after interruption).** D1's crash-recovery story:
  the in-proc mutex owns nothing durable (no leak on crash); the persisted
  advisory lock + visible lifecycle column are the durable record and resolve via
  #447 reconciliation/repair. Every mutating flow already writes a classified
  failure state before propagating.
- **SC3 (no authority widening).** The mutex is pure in-process JS — no spawn, no
  new `GIT_WORKTREE_COMMAND_RULES`/terminal/provider/container verb, no allowlist
  change, no new filesystem write (cleanup still goes through #448's
  `safelyRemoveManagedPath`). The lock consolidation deletes code; it adds no
  capability. `npm run arch:check` (depcruise + import-policy) passes because
  keiko-server gains only an intra-package module and an additive contracts type.
- **SC4 (statable + measurable bounds).** D4 gives O()-complexity and concrete
  wall-clock budgets at N=200 for reconciliation, health, rapid switching, and
  enumeration — exactly the assertions the scale test encodes.

### No-duplicate-subsystem check (ADR-0088 D5)

`WorkspaceMutexRegistry` is **genuinely new**: no in-process workspace serializer
exists today (every flow is optimistic check-then-write). The lock-helper
consolidation **removes** duplication (5 `lockIsLive` + 3 builders → 1 home). The
failure-class vocabulary is a new *caller-facing* dimension distinct from the
existing evidence `outcome` (which it does not replace). No engine, store,
containment path, spawn boundary, or git logic is duplicated.

## Consequences

### Positive

- Concurrent mutations on the same workspace (or same not-yet-provisioned
  `(repo,task)`) serialize deterministically inside the server; the confirmed
  double-`git worktree add` race is eliminated, and the TOCTOU window between the
  advisory check and the persisted write is closed.
- One lock-helper home: a TTL or expiry-parsing change happens in exactly one
  place; the five-way divergence risk is gone.
- Callers get a single, exhaustive, caller-actionable failure vocabulary
  (`retryable | repairable | blocked | policy-denied | terminal`) that the type
  system keeps total.
- Performance bounds are explicit and regression-tested; an accidental O(N²) scan
  fails CI.
- Zero authority widening — the hardening is pure in-process logic plus a code
  deletion plus an additive type.

### Negative

- `KEIKO_CONTRACTS_VERSION` bumps to `0.12.0` (additive); version-switch consumers
  add a case (the `arch:check:negative` gate catches any that miss it).
- A fourth status/vocabulary family now exists (`WorkspaceFailureClass`) alongside
  the evidence `WorkspaceFailureOutcome`, `TaskWorkspaceHealth`, and
  `WorkspaceReconciliationStatus`. The distinction (caller action vs. evidence
  record vs. point-in-time health vs. reconciliation outcome) is necessary but is
  another concept to internalize; the ADR's mapping table is the canonical
  reference.
- Wrapping mutating flows in `runExclusive` introduces queuing latency under
  concurrent same-key load. Bounded by D4 (rapid switching budget) and only on
  mutating paths, but a pathological caller hammering one workspace will see
  serialized (not parallel) completion. This is the intended trade.

### Neutral

- The mutex is per-process and resets on restart. This is correct for a local-first
  single-process deployment; the persisted advisory lock remains the across-restart
  record. A future multi-process deployment would need a different primitive — out
  of scope per the issue ("no cloud queueing or distributed lock service").
- `lock-acquired` / `lock-released` evidence events (long present in the contract,
  never emitted) are now emitted at advisory-lock acquisition/release points, so
  the audit trail finally reflects lock lifecycle. Content-free (ids + enums only).

## Alternatives Considered

### Alternative 1: Serialize via the SQLite store transaction (DB-level locking) instead of an in-process mutex

- **Pros**: no new module; relies on the database's own concurrency control.
- **Cons**: the racy mutation is `git worktree add` (a spawn, `provisioning.ts`
  `runWorktreeMutation` :504+), which happens **outside** any DB transaction. A
  store transaction would serialize the row writes but not the worktree mutation
  between them — the exact TOCTOU window stays open. SQLite's single-writer model
  also can't express the `prov:<repo>:<task>` (no row yet) or `active:<repo>`
  scopes cleanly.
- **Why rejected**: the resource that needs serializing (the worktree mutation +
  the check→write window) is not covered by a DB transaction. The mutex wraps the
  whole critical section, spawn included.

### Alternative 2: Keep optimistic check-then-write but add a compare-and-swap (expected-version) guard on the store write

- **Pros**: lock-free; smaller change; `activate` already has a related
  `expectedLifecycleState` guard (provisioning.ts:604-609).
- **Cons**: CAS detects a lost race *after* the wasted `git worktree add`, turning
  it into a retry storm rather than preventing the duplicate mutation; and it can't
  guard first-time `provision()` where no prior version exists (both racers see
  "no row"). It also pushes retry logic onto every caller, contradicting SC1's
  "server-side" requirement.
- **Why rejected**: CAS narrows the corruption window but does not eliminate the
  duplicate spawn or cover first-provision; serialization is the correct primitive
  for "two requests must not race the same worktree."

### Alternative 3: A single global mutex (one lock for the whole subsystem)

- **Pros**: trivially correct; impossible to deadlock; no key scheme.
- **Cons**: serializes *unrelated* workspaces against each other — a `provision`
  for repo A would block an `activate` for repo B, violating the D4 rapid-switching
  budget under any real concurrency and defeating the point of per-task isolation.
- **Why rejected**: too coarse; the keyed registry gives the same safety with
  per-resource parallelism, and the canonical lock-ordering rule keeps it
  deadlock-free.

### Alternative 4: Fold the failure class into the existing `WorkspaceFailureOutcome` (reuse `blocked | failed | retry-required`)

- **Pros**: one fewer vocabulary; no contract bump.
- **Cons**: the existing outcome is the *evidence-ledger* dimension; it conflates
  caller actions that genuinely differ — `POINTER_DRIFT` and `LOCK_CONTENTION` are
  both `retry-required` in the ledger but require **different** caller responses
  (route to repair vs. plain retry). Overloading one enum for two audiences loses
  exactly the distinction the issue's five classes require.
- **Why rejected**: the issue mandates five caller-facing classes; the evidence
  outcome stays for the ledger, and the new class is the caller dimension. They are
  related but not the same axis.

## Related

- Issue [#443](https://github.com/oscharko-dev/Keiko/issues/443) — parent epic
- Issue [#449](https://github.com/oscharko-dev/Keiko/issues/449) — this ADR's implementing issue
- Issue [#444](https://github.com/oscharko-dev/Keiko/issues/444) — domain contract (ADR-0088); advisory lock model + no-duplicate-subsystem rule applied here
- Issue [#445](https://github.com/oscharko-dev/Keiko/issues/445) — provisioning (ADR-0089); the TOCTOU windows this ADR closes live in the provisioning flows
- Issue [#446](https://github.com/oscharko-dev/Keiko/issues/446) — active binding (ADR-0090); the `active:<repo>` mutex scope serializes pointer retargeting
- Issue [#447](https://github.com/oscharko-dev/Keiko/issues/447) — reconciliation/repair (ADR-0091); the crash-recovery resolution path for stale advisory locks; `repairable` failure class routes here
- Issue [#448](https://github.com/oscharko-dev/Keiko/issues/448) — health/cleanup (ADR-0092); cleanup's `safelyRemoveManagedPath` deletion gate reused unchanged
- Issue [#450](https://github.com/oscharko-dev/Keiko/issues/450) — verification matrix; consumes the failure-class vocabulary and asserts the D4 performance bounds
- ADR-0088 — task-workspace domain contract (advisory lock model, no-duplicate-subsystem rule D5)
- ADR-0091 — startup reconciliation and repair (crash-recovery resolution path)
- ADR-0092 — health, drift, audit, governed cleanup (`safelyRemoveManagedPath` deletion gate)
