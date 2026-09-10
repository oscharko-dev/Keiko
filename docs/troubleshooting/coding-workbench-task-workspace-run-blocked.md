# Coding Workbench Run Blocked Inside a Task Workspace

Operator guidance for a governed coding run that binds and starts but cannot edit or verify inside
its managed task workspace. The entry follows the [troubleshooting entry template](./_template.md).

---

## Every edit is refused as out of scope, or every verification fails without a reason

| Field             | Value                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Severity          | High                                                                                            |
| Surface           | Local UI / Workspace                                                                            |
| Stable identifier | `workspace-boundary-escape`, `WORKSPACE_TRUST_REQUIRED`, `PROJECT_NOT_FOUND`, `no-tool-calling` |

**Symptom**

The run starts, the agent reads the workspace and asks for the edit approval, and after "Approve
once" the timeline shows `keiko_changeset_edit · Failed`; the agent submits the same change again.
Or the edit lands but `keiko_verification · Failed` follows every approval and the agent reports
that the test runner returned `WORKSPACE_TRUST_REQUIRED` or `PROJECT_NOT_FOUND`. Before either, the
Model source chip may read "Keiko Gateway — Unavailable" with the setup note "Model source
unavailable." although the gateway is configured.

Before 2026-09-03 all three surfaced without a reason: the model received a bare `failed`, the
editor audit feed (`GET /api/editor/agent/audit`) carried `disposition: "denied", denyReason:
"workspace-boundary-escape"`, and the activity log carried nothing at all.

**Root Cause**

Managed task worktrees live below the state directory's always-denied segment
(`~/.keiko/ui/task-workspaces/…`, `.keiko/dev/ui/task-workspaces/…` in the dev lane). Three
consumers re-admitted that root with the user-workspace rules instead of asking whether a path
stays inside it: the editor-agent path boundary refused every edit as an escape, and the
verification runner treated the worktree as an ordinary project — without a project row it answered
`PROJECT_NOT_FOUND`, and with the row production registers at provisioning it took package-script
trust from the worktree's own record (derived once at provisioning, never on a later activation) and
answered `WORKSPACE_TRUST_REQUIRED` instead of asking the repository it was bound from. Separately,
a gateway capability saved before tool-calling verification existed is downgraded to
`toolCalling: false` until a readiness check records a fresh verification, and the Coding Workbench
did not name that reason.

**Diagnostic Steps**

1. Activity log: `op: "coding-runtime.editor-changeset"` with `diagnosticSummary:
"edit-refused"` and `errorKind` set to the editor conflict code, or `op:
"coding-runtime.verification"` with `"verification-refused"` and `errorKind` set to the runner
   code (`WORKSPACE_TRUST_REQUIRED`, `PROJECT_NOT_FOUND`, `NO_RUNNABLE_STEPS`). Both carry the run
   id as `correlationId`.
2. `GET /api/editor/agent/audit` lists the refused `applyChangeset` with its `denyReason` or
   `conflictCode`.
3. `GET /api/coding-sidecar/gateway/profile` answers `{ "status": "unavailable", "reason":
"no-tool-calling" }` when the chat model has no current tool-calling verification; the Coding
   Workbench setup card and the source card now print that reason.

**Resolution**

Update to a build that contains the 2026-09-03 repair; nothing has to be migrated. For the gateway
reason, open Settings → Models, run the readiness check for the chat model and apply the verified
values; the Coding Workbench re-reads its source without a reload.

For `WORKSPACE_TRUST_REQUIRED`, grant workspace script trust to the repository the task workspace
was bound from. Two surfaces do it:

- **Settings → Security → Workspace Trust → "Open Workspace Trust"**, then "Trust" on the
  repository's row in the panel that opens and confirm in the "Trust this workspace?" dialog. The
  panel lists every registered workspace root, so this is the surface to use when the repository is
  not the one currently open.
- The editor's verification panel, for the root the editor is already on.

The grant is recorded for the REPOSITORY root, and a task worktree runs its scripts under that grant
only while the worktree's `package.json` is byte-identical to the repository's. That is what the
grant is bound to (ADR-0147 D3), and a governed run may edit `package.json` inside its own worktree:
the runner compares the two manifests before every verification and answers
`WORKSPACE_TRUST_REQUIRED` when they differ, rather than spawning a rewritten script under a
decision the human made about different bytes. Re-granting trust does not clear this: the grant the
runner reads is always the repository's. Bring the two manifests back into agreement — land the
worktree's `package.json` change in the repository, or revert it in the worktree — and the runner
admits the scripts again. An unreadable manifest on either side fails closed the same way.

---

## Binding a trusted repository fails with "The workspace could not be bound", every time

| Field             | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| Severity          | High                                                                 |
| Surface           | Local UI / Coding Workbench setup                                    |
| Stable identifier | `PROVISIONING_FAILED`, `task-workspace.lifecycle`, `PathDeniedError` |

**Symptom**

"Bind workspace" fails within a second for a repository whose workspace trust was granted. Before
2026-09-10 the setup card said "The workspace could not be bound. Review the repository path and
target branch." although both were accepted; it now says that Keiko could not create the managed
task workspace. The repository shows a `keiko/task/…` branch that was created and no worktree for
it: `git worktree add` succeeded and the worktree was rolled back again. A repository without a
trust grant binds fine, which is what made the failure look like a repository problem.

**Root Cause**

Managed task worktrees live below the state directory's always-denied segment
(`~/.keiko/ui/task-workspaces/…`; `.keiko/dev/ui/task-workspaces/…` in the dev lane). When the
repository is trusted, provisioning derives the worktree's own package-script trust from the
repository's grant (ADR-0147). That derivation resolved the worktree's canonical root through the
user-workspace root rules (`detectWorkspaceAt`), which refuse any root below `.keiko`; the refusal
(`PathDeniedError`) surfaced as `PROVISIONING_FAILED` after the worktree had been created, and the
settled `task-workspace.lifecycle` line carried only that code — the cause chain the rethrow path
would have logged was suppressed as a duplicate, so the log named no cause. The 2026-09-03 repair
had corrected the same re-admission for the editor-agent boundary and the verification runner;
script trust was the remaining consumer.

**Diagnostic Steps**

1. Activity log: `op: "task-workspace.lifecycle"` with `extra.operation: "provision"`,
   `extra.outcome: "failed"`, `errorKind: "PROVISIONING_FAILED"`, and — since 2026-09-10 —
   `extra.causeChain` naming the failing class (`PathDeniedError` for this defect) plus the Keiko
   frames of the failing call, all under the bind request's `correlationId`.
2. `git -C <repository> branch --list 'keiko/task/*'` lists the task branch while
   `git worktree list` shows no worktree for it.
3. Settings → Security → Workspace Trust lists the repository as "Trusted workspace"; an untrusted
   copy of the same repository binds successfully.

**Resolution**

Update to a build that contains the 2026-09-10 repair: the script-trust service is composed with
the managed root and resolves a registered project below it as its own workspace root, exactly as
the other managed-root consumers do. Nothing has to be migrated; delete the leftover
`keiko/task/…` branch (or let the next bind reuse it — the branch name is deterministic per issue)
and bind again. If the failure persists, the new `causeChain` on the lifecycle line names the actual
cause.

---

## "Start coding run" fails immediately with `CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED`

| Field             | Value                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Severity          | High                                                                                                          |
| Surface           | Local UI / Coding Workbench                                                                                   |
| Stable identifier | `authority-resolution-failed`, `git.runtime-identity`, `GitLazyFetchGuardUnsupportedError`, `PathDeniedError` |

**Symptom**

The workspace binds, the composer is ready, and "Start coding run" answers within a second with
"The requested runtime action failed (CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED)" and a support id.
Nothing was launched. Before 2026-09-10 the support id led to a single `coding-runtime.operation.refused`
line and the run-scoped lines that held the cause carried a different correlation id.

**Root Cause**

Run start reads the repository identity of the managed task worktree through the keiko-tools Git
read lane. Every lane's spawn boundary resolves the command's working directory through the
user-workspace root rules with the plain filesystem port, which deny the state directory's `.keiko`
segment the worktree lives below (`~/.keiko/ui/task-workspaces/…`, `.keiko/dev/ui/task-workspaces/…`
in the dev lane) — so the read, and with it every other Git command inside the worktree, was refused
before spawn. The lazy-fetch guard's probes swallowed that refusal as "cannot rule out a promisor
remote" and then as an indeterminate version probe, reporting `GitLazyFetchGuardUnsupportedError`
for a guard that was never involved; the orchestrator mapped the unrecognised throw to
`authority-resolution-failed`. The server's managed-root prover (ADR-0005 D2) minted an owned-root
port for the worktree, but only the `WorkspaceInfo` projection reached the lanes.

**Diagnostic Steps**

1. Activity log, request correlation (the support id): `op: "coding-runtime.operation.refused"`,
   `extra.operation: "start"`, `extra.reason: "authority-resolution-failed"` and — since 2026-09-10 —
   `extra.runId` naming the run that was minted.
2. Activity log, that run id: `op: "git.runtime-identity"` with `state: "failed"`, the failing class
   in `errorClass` and its Keiko frames; then `op: "coding-runtime.start"` with
   `code: "stage=start:reason=launch-resolution"`. Since the repair the class is the boundary's own
   (`PathDeniedError`, `CommandDeniedError`), never a relabelled guard verdict.
3. `keiko support analyze --correlation-id <run id> --json` reconstructs the sequence; the request
   correlation alone reconstructs only the refusal.

**Resolution**

Update to a build that contains the 2026-09-10 repair: the prover binds the owned-root port to the
worktree's `WorkspaceInfo` and the spawn boundary resolves through it, so every Git lane runs under
the root's own authority. Nothing has to be migrated; start the run again.
