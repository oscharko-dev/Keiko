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
stays inside it: the editor-agent path boundary refused every edit as an escape, the verification
runner required a registered project row for the worktree and answered `PROJECT_NOT_FOUND`, and
script trust was looked up for the worktree instead of the repository it was bound from. Separately,
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
values; the Coding Workbench re-reads its source without a reload. For `WORKSPACE_TRUST_REQUIRED`,
grant workspace script trust to the repository the task workspace was bound from (Settings →
Security, or the editor's verification panel); its task worktrees inherit that grant.
