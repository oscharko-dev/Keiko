# Epic #443 Closeout Summary

Issue #450 records the proof that governed isolated task workspaces are implemented, reviewable, and operable. It does not broaden product scope and does not introduce a second Git Delivery, editor runtime, or terminal-mutation subsystem.

## Implementation proof

The implementation landed through these merged pull requests targeting `feat/keiko-isolated-task-workspaces`:

| PR    | Issue | Scope                                                                             | Squash mergeCommit |
| ----- | ----- | --------------------------------------------------------------------------------- | ------------------ |
| #1555 | #444  | Define task-workspace domain contract on existing workspace and Git architecture  | `0f37aca8`         |
| #1565 | #445  | Implement managed Git worktree provisioning and activation                        | `8826ec3d`         |
| #1567 | #446  | Bind task workspaces across Studio, editor runtime, and Git Delivery surfaces     | `14cde552`         |
| #1570 | #446  | Browser e2e for active-binding task switching                                     | `a954ddbd`         |
| #1579 | #447  | Persist task-workspace state with startup reconciliation and repair semantics     | `c8d216ef`         |
| #1581 | #447  | Address review findings on reconciliation and repair                              | `98e599c9`         |
| #1585 | #448  | Add workspace health, drift detection, audit trail, and governed cleanup controls | `2a2267fc`         |
| #1587 | #449  | Harden task-workspace security, concurrency control, and failure recovery         | `9df0a638`         |

**ADRs**: ADR-0088 through ADR-0093 (one per child issue #444–#449). Final `KEIKO_CONTRACTS_VERSION` on the branch: **0.12.0** (progressed 0.8.0 → 0.9.0 → 0.10.0 → 0.11.0 → 0.12.0 across #444, #447, #448, #449).

## Reuse, not duplication

Governed isolated task workspaces is a narrow, composable feature built on proven authorities; it does not fragment Git Delivery, editor, or terminal governance.

### Git Delivery remains owned by Epic #470

When an operator switches to an active task workspace and executes a Git action (commit, push, branch, PR, merge), the mutation routes continue to flow through the single Git Delivery kernel ([#470 Epic Closeout](../git-delivery/epic-470-closeout.md)). Activation only retargets the governed root.

Evidence:

- **binding.ts:19–29**: `buildBinding()` derives `activeRoot`, `gitDeliveryRoot`, and `editorProjectRoot` from the single `WorkspaceInstance.managedWorktreePath` — all three values are identical (invariant).
- **active-store.ts:1–20, 62–88**: `ActiveWorkspacePointer` stores ONLY: workspaceId, setBy, setAt, updatedAt. NO root, NO branch, NO path is persisted. This design prevents a second root derivation path.
- **execution.ts:63–85**: Git Delivery routes call `resolveProjectWorkspace(deps, projectId)` with the `projectId` from the request body (sent by the browser's active context). The server never consults the active pointer to infer a root. No fallback path exists.
- **lifecycle.ts:192**: After activation, the binding is returned fresh from `buildBinding(persisted)`, never cached or recomputed by a second authority.

**Narrow new authority added by #443**: managed worktree provisioning (via `GitWorktreeAdapter`), active pointer storage and lifecycle (via `ActiveWorkspacePointer` / `active-store.ts`), and the six derived services (reconciliation, repair, health classification, cleanup, evidence, concurrency control). All six reuse the single instance store and active pointer; no second Git, editor, or terminal subsystem exists inside `packages/keiko-server/src/task-workspace/`.

### Terminal Git restrictions remain intact

The human-facing terminal allowlist for Git stays read-only. `packages/keiko-tools/src/terminal-policy.ts` blocks all mutation and network subcommands (add, commit, push, merge, fetch, pull, branch-create, etc.). The allowlist has zero overlap with Git Delivery action kinds.

Evidence:

- **terminal-policy.ts:52–88**: TERMINAL_COMMAND_RULES restricts git to ["status", "diff", "log", "show", "rev-parse", "ls-files", "describe", "blame", "cat-file", "branch", "remote"] — no mutation.
- **terminal-policy.test.ts:428–486**: AC5 test exhaustively denies every Git Delivery mutation class (commit, push, merge, branch-create, stage, unstage). All assertions pass; no false negatives.

### Editor and runtime binding stays deterministic

All surfaces that read the active workspace root (editor, runtime, Files, terminal, Git status/diff, Git Delivery, PR, merge) consume it from a single `ActiveWorkspaceContext` and derive the binding fresh after each activation.

Evidence:

- **ActiveWorkspaceContext.tsx:15–75**: Single context holds `activeRoot` as "Convenience: activeBinding?.activeRoot ?? null". Components read it via hooks at render-time, not cached as a prop. A workspace switch updates context value; all subscribers re-render with the new root.
- **api.ts patterns**: Browser sends `activeRoot` as `projectId` in Git Delivery request bodies. If the browser's context was stale, the stale projectId would be sent — but `resolveProjectWorkspace()` would correctly authorize/reject it (exact path match against store). No server-side fallback exists.
- **No stale-root execution path**: Components never capture `root` as a prop at initialization time. Every NEW request uses the current active root from context.

## Verification evidence

Task-workspace implementation is verified across three evidence layers:

### Unit and integration tests (~290 tests, 25 files)

See [443-verification-matrix.md](./443-verification-matrix.md) for complete test-to-lifecycle mapping. Test files include:

**keiko-server/task-workspace** (21 files): lifecycle, provisioning, reconciliation, repair, cleanup, concurrency, routes (provision/binding/health-cleanup/reconciliation), active-store, store, mutex, health, locks, errors, evidence, naming, managed-root, adversarial, scale.

**keiko-contracts** (3 files): task-workspace (lifecycle states, transitions, validators), task-workspace-health (classification, refusal precedence), task-workspace-reconciliation (entry states, drift markers).

**e2e** (1 file): task-workspace-binding-446.spec.ts (browser Files surface re-targets to active workspace root post-switch; no stale context survives).

Coverage includes:

- Provisioning, activation, switching, pause/resume, restart reconciliation, drift detection, repair, cleanup, concurrency/race control, failure-class taxonomy, performance bounds (N=200), evidence ledger (content-free).
- All 12 HTTP routes with CSRF, CORS, and 503 unconfigured tests.
- Failure-class taxonomy (5 classes: retryable, repairable, blocked, policy-denied, terminal) exhaustively mapped.

### Epic-lifecycle consolidated fixture

**File**: `packages/keiko-server/src/task-workspace/epic-443-lifecycle.test.ts` (4 passing tests)

The fixture wires all six workspace services (provisioning, lifecycle, reconciliation, health, repair, cleanup) over one store, one active pointer, and one shared in-process mutex against disposable REAL git repositories:

1. **Full walk**: provision → activate → switch → pause → resume → restart-reconcile → drift → repair → governed-cleanup (state + pointer correctness verified at each step).
2. **Blocked mutation proof**: dirty cleanup refused, worktree survives (SC4 fail-closed), illegal transition typed rejection (BFF returns error body with `failureClass`).
3. **Git Delivery + editor/runtime binding proof**: #470 and #1491 reuse verified — editor/runtime stay bound to the active managed worktree across a switch, never the project root.
4. **Live fleet health classification**: healthy, dirty, archived, cleanup-ready states live-evaluated (10-class taxonomy exercised).

### Browser e2e

**File**: `tests/e2e/task-workspace-binding-446.spec.ts` (3 tests, Issue #446 acceptance)

Real browser, real packaged app, real `resolveBoundRoot` choke point:

- Files surface tracks active workspace root in URL and switches root post-activation.
- No stale context survives the switch.
- Deterministic mock intercepts task-workspace and files routes (no live git repos in e2e).

### Architecture gates

Required checks remain green:

- **npm run ci** (required GitHub check on all PRs)
- **npm run arch:check** (TS type contract validation across packages)
- **npm run arch:check:negative** (forbidden patterns scan)
- **npm run check:git-delivery-evidence** (Epic #470 governance proof gate, must stay green)

## Security posture

Task-workspace security hardening (Issue #449 / ADR-0093) is cross-layer:

### Path and scope safety

- Path traversal, symlink escape, managed-root spoofing, and out-of-root deletion attempts are rejected deterministically (managed-root.test.ts, adversarial.test.ts).
- Owned paths checked before cleanup (safelyRemoveManagedPath choke point, cleanup.ts:fail-closed dirty probe SC4).
- realpath containment enforced; NUL-byte and control-character path inputs rejected (adversarial.test.ts).

### Concurrency and TOCTOU

- In-process keyed async `WorkspaceMutexRegistry` serializes same-resource mutations across three scopes (provisioning, workspace, active), non-reentrant (mutex.ts).
- Canonical ordering prevents deadlock across keys.
- A persisted `WorkspaceLock` advisory record (TTL-based, re-checked deterministically inside the mutex) is the backstop for cross-process and across-restart safety.
- Disjoint resources run in parallel; no global lock.

### Failure taxonomy

All mutations map to one of five deterministic failure classes — `classifyTaskWorkspaceError` is a total `Record<code, class>` and surfaces the class in the BFF response body for caller decision-making:

- **Retryable**: `LOCK_CONTENTION` (a live lock held by another actor that will TTL-expire).
- **Repairable**: `POINTER_DRIFT` (drift the #447 repair path resolves; a bare retry would re-hit the stale state).
- **Blocked**: `ILLEGAL_TRANSITION`, `BRANCH_CONFLICT`, `INVALID_BASE_BRANCH`, `UNSAFE_PATH`, `EXISTING_UNMANAGED_PATH`, `MISSING_REPOSITORY`, `WORKSPACE_NOT_FOUND`, `INVALID_REQUEST`, `CLEANUP_NOT_ELIGIBLE`, `REPAIR_NOT_APPLICABLE` (a precondition/validation gate; change inputs, do not retry).
- **Policy-denied**: `OPERATOR_APPROVAL_REQUIRED` (an approval gate; no mutation executed).
- **Terminal**: `PROVISIONING_FAILED`, `REPAIR_FAILED`, `CLEANUP_FAILED` (a mutation errored after its gate authorized it; needs out-of-band intervention).

### Evidence and audit

Content-free lifecycle events (provision, activate, pause, resume, switch, repair, cleanup, block, fail) are emitted for every mutation attempt, with outcome (success, blocked, approval-required, rejected, failed, recovery-required). No paths, secrets, or source text persisted.

### Cleanup fail-closed

Cleanup operations refuse dirty, locked, unowned, or out-of-root workspaces, leaving them in explicit recoverable states for operator intervention (cleanup.ts, cleanup.test.ts:SC4 section).

## Residual limitations and deferred follow-ups

### In-scope limitations (non-blocking)

1. **In-process mutex per-process only**: Cross-process safety via advisory lock (sqlite FK + transaction). For multi-process deployments, advisory lock TTL is the serialization backstop. No distributed mutex implemented.

2. **Browser e2e is deterministic/route-intercepted**: Proves UI wiring and no-bypass behavior, not live provider git. Real Git Delivery policy and provider interaction proven by adjacent #470 suites.

3. **Git Delivery execution inside active workspace proven by root-retargeting + #470 suites, not live end-to-end git push test**: The feature reuses #470; live mutation integration tested at Git Delivery layer (not repeated at workspace layer).

4. **Performance bounds validated at N=200 paused workspaces** (scale.test.ts: listAll, reconciliation, health, switch latency all within documented bounds).

### Two LOW-severity follow-ups from #449 (non-blocking for closure)

1. **cleanupOrphans double listAll** — optimization opportunity to consolidate two store queries into one. No correctness risk (SC1 side effect is idempotent).

2. **Control/bidi characters in requestedBy/taskId survive into lock owner** — content-free redaction does not strip these chars (e.g., emoji in task name). No sink created; predates #449. Can be addressed as a future evidence hardening pass.

Both are documented in ADR-0093 and do not block production readiness.

## Project-state note

All six child issues (#444–#449) are CLOSED with `status: done`. Epic #443 itself is OPEN and remains open pending this #450 capstone PR. The epic's seven Definition-of-Done checkboxes are satisfied by this artifact set (closure evidence + verification matrix + operator runbook + consolidated fixture):

- [x] All child issues closed with acceptance criteria and verification evidence.
- [x] Required GitHub checks green on implementation PRs.
- [x] Final closure evidence records #470 and #1491 reuse and where narrow new workspace authority was added.
- [x] Tests demonstrate provisioning, activation, switching, pause/resume, restart recovery, drift classification, blocked mutation, repair, cleanup, cross-surface binding.
- [x] Evidence proves generic terminal Git restrictions intact.
- [x] Evidence proves Git Delivery policy/approval/evidence semantics still govern branch, commit, publish, PR, merge inside active workspace.
- [x] Known limitations and follow-ups documented.

## Closure decision

The Epic #443 closure artifact set — this summary, [443-verification-matrix.md](./443-verification-matrix.md), [443-operator-runbook.md](./443-operator-runbook.md), the consolidated epic-443-lifecycle.test.ts fixture, and the merged child-issue evidence (ADRs, contracts versions, PR squash commits) — is sufficient for maintainers to assess rollout and support readiness without rerunning ad hoc investigation. With all child issues closed and this #450 PR green on the required `ci` check, Epic #443 is ready for formal closure as completed.
