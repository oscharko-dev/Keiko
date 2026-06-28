# ADR-0089: Managed Task-Worktree Provisioning and Activation

## Status

Proposed

## Date

2026-06-26

## Version

1.0

## Context

Issue #445 is the first **mutating** slice of Epic #443. ADR-0088 / Issue #444 delivered the leaf-pure
task-workspace domain contract (`packages/keiko-contracts/src/task-workspace.ts`): the entities, the
10-state lifecycle machine, per-transition preconditions, the content-free audit event, and the
no-duplicate-subsystem delegation table. #445 must now *implement* the missing `git worktree` lifecycle
authority: create a dedicated task branch and managed worktree from an approved base branch, walk the
`provisioning → active` lifecycle, persist the durable `WorkspaceInstance`, and yield the
`WorkspaceBinding` that #446 binds across surfaces — **without** building a generic shell, a generic Git
runner, a second Git-mutation path, or a second path-containment engine.

The same four forces from ADR-0088 still apply. The governing constraints for this slice are the
Acceptance Criteria (AC1–AC5) and the Stop Conditions (SC1–SC4): no broad shell / generic Git runner
(SC1), prove managed-root ownership before writing (SC2), delegate branch/commit/push/PR/merge to #470
(SC3), and never leave an invisible or unclassified workspace state on partial failure (SC4).

## Decision

**D1 — A narrow worktree adapter over the single governed spawn boundary (AC5, SC1, SC3).**
`packages/keiko-tools/src/git-worktree-adapter.ts` adds `createNodeGitWorktreeAdapter`, exposed on the
existing `@oscharko-dev/keiko-tools/internal/git-mutation` subpath alongside the read snapshot reader
and the #470 mutation/publish/PR/merge executors. It runs every operation through keiko-tools
`runCommand` (no-shell, allowlist-only, env-name-whitelisted, ephemeral HOME, timeout/abort/byte-cap)
with its **own** dedicated `GIT_WORKTREE_COMMAND_RULES`. That rule set allows only the `worktree`,
`rev-parse`, and `show-ref` git subcommands and denies the global cwd/config-shifting flags
(`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`). It is **structurally separate**
from `GIT_MUTATION_COMMAND_RULES` and can never reach `branch`, `switch`, `commit`, `add`, `restore`,
`push`, `merge`, `pull`, or `fetch` — so the adapter cannot widen terminal Git mutation authority or
duplicate the #470 execution surface (AC5). The dedicated task branch is created atomically as part of
`git worktree add -b <branch> <path> <baseRef>` (the worktree lifecycle), not via a second `git branch`
runner. Every operand is validated by pure builders before argv construction (no leading dash, no NUL,
no traversal, no refspec/glob metacharacter), so a value can never masquerade as a flag.

**D2 — Keiko-owned managed root with ownership proof + delegated realpath containment (AC2, SC2).**
The managed worktree root lives at `<uiDbDir>/task-workspaces`, inheriting the per-user data directory
and 0o700 hardening posture. `assertManagedRootOwned` creates the root and writes a restrictive-perm
`.keiko-managed-root` marker; provisioning refuses to write under a root it cannot establish and mark as
its own (SC2). The derived worktree path
(`<managedRoot>/<repositoryId>/<workspaceId>`) is validated lexically **and** after realpath resolution
by `@oscharko-dev/keiko-workspace` (`resolveWithinWorkspace` + `assertContainedRealPath`) — no second
containment engine (ADR-0088 D5). A traversal, out-of-root, or symlinked-ancestor escape becomes a
content-free `UNSAFE_PATH` failure.

**D3 — Deterministic identity for idempotency (AC3).** `repositoryId`, `workspaceId`, `taskBranch`, and
the worktree path are pure hash-derived functions of `(repository root, task id)`. The same task in the
same repository always resolves to the same persisted `WorkspaceInstance`; a retry resumes or completes
it rather than duplicating. A second instance for the same `(repositoryId, taskId)` is additionally
rejected by a partial unique index at the DB layer.

**D4 — Durable persistence over the shared SQLite handle (AC4).** A dedicated `WorkspaceInstanceStore`
(schema migration V7, table `task_workspace_instances`) is composed over the **same** `node:sqlite`
`DatabaseSync` handle as the UI store and the relationship engine, mirroring the #539 relationship-store
composition. Every write is gated by the contract's `validateWorkspaceInstance` (content-free closed
allowlist) and every read re-validates the reconstructed row, so a corrupt or smuggled record can
neither be stored nor silently trusted (SC3).

**D5 — Controlled server-side routes.** Three BFF routes — `POST /api/task-workspaces` (provision),
`GET /api/task-workspaces/:workspaceId`, and `POST /api/task-workspaces/:workspaceId/activate` —
register in the existing route table and inherit the server's global CSRF state-changing gate, exactly
like the #1387 command-runner routes. Domain failures map to the structured `TaskWorkspaceError`
taxonomy (invalid base, unsafe path, branch conflict, existing-unmanaged path, lock contention, missing
repository, pointer drift); responses are redacted before reaching the browser.

**D6 — Content-free lifecycle evidence (D4 deliverable).** Each provision / activate / block / fail /
retry-required outcome writes one evidence document through the shared `EvidenceStore.put` port with
`deepRedactStrings` defense-in-depth. The payload is a validated #444 `WorkspaceEvent` plus
counts/enums only — no repository root, worktree path, branch name, or command output. Because
`EvidenceTaskType` is a closed union, this is a self-describing content-free document keyed by the event
id (the memory-audit ledger pattern), not an `EvidenceManifest`.

**D7 — Deterministic failure handling that always leaves a visible classified state (SC4).** Pre-write
rejections (invalid base, conflict, unsafe path, existing-unmanaged, lock contention) throw **before**
any worktree or instance row is created — there is no partial state to classify. A failure **during**
the worktree mutation transitions the persisted instance to `failed`/`recovery-required` with the lock
released, performs a best-effort rollback of the half-created worktree, and emits the matching outcome.
An active/paused workspace whose worktree has vanished is flagged `recovery-required` (a legal contract
transition) rather than silently re-entering `provisioning` (which the contract forbids); repair is
owned by #447.

## Consequences

- The only new Git authority is the narrow worktree adapter; #470 remains the sole branch/commit/
  publish/PR/merge authority and keiko-workspace remains the sole containment authority.
- #446 consumes the `WorkspaceBinding` (where `gitDeliveryRoot === activeRoot === editorProjectRoot`);
  #447 builds restart reconcile/repair on top of the persisted instances and drift markers; #448–#450
  build health/cleanup/hardening/verification. None of them need a second persistence or mutation path.
- Provisioning is safe to retry: idempotent on success, completion-on-retry for an interrupted
  `provisioning` state, and drift-flagging for a vanished worktree.

## Alternatives Considered

- **A new `keiko-task-workspace` leaf package.** Rejected: the orchestration needs keiko-tools
  (`runCommand`), keiko-server (routes/persistence/evidence), keiko-evidence, and keiko-workspace — a
  leaf package may depend only on contracts (+ security/workspace), which would force broad
  dependency-cruiser changes for no boundary benefit. The server is the natural home.
- **Extending `GIT_MUTATION_COMMAND_RULES` with worktree subcommands.** Rejected: it would let a single
  rule set reach both worktree and branch/commit/restore write verbs, widening the #470 surface and
  violating AC5. A structurally separate rule set is the safer, auditable choice.
- **Embedding worktree state in the chat `UiStore`.** Rejected in favor of a dedicated store interface
  over the same DB handle, keeping the task-workspace boundary clean while sharing the single-writer
  transaction model.
