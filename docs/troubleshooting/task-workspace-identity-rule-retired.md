# Task Workspace Identity Rule Retired

Operator guidance for a managed task workspace that was registered under an identity rule Keiko no
longer mints. The entry follows the [troubleshooting entry template](./_template.md).

---

## Bind refused because the managed workspace was registered under a retired identity rule

| Field             | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Severity          | High                                                                    |
| Surface           | Local UI / Workspace                                                    |
| Stable identifier | `identity-schema-retired` (drift marker; `driftMarker` on the log line) |

**Symptom**

The Coding Workbench refuses to bind a repository that was bound before and reports that the
managed workspace already exists but could not be re-verified ("Identity rule retired"), with a
"Repair and bind" control. The Task workspaces panel lists the workspace as `recovery-required`
with the `identity-schema-retired` marker and a Repair action. On the activity log the startup
reconciliation and the refused provision carry `driftMarker: "identity-schema-retired"`.

Before 2026-09-03 the same condition surfaced as a bare 409 with the sentence "The workspace could
not be bound. Review the repository path and target branch.", the marker `pointer-stale` with an
`operator-repair` hint that no strategy could execute, and a `gitdir-mismatch` marker that the next
startup reconciliation wrote over it again.

**Root Cause**

Every managed worktree carries a content-free identity that proves it is the worktree Keiko
registered. The rule that mints that identity has changed twice: the original rule (before #3367)
hashed the `.git` pointer's target text, the second rule (#3367) bound the inodes of the pointer
files and directories, and the current rule (#3376) additionally binds their creation times.
Workspaces registered under an earlier rule cannot be proven under the current one — not
disproven either — so the server refuses to bind them until an operator re-registers them.

Until 2026-09-03 only the second rule was recognised as retired; a workspace registered under the
original rule was reported as a REPLACED worktree, which is a false statement about the disk, and
its recovery hint named a strategy the repair service never executes.

**Diagnostic Steps**

1. Read the activity log for the workspace: a `task-workspace.lifecycle` line with
   `operation: "reconcile"` or `"provision"`, `errorKind: "POINTER_DRIFT"` or `"stale-pointer"`,
   and `driftMarker: "identity-schema-retired"`. The marker is the classification; the log never
   carries the identity value or the path.
2. `GET /api/task-workspaces/reconciliation` shows the entry with status `stale-pointer`, the
   marker, and the hint `{ strategy: "reconcile-pointer", operatorActionRequired: false }`.
3. A marker of `gitdir-mismatch` instead means the pointer is readable but proves a DIFFERENT
   identity (the worktree was replaced or relinked); `pointer-stale` means the pointer is missing
   or malformed. Both are distinct incidents from the migration this page describes.

**Resolution**

Re-register the workspace under operator approval: "Repair and bind" in the Coding Workbench setup
card, or "Repair" in the Task workspaces panel, or
`POST /api/task-workspaces/:workspaceId/repair` with `strategy: "reconcile-pointer"` and
`operatorApproved: true`. The repair re-materialises the existing worktree in place (no recreate, no
data loss), reissues the identity under the current rule, and returns the workspace to `active`.
The retired identity is never accepted automatically: a same-path replacement reproduces it exactly,
so the operator's approval is what stands in for the proof. Inspect the tree before approving if
its provenance is in doubt.
