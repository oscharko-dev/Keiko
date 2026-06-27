# ADR-0092: Task-Workspace Health, Drift Detection, Audit Trail, and Governed Cleanup

## Status

Proposed

## Date

2026-06-26

## Version

1.0

## Context

Epic #443 delivers task-scoped isolated workspaces backed by Git worktrees.
ADR-0088 (#444) defined the leaf-pure domain contract (10-state lifecycle,
8 drift markers, 6 health states, lock model, recovery hints, content-free audit
events, the durable `WorkspaceInstance`, the operation-authority table, and the
no-duplicate-subsystem delegation table). ADR-0089 (#445) provisioned those
workspaces over a narrow `GIT_WORKTREE_COMMAND_RULES` adapter and a
`WorkspaceInstanceStore` (schema V7). ADR-0090 (#446) added the singleton active
pointer (schema V8) and atomic cross-surface retargeting. ADR-0091 (#447) made
persisted state trustworthy after restarts: a pure reconciliation classifier
(`classifyWorkspaceReconciliation`), a thin IO reconciliation service, and a
controlled operator-approval-gated repair service.

**What does not yet exist is the operational support surface.** ADR-0091
explicitly deferred two concerns to this slice:

- Live worktree cleanliness. The #445 adapter has no `git status` verb; #447
  derives `uncommittedChanges` from a persisted drift marker, never a live probe.
  ADR-0091 states verbatim that "live cleanliness is #448's responsibility."
- Physical cleanup. ADR-0091's `abandon-and-cleanup` repair strategy transitions
  an instance to `abandoned` but leaves the worktree on disk; it states "actual
  worktree cleanup deferred to #448."

Issue #448 closes both, plus orphan detection and the audit trail for cleanup.
The governing forces are those of ADR-0088 plus four Issue stop conditions:

- **SC1 — cleanup can never target an unmanaged path.** Every removal target must
  be realpath-contained inside the Keiko-owned managed root.
- **SC2 — cleanup never trusts persisted metadata.** Containment and ownership are
  re-verified against the live filesystem at the moment of removal, never read
  from the stored `managedWorktreePath`.
- **SC3 — content-free audit.** Every audit event (including cleanup refusals)
  carries ids, enums, counts, and ISO timestamps only — no source text, secrets,
  raw command output, token-bearing metadata, or unbounded local paths.
- **SC4 — active or dirty workspaces are never cleaned without an explicit safety
  decision.** Refusal is a first-class successful safety outcome, not an error.

### What the existing slices already provide

The contract already carries everything the audit surface needs: the
`WorkspaceEvent` union already includes `cleanup-requested`, `cleanup-completed`,
`drift-detected`, `health-changed`, `lock-acquired`, and `lock-released`; the
operation-authority table already declares `get-health` (read-only),
`request-cleanup` (mutating, operator-approval), and `complete-cleanup` (mutating,
lock + operator-approval); the lock-reason union already includes `cleanup`; and
the lifecycle machine already has the legal transitions `*->cleanup-pending`
(operator-approval) and `cleanup-pending->archived|abandoned`. The managed-root
ownership marker (`assertManagedRootOwned`) and realpath containment
(`assertManagedTargetContained`) exist in `managed-root.ts`. The narrow worktree
adapter already exposes `removeWorktree` and `pruneWorktrees`.

What does not exist:

1. A read-only `status` verb on the worktree adapter for live dirty detection.
2. A named operational-health classification vocabulary (distinct from the
   6-member point-in-time `TaskWorkspaceHealth` and the 8-member reconciliation
   status): the Issue's AC1 enumerates `healthy | dirty | drifted | missing |
   stale-pointer | locked | orphaned | archived | cleanup-ready |
   recovery-required`, which adds `dirty`, `orphaned`, `archived`, and
   `cleanup-ready` on top of reconciliation.
3. A pure cleanup-safety decision function.
4. A keiko-server health service (orphan detection + live signal gathering) and a
   governed cleanup service.
5. Additive BFF routes and deps wiring.

## Decision

**D1 — One read-only `status` verb is added to the existing narrow worktree adapter; no new spawn boundary.**

Live dirty detection requires a working-tree probe the #445 adapter does not have.
`status` is added to `GIT_WORKTREE_COMMAND_RULES.allowedSubcommands`
(`["worktree", "rev-parse", "show-ref", "status"]`). This is read-only: `git
status` cannot mutate, so the adapter's structural separation from
`GIT_MUTATION_COMMAND_RULES` (branch/commit/switch/push/merge — ADR-0089 D1) is
preserved; the adapter still cannot reach any write subcommand. The new adapter
method `worktreeStatus()` runs `git status --porcelain` in a worktree-bound
adapter and returns the content-free `{ dirty: boolean }` (any porcelain output —
tracked OR untracked — counts as dirty; the conservative choice for a deletion
gate). The porcelain lines themselves never leave the adapter. The same
`denyFlags` (`-C`, `-c`, `--git-dir`, …) and operand validation apply unchanged.

**D2 — Operational health classification lives in the pure leaf contract (`keiko-contracts/task-workspace.ts`, `KEIKO_CONTRACTS_VERSION` 0.10.0 → 0.11.0, additive).**

Following ADR-0088 D2 / ADR-0091 D2: behavioral contracts live in the authority
package so they are testable without IO and consumed by #449/#450 and any future
dashboard without re-implementation (AC5). Additive pure exports:

- `WorkspaceHealthClassification` — the AC1 10-member closed union, with
  `WORKSPACE_HEALTH_CLASSIFICATIONS` (frozen) and `isWorkspaceHealthClassification`.
- `WorkspaceHealthSignals` — the content-free input: the existing
  `WorkspaceReconciliationFacts` plus two booleans (`worktreeDirty`,
  `ownershipProven`). No new path/identity fields; it composes #447's facts.
- `classifyWorkspaceHealth(signals)` — pure, returns
  `{ classification, driftMarkers, recoveryHints, cleanupEligible }`. It delegates
  the structural classification to `classifyWorkspaceReconciliation` (no second
  precedence chain), then layers the four #448 distinctions:
  `unmanaged-path`/`partially-created`/`recovery-required` → `recovery-required`;
  `locked` → `locked`; `missing`/`stale-pointer`/`drifted` pass through; a
  `healthy` structure with `worktreeDirty` → `dirty`; a settled lifecycle
  (`archived`/`merged`) → `archived`; and a cleanup-eligible lifecycle whose
  safety gate passes → `cleanup-ready`. `cleanupEligible` is set by the single
  safety function below, so the classifier and the gate cannot diverge.
- `WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES` (`archived`, `merged`,
  `abandoned`, `failed`, `cleanup-pending`) + `isCleanupEligibleLifecycleState`.
- `evaluateWorkspaceCleanupSafety(facts)` — pure, the single cleanup gate.
  Refusal precedence: `ownership-unproven` → `path-escape` → `lock-live` →
  `worktree-dirty` → (orphan with no record ⇒ allowed) → `not-eligible-state` →
  allowed. Returns `{ allowed, refusalReason? }` with the
  `WorkspaceCleanupRefusalReason` union. This narrows the contract transition
  table (which permits `active->cleanup-pending` with approval): #448 policy
  refuses cleanup of `active`/`paused`/`handoff-ready`/`recovery-required`
  workspaces (defense in depth — they must be archived/abandoned first).
- `WorkspaceHealthEntry` / `WorkspaceHealthReport` — content-free result types
  with `WORKSPACE_HEALTH_ENTRY_ALLOWED_KEYS` / `WORKSPACE_HEALTH_REPORT_ALLOWED_KEYS`
  closed-allowlist validators (`validateWorkspaceHealthEntry` /
  `validateWorkspaceHealthReport`, identical unknown-key rejection to
  ADR-0088 D3) and a pure `deriveWorkspaceHealthEntry` builder.

The orphan **kind** is carried on the entry (`kind: "instance" | "orphan-worktree"`):
an `orphan-worktree` entry is a managed directory present on disk with no persisted
record; it always classifies `orphaned` and carries no `workspaceId`/lifecycle.

**D3 — The keiko-server health service is a thin read-only IO layer; it never persists or mutates.**

`packages/keiko-server/src/task-workspace/health.ts` exports
`createWorkspaceHealthService` with `report(repositoryRoot?)`. For each persisted
instance it gathers `WorkspaceHealthSignals` by reusing the #447
fact-gathering path (`reconcileSingleInstance`'s fact collection is refactored to
a shared `gatherReconciliationFacts` export — no second containment/git engine),
adds a live `worktreeDirty` probe (D1, only for a present+contained worktree) and
an `ownershipProven` check (`assertManagedRootOwned` is idempotent; ownership is
read via the marker), then calls the pure `classifyWorkspaceHealth`. Orphan
detection reads the managed-root directory (`<managedRoot>/<repositoryId>/*`),
realpath-contains every candidate, and emits an `orphan-worktree` entry for each
contained directory with no matching persisted `managedWorktreePath`. The service
performs **no** store writes and emits **no** evidence — health is observation;
reconciliation (#447) owns the persisted `health`/`driftMarkers` columns and their
`health-changed`/`drift-detected` events. This keeps `GET .../health` side-effect
free and avoids double-emission.

**D4 — Cleanup is a governed, operator-approval-gated, live-verified server action that reuses, never duplicates.**

`packages/keiko-server/src/task-workspace/cleanup.ts` exports
`createWorkspaceCleanupService` with three operations:

- `requestCleanup(workspaceId, requestedBy, operatorApproved)` — the
  `request-cleanup` operation. Refuses unless the lifecycle is cleanup-eligible
  (D2). Validates the `*->cleanup-pending` transition (operator-approval),
  persists `cleanup-pending`, emits a `cleanup-requested` event.
- `completeCleanup(workspaceId, requestedBy, operatorApproved)` — the
  `complete-cleanup` operation (lock + operator-approval). It **re-gathers live
  facts** (existence, realpath containment, live dirty, lock liveness, ownership)
  — never trusting the persisted row (SC2) — and runs
  `evaluateWorkspaceCleanupSafety`. On refusal it emits a content-free blocked
  event and returns a `refused` result with the reason (a successful safety
  outcome, never an error — SC4). On approval it acquires the `cleanup` lock,
  removes the worktree through the **governed** adapter (`removeWorktree({force:
  false})`, falling back to a single realpath-contained-and-ownership-gated
  `safelyRemoveManagedPath` for a directory git no longer tracks), deletes the
  retired instance row, clears the active pointer if it referenced the workspace,
  and emits a `cleanup-completed` event. The content-free history survives in the
  evidence ledger after the row is deleted.
- `cleanupOrphans(repositoryRoot?, requestedBy, operatorApproved)` — scans the
  managed root for `orphan-worktree` directories, and for each contained+owned+
  clean one performs the same governed removal, emitting one `cleanup-completed`
  per orphan (synthetic correlation id). Refusals are reported per orphan.

`safelyRemoveManagedPath(managedRoot, path)` is the single security-critical
choke point: it asserts (1) managed-root ownership (`assertManagedRootOwned`),
(2) realpath containment (`assertManagedTargetContained` — rejects symlink escape,
parent traversal, out-of-root absolute targets), (3) the path is a strict
descendant of the managed root (never the root or a repository-id dir alone), then
`rmSync(path, { recursive: true, force: false })`. Every check failure throws a
content-free `TaskWorkspaceError`, never proceeding. This is the ONLY place a
filesystem deletion happens, and it is exercised by the negative test matrix.

New `TaskWorkspaceErrorCode`s (additive): `CLEANUP_NOT_ELIGIBLE` (409, blocked),
`CLEANUP_REFUSED` (409, blocked), `CLEANUP_FAILED` (500, failed). The evidence
`WorkspaceLifecycleOperation` union gains `health` and `cleanup`; the
`WorkspaceLifecycleOutcome` union gains `cleanup-requested`, `cleanup-completed`,
and `cleanup-refused` — all additive, the document stays content-free.

**D5 — Additive BFF routes; CSRF posture inherited.**

| Method | URL | Mutation | Body / query | 200 body |
|---|---|---|---|---|
| `GET` | `/api/task-workspaces/health?root=<repoRoot>` | none | `root` query | `{ report: WorkspaceHealthReport }` |
| `POST` | `/api/task-workspaces/:workspaceId/cleanup` | request or complete | `{ requestedBy, operatorApproved, mode: "request"\|"complete" }` | `{ instance?, outcome, refusalReason? }` |
| `POST` | `/api/task-workspaces/cleanup/orphans` | governed removal | `{ root?, requestedBy, operatorApproved }` | `{ removed, refused }` (counts + content-free reasons) |

The literal `health` and `cleanup/orphans` paths are registered before
`:workspaceId` (literal-segment specificity, ADR-0090 route-matcher note). All
responses pass through `deps.redactor`. The two POST routes inherit the server's
global CSRF gate exactly like the #445–#447 mutation routes; the GET is read-only.

### Reuse map

| Item reused | Source | Reuse point |
|---|---|---|
| `classifyWorkspaceReconciliation` precedence chain | ADR-0091 D2 | `classifyWorkspaceHealth` structural classification |
| `WorkspaceReconciliationFacts` + fact gathering | ADR-0091 D2/D3 | `WorkspaceHealthSignals` composes it; `gatherReconciliationFacts` shared |
| `planWorkspaceRecoveryHints` | ADR-0091 D2 | health drift→hint mapping |
| `assertManagedRootOwned` / `assertManagedTargetContained` | ADR-0089 D2 | cleanup ownership + live realpath containment (SC1/SC2) |
| narrow worktree adapter (`GIT_WORKTREE_COMMAND_RULES`) | ADR-0089 D1 | `worktreeStatus` (read-only `status`), `removeWorktree`, `pruneWorktrees` |
| `WorkspaceInstanceStore.upsert/delete/listAll/listByRepository` | ADR-0089 D4 / ADR-0091 D1 | cleanup persistence + orphan cross-reference |
| `ActiveWorkspacePointerStore.get/.clear` | ADR-0090 D1 | clear pointer on cleanup of the active workspace |
| `appendWorkspaceLifecycleEvidence` + `buildWorkspaceEvent` | ADR-0089 D6 | all cleanup events (content-free) |
| `WorkspaceEvent` cleanup/health event types | ADR-0088 D3 | already in the closed union — no new event types |
| `request-cleanup` / `complete-cleanup` / `get-health` operations | ADR-0088 D4 | service authority + approval/lock gates |
| `validateTaskWorkspaceTransition` `*->cleanup-pending` | ADR-0088 D2 | `requestCleanup` legality |
| `runHandler`/`redacted`/`mapError`/`resolveRoot` BFF utilities | ADR-0089 D5 | all three new handlers |

## Consequences

### Positive

- Operators get a deterministic, content-free health view that distinguishes
  ten explicit conditions, and a governed cleanup path that cannot escape the
  managed root or delete dirty/active/locked work.
- The cleanup-safety decision is one pure function consumed by both the
  classifier (`cleanup-ready`) and the service (refusal gate) — they cannot
  diverge.
- No new git engine, containment engine, persistence layer, or spawn boundary.
  The only adapter change is one read-only verb.
- The content-free invariant is preserved end-to-end; cleanup refusals are
  audited as successful safety outcomes.

### Negative

- `KEIKO_CONTRACTS_VERSION` bumps to `0.11.0` (additive); version-switch consumers
  add a case (the `arch:check:negative` gate catches any that miss it).
- The operational-health vocabulary is a third status family alongside
  `TaskWorkspaceHealth` (point-in-time) and `WorkspaceReconciliationStatus`
  (reconciliation outcome). The distinction is necessary (AC1 enumerates four
  conditions neither family expresses) but is another concept to internalize.
- `cleanupOrphans` and the health report read the managed-root directory; bounded
  by the managed-root policy (only Keiko-provisioned dirs), never on a hot path.

### Neutral

- `completeCleanup` deletes the retired instance row. The audit history lives in
  the evidence ledger, which is independent of the row, so cleanup reclaims the
  record without losing the content-free trail.
- Cleanup is operator-gated and refusal-first: a refusal returns a result, never
  throws. The caller decides how to surface it.

## Alternatives Considered

### Alternative 1: Detect dirtiness without a `status` verb (compare HEAD via `rev-parse` only)

- **Pros**: no allowlist change.
- **Cons**: `rev-parse`/`show-ref` report refs, not working-tree state; they cannot
  detect uncommitted or untracked changes. A deletion gate that cannot see dirty
  work would violate SC4.
- **Why rejected**: live dirty detection is a hard Issue requirement; `git status
  --porcelain` is the canonical read-only probe and stays inside the no-shell
  allowlist boundary.

### Alternative 2: Put `classifyWorkspaceHealth` and the cleanup gate in keiko-server

- **Pros**: avoids the contract version bump.
- **Cons**: the classifier and gate are pure; ADR-0088/0091 established that
  behavioral contracts live in the authority package so #449/#450 import one
  point rather than re-implementing the mapping (a duplication violation) or
  importing keiko-server (a layer violation, ADR-0019).
- **Why rejected**: AC5 is a hard requirement; the leaf package is the correct home.

### Alternative 3: Raw `rm -rf` for cleanup instead of the governed adapter + contained `safelyRemoveManagedPath`

- **Pros**: simplest removal.
- **Cons**: an unguarded recursive delete on a persisted path is exactly the SC1/SC2
  hazard. A symlinked ancestor or a migrated path would let a delete escape the
  managed root.
- **Why rejected**: removal must go through the governed `removeWorktree` first and
  fall back only to a single ownership-and-realpath-gated choke point; both re-verify
  containment live.

### Alternative 4: Reuse the reconciliation status union directly for health (no new classification)

- **Pros**: one fewer vocabulary.
- **Cons**: reconciliation status has no `dirty`, `orphaned`, `archived`, or
  `cleanup-ready` member — the four conditions AC1 specifically requires. Overloading
  reconciliation status would conflate "is the persisted state trustworthy" with
  "is this workspace safe to clean up."
- **Why rejected**: AC1 enumerates a distinct operational vocabulary; the health
  classifier composes (not replaces) the reconciliation classifier.

## Related

- Issue [#443](https://github.com/oscharko-dev/Keiko/issues/443) — parent epic
- Issue [#448](https://github.com/oscharko-dev/Keiko/issues/448) — this ADR's implementing issue
- Issue [#444](https://github.com/oscharko-dev/Keiko/issues/444) — domain contract gate (ADR-0088); health classification, cleanup events, operation authority, and lock model extended here
- Issue [#445](https://github.com/oscharko-dev/Keiko/issues/445) — provisioning (ADR-0089); worktree adapter, store, managed-root ownership/containment reused
- Issue [#446](https://github.com/oscharko-dev/Keiko/issues/446) — active binding (ADR-0090); active pointer cleared on cleanup of the active workspace
- Issue [#447](https://github.com/oscharko-dev/Keiko/issues/447) — reconciliation/repair (ADR-0091); reconciliation classifier + fact gathering reused; this ADR fulfills the live-cleanliness and physical-cleanup deferrals
- Issue [#449](https://github.com/oscharko-dev/Keiko/issues/449) — security/concurrency hardening; consumes the cleanup gate and health service boundaries
- Issue [#450](https://github.com/oscharko-dev/Keiko/issues/450) — verification matrix and runbooks; consumes the health report and cleanup semantics
- [ADR-0088](ADR-0088-task-workspace-domain-contract.md)–[ADR-0091](ADR-0091-task-workspace-startup-reconciliation-and-repair.md) — the task-workspace contract, provisioning, binding, and reconciliation slices reused here
- [ADR-0019](ADR-0019-modular-package-architecture.md) — leaf-package rule (enforces classifier placement in keiko-contracts)
- [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md) — content-free evidence posture
