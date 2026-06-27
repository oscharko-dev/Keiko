# Task-Workspace Operator Runbook

This runbook is for maintainers and operators who provision, activate, switch, repair, and clean up task workspaces.
It assumes the Epic #443 implementation is present and verified by the [verification matrix](443-verification-matrix.md).

## Concepts operators must know

### Managed worktree

A task workspace is backed by a Git worktree created in a managed root directory (`task-workspaces/<workspaceId>`) inside the project repository.
The worktree has its own branch, HEAD, and working tree state, isolated from the main checkout.

### Active pointer and WorkspaceBinding

At any moment, zero or one task workspace may be **active** for a given repository.
The active pointer is a singleton record (workspaceId, setBy, setAt) persisted in the server database.
All bound surfaces (Files, editor, terminal, Git Delivery, runtime) read the active workspace id and derive a **WorkspaceBinding** from the active instance.
The binding contains three coordinates that must always be the same:

- `activeRoot` — the managed worktree path on disk
- `gitDeliveryRoot` — the root used for all Git mutations (commits, pushes, branches)
- `editorProjectRoot` — the root passed to the language server

All three are derived from a single source: the `managedWorktreePath` of the active `WorkspaceInstance` (see `binding.ts:19–29`).
There is one derivation, never a recomputed second copy.

### Git mutations stay governed by Epic #470

When you switch an active workspace, only the root coordinates are retargeted.
Git Delivery policy, approval, and evidence semantics remain unchanged (see [#470 reuse proof](../git-delivery/verification-matrix.md#requirement-1-git-mutations-governed-by-epic-470-root-retargeting-only)).
The server never infers a workspace from the active pointer when processing a Git mutation; the browser sends the active root as `projectId` in the request body.
The terminal remains read-only (see `packages/keiko-tools/src/terminal-policy.ts`).

### Workspace health classifications (10 states)

| Classification        | Operator meaning                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **healthy**           | Worktree exists, branch exists, HEAD points to task branch, no uncommitted changes, no lock held by other actors. Safe to activate, pause, repair, or clean.                                                                                                                                                   |
| **dirty**             | Worktree is structurally healthy but has uncommitted or untracked changes. Can be paused/archived, but cleanup is blocked (refusal: `worktree-dirty`). Handoff-ready requires cleanup first.                                                                                                                   |
| **drifted**           | Worktree is tracked, but branch/HEAD/gitdir state differs from persisted record. Repair can reattach or recreate. Health remains `drifted` until repair runs.                                                                                                                                                  |
| **missing**           | Persisted instance exists but the worktree directory has been deleted externally. Repair can recreate it or cleanup can remove the orphaned record.                                                                                                                                                            |
| **stale-pointer**     | The active pointer references an instance that no longer exists (row deleted, worktree gone). Reconciliation never silently chooses a replacement; operator must `setActive` to a known instance.                                                                                                              |
| **locked**            | An advisory lock is held by another actor (another process, another user, or a recovery action). Operator must wait for the lock to TTL-expire (default 5 minutes) or manually release it.                                                                                                                     |
| **orphaned**          | A managed worktree directory exists on disk with no persisted instance record. Orphan detection offers cleanup. Operator can remove the directory or re-provision the task.                                                                                                                                    |
| **archived**          | Instance is in `archived`, `merged`, `abandoned`, or `failed` lifecycle state. Archived workspaces can be cleaned up without transitioning the workspace itself (no activation required).                                                                                                                      |
| **cleanup-ready**     | Instance is in an eligible cleanup state (`archived`, `merged`, `abandoned`, `failed`, or `cleanup-pending`), the worktree is not currently locked, is not dirty, has a valid ownership marker, and the realpath is within the managed root. The cleanup-safety gate passes; cleanup can complete immediately. |
| **recovery-required** | Worktree or persisted state is damaged in a way that requires operator-approved repair before cleanup or activation. Example: `git status` fails, .git pointer is corrupted, branch is missing.                                                                                                                |

### Workspace failure classes (5 classes)

| Failure class     | Operator action                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **retryable**     | Transient contention or a live lock held by another actor that will TTL-expire. The same request may succeed if retried as-is. Example: `LOCK_CONTENTION` from another in-flight provisioning of the same task. Retry or wait 5 minutes. |
| **repairable**    | Drift, partial state, or stale metadata. A bare retry would hit the same condition. Route to [#447 repair](#repair-runbooks). Example: pointer to a deleted worktree, HEAD moved externally, .git corrupted.                             |
| **blocked**       | Precondition, validation, or conflict gate. The caller must change inputs or environment. Do not retry unchanged. Examples: base branch does not exist, task name is invalid, worktree path already exists (namespace collision).        |
| **policy-denied** | Authority or approval gate (operator approval required). No mutation has executed. Surface the approval request; no retry until operator approves.                                                                                       |
| **terminal**      | Non-recoverable server fault (file permission error, database corruption, disk full). Out-of-band intervention required. Do not retry.                                                                                                   |

---

## Normal operating flow

1. **Provision a task workspace.**
   - Call `POST /api/task-workspaces` with `{ repositoryRequestPath | repositoryId, taskId, baseBranch, requestedBy }`.
   - Returns the provisioned/resumed WorkspaceInstance (lifecycleState `active`; `created` is true on first provision, false on idempotent resume).
   - Failure: see [failure diagnosis table](#troubleshooting) for `PROVISIONING_FAILED`, `BRANCH_CONFLICT`, `INVALID_BASE_BRANCH`, etc.

2. **Activate the workspace** (if not already active).
   - Call `POST /api/task-workspaces/:id/activate` or `POST /api/task-workspaces/active` with `{workspaceId}`.
   - Returns the active `WorkspaceBinding` with coordinates (activeRoot, gitDeliveryRoot, editorProjectRoot).
   - All bound surfaces (Files, editor, terminal, Git Delivery) immediately retarget to this workspace.
   - Failure: see [failure diagnosis table](#troubleshooting) for `ILLEGAL_TRANSITION`, `LOCK_CONTENTION`, etc.

3. **Perform Git operations.**
   - All Git mutations (commit, push, branch, merge, PR) run through Epic #470 governed flows.
   - They read the active root from the browser context (not from the server active pointer).
   - Example: to commit, the UI sends `projectId: activeRoot` to `POST /api/git-delivery/commit/execute`.

4. **Pause the workspace.**
   - Call `POST /api/task-workspaces/:workspaceId/pause`.
   - Clears the active pointer; other surfaces fall back to the project root.
   - The worktree remains on disk and is **not** locked; other processes can activate a different workspace or the project root.
   - The instance lifecycle moves to `paused`.

5. **Resume from paused.**
   - Call `POST /api/task-workspaces/:id/activate`.
   - Re-establishes the active pointer and binding.
   - Surfaces retarget to the resumed workspace.

6. **Switch between workspaces.**
   - Call `POST /api/task-workspaces/active` with `{ workspaceId: newId }`.
   - Atomically clears the old active pointer and sets the new one.
   - All surfaces retarget in one RPC; no transient mixed context.

7. **Prepare for handoff.**
   - Call `POST /api/task-workspaces/:workspaceId/handoff` while the workspace is active.
   - Blocks if the worktree has uncommitted changes (refusal: `worktree-dirty`).
   - Moves the instance to `handoff-ready` state; the active pointer is **not** cleared.
   - A handoff-ready workspace can still be paused, resumed, or repaired, but not activated for new work.

8. **Archive and cleanup.**
   - Once a workspace is settled (`archived`, `merged`, `abandoned`, `failed`), or if it fails to provision, call `GET /api/task-workspaces/health` to confirm it is in a cleanup-eligible state.
   - Call `POST /api/task-workspaces/:id/cleanup` with `{ mode: "request" }` to begin cleanup.
   - Operator approval may be required (policy-gated cleanup for high-risk repositories).
   - Once approved, call `POST /api/task-workspaces/:id/cleanup` with `{ mode: "complete" }`.
   - The cleanup service checks ownership, lock state, dirty state, and realpath containment, then removes the worktree and deletes the instance row.
   - If the cleanup-safety gate **refuses** (reasons: `ownership-unproven`, `path-escape`, `lock-live`, `worktree-dirty`, `not-eligible-state`), the workspace is **not** removed; see [cleanup refusals](#cleanup-safety-gates) to understand why and how to resolve.

---

## Recovery runbooks

### Diagnosis: reconciliation and health reports

Before attempting recovery, always run:

1. **Get the stored reconciliation report:**

   ```
   GET /api/task-workspaces/reconciliation
   ```

   Returns a read-only snapshot of the last reconciliation pass (at startup or operator-triggered).
   Fields: `healthClassifications` (map of id → health), `reconciliationEntry` (map of id → status + drift markers).

2. **Trigger live reconciliation (if needed):**

   ```
   POST /api/task-workspaces/reconciliation
   ```

   Scans the file system and database in real-time, classifies each instance, and stores the result.
   May take 1–2 seconds for N=200 instances.

3. **Get the health report:**

   ```
   GET /api/task-workspaces/health
   ```

   Returns the 10-state health classification for every instance (cached from reconciliation; re-run reconciliation if stale).

4. **Check the instance:**
   ```
   GET /api/task-workspaces/:id
   ```
   Returns the instance record: lifecycle state, branch, HEAD commit, lock (if any), evidence summary (hashed, content-free).

---

### Recovery by failure class

#### Retryable failures (lock contention, transient failures)

**Symptom:** `error.code ∈ { LOCK_CONTENTION }` with `failureClass: "retryable"`.

**Diagnosis:**

- Run `GET /api/task-workspaces/:id`. If `lock` is set and `lock.expiresAt > now`, another actor holds the workspace.
- If no lock, the provisioning or lifecycle mutation failed transiently (e.g., network, disk full, race with external Git operation).

**Operator action:**

- If lock is present, wait for it to TTL-expire (default 5 minutes) or manually release it (see [stale-lock recovery](#stale-locks)).
- Retry the original request (same parameters) after waiting.

**Example:**

```
# Provision races with another provisioner
POST /api/task-workspaces { repositoryRequestPath, taskId, baseBranch, requestedBy }
→ { error: "LOCK_CONTENTION", failureClass: "retryable" }

# Wait for lock to expire or release it manually
GET /api/task-workspaces/:id
→ { lock: { owner: "actor-2", expiresAt: "2026-06-27T12:15:00Z" } }

# After expiry, retry
POST /api/task-workspaces { repositoryRequestPath, taskId, baseBranch, requestedBy }
→ { id, lifecycleState: "active", … }
```

---

#### Repairable failures (drift, partial state, stale pointers)

**Symptom:** `error.code ∈ { POINTER_DRIFT }` with `failureClass: "repairable"`. Missing or stale-pointer conditions surface via the reconciliation report `status` and `driftMarkers`, not as thrown error codes.

**Diagnosis:**

- Run `GET /api/task-workspaces/:id`. Inspect the lifecycle state and compare it to the actual worktree on disk.
- Run `POST /api/task-workspaces/reconciliation` and check the `reconciliationEntry` for `status` and `driftMarkers`.
- Common markers: `missing-worktree`, `stale-pointer`, `branch-deleted`, `head-moved`, `gitdir-broken`.

**Recovery strategies:**

##### Recreate the worktree (missing worktree)

**When:** `status: "missing"` (worktree was deleted, instance row remains).

**Operator action:**

- Call `POST /api/task-workspaces/:id/repair` with `strategy: "recreate-worktree"`.
- This re-runs `git worktree add` using the stored branch name and base commit.
- The worktree is locked during repair; other mutations are blocked (retryable).

**Example:**

```
# Worktree was deleted externally
GET /api/task-workspaces/:id
→ { id, status: "active", branch: "task/123", lock: { reason: "repair" } }

POST /api/task-workspaces/:id/repair
→ { strategy: "recreate-worktree", outcome: "completed", health: "healthy" }

# Worktree now exists, instance is active and healthy
```

##### Reattach the branch (HEAD moved, gitdir corrupted)

**When:** `driftMarker ∈ { head-moved, gitdir-broken }` (the .git pointer or branch state is stale).

**Operator action:**

- Call `POST /api/task-workspaces/:id/repair` with `strategy: "reattach-branch"`.
- This re-links the .git worktree pointer to the correct .git/worktrees directory and checks out the task branch.
- Use this if the branch still exists in the repository but the worktree lost track.

**Example:**

```
POST /api/task-workspaces/:id/repair { strategy: "reattach-branch" }
→ { outcome: "completed", health: "healthy" }
```

##### Release a stale lock (lock held by dead process)

**When:** `health: "locked"` and `lock.expiresAt < now` (lock TTL expired but never cleared).

**Operator action:**

- Call `POST /api/task-workspaces/:id/repair` with `strategy: "release-stale-lock"`.
- This clears the expired lock from the instance record.
- Only runs if the lock's expiration time is in the past.

**Example:**

```
# Lock expired 1 hour ago
GET /api/task-workspaces/:id
→ { lock: { owner: "crashed-actor", expiresAt: "2026-06-27T11:00:00Z" } }

POST /api/task-workspaces/:id/repair { strategy: "release-stale-lock" }
→ { outcome: "completed", health: "healthy" }

# Lock cleared
```

##### Reconcile the active pointer (stale-pointer health)

**When:** `health: "stale-pointer"` (active pointer references a non-existent instance).

**Operator action:**

- Call `POST /api/task-workspaces/reconciliation` to refresh the health report.
- Call `GET /api/task-workspaces/active` to see the current stale active pointer.
- Call `POST /api/task-workspaces/active` with `{ workspaceId: newId }` to explicitly set the active workspace to a known healthy instance.
- Or call `DELETE /api/task-workspaces/active` to clear the active pointer and revert to the project root.

**Note:** Reconciliation **never** silently chooses an active workspace. If multiple instances exist and the active pointer is stale, the operator must explicitly select which one to activate.

**Example:**

```
# Active pointer is stale
GET /api/task-workspaces/active
→ { activeBinding: null, activeRestoration: { kind: "ambiguous", reason: "multiple candidates" } }

# Operator explicitly chooses
POST /api/task-workspaces/active { workspaceId: "ws-789" }
→ { activeBinding: { activeRoot: "/repo/task-workspaces/ws-789", … } }
```

---

#### Blocked failures (preconditions, conflicts)

**Symptom:** `error.code ∈ { ILLEGAL_TRANSITION, BRANCH_CONFLICT, INVALID_BASE_BRANCH, UNSAFE_PATH, EXISTING_UNMANAGED_PATH, MISSING_REPOSITORY, WORKSPACE_NOT_FOUND, CLEANUP_NOT_ELIGIBLE, REPAIR_NOT_APPLICABLE, INVALID_REQUEST }` with `failureClass: "blocked"`.

**Diagnosis:**

- Blocked errors are self-documenting. Read the error message for the specific gate that rejected the request.
- Examples:
  - `ILLEGAL_TRANSITION`: trying to activate a workspace that is already `archived` or `failed`.
  - `BRANCH_CONFLICT`: provisioning a task whose branch name already exists in the repository.
  - `INVALID_BASE_BRANCH`: the base branch does not exist or is protected (e.g., `main`, `dev`).

**Operator action:**

- Do not retry. Fix the named blocker:
  - Choose a different branch or base.
  - Transition the workspace to a valid state (e.g., archive an active workspace before deleting it).
  - Confirm the base branch exists and is not protected.

---

#### Policy-denied failures (approval required)

**Symptom:** `error.code ∈ { OPERATOR_APPROVAL_REQUIRED }` with `failureClass: "policy-denied"`.

**Diagnosis:**

- The workspace or cleanup operation is gated by repository policy (e.g., cleanup of a high-risk repository requires multi-person approval).
- Run `GET /api/task-workspaces/:id` and check the `approvalRequired` field.

**Operator action:**

- Request approval from the authorized governance team.
- Once approved, retry the operation with the approval token.
- No mutation is attempted until approval is granted; no evidence is recorded for a denied request.

---

#### Terminal failures (non-recoverable errors)

**Symptom:** `error.code ∈ { PROVISIONING_FAILED, REPAIR_FAILED, CLEANUP_FAILED }` with `failureClass: "terminal"`.

**Diagnosis:**

- These are server faults that occurred after a mutation was authorized.
- Examples: file permission error during worktree creation (`PROVISIONING_FAILED`), repair mutation errored after authorization (`REPAIR_FAILED`), governed physical removal failed after safety gate passed (`CLEANUP_FAILED`).

**Operator action:**

- Investigate the server logs and infrastructure.
- Fix the underlying issue (restore database, fix file permissions, free disk space).
- Do not retry the request until the fault is resolved.

---

### Troubleshooting table

| Symptom                                                                                                   | Likely cause                                                                                                         | Operator action                                                                                                                                                                                                                            | Evidence                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /api/task-workspaces` returns `LOCK_CONTENTION` with `failureClass: "retryable"`                    | Another provisioner is racing for the same task.                                                                     | Wait 5 minutes or run `GET /api/task-workspaces/:id` and check if `lock.expiresAt` is in the future. Retry after lock expires or manually release it.                                                                                      | Check `reconciliation.entry[id].status` and `lock.owner`.                                                               |
| `POST /api/task-workspaces` returns `BRANCH_CONFLICT` with `failureClass: "blocked"`                      | The task branch name collides with an existing branch.                                                               | Choose a different task id (generates a different branch name) or delete the conflicting branch externally and retry.                                                                                                                      | Inspect the error message for the conflicting branch name.                                                              |
| `POST /api/task-workspaces/:id/activate` returns `ILLEGAL_TRANSITION`                                     | The workspace is not in an activatable state (e.g., `archived`, `failed`, `cleanup-pending`).                        | Check `GET /api/task-workspaces/:id` for the current lifecycle state. Transition the workspace to `created` or `paused` before activating (or provision a new one).                                                                        | Read the error message for the current state and required state.                                                        |
| `GET /api/task-workspaces/health` shows `health: "missing"`                                               | The worktree was deleted externally but the instance record persists.                                                | Run `POST /api/task-workspaces/:id/repair { strategy: "recreate-worktree" }` to restore the worktree, or run `POST /api/task-workspaces/:id/cleanup` to remove the orphaned record.                                                        | Check `reconciliation.entry[id].driftMarkers` for `missing-worktree`.                                                   |
| `GET /api/task-workspaces/health` shows `health: "locked"`                                                | Another actor holds an advisory lock on the workspace.                                                               | Wait for the lock to TTL-expire (check `lock.expiresAt`), or run `POST /api/task-workspaces/:id/repair { strategy: "release-stale-lock" }` if the lock is stale.                                                                           | Check `instance.lock.owner` and `lock.expiresAt` to determine if the lock is live or expired.                           |
| `GET /api/task-workspaces/health` shows `health: "dirty"`                                                 | The worktree has uncommitted changes.                                                                                | Commit or stash the changes in the worktree, then retry the operation. If preparing for handoff or cleanup, run `git -C <worktree> stash` from the terminal.                                                                               | Run `git -C <activeRoot> status` to see uncommitted changes.                                                            |
| `GET /api/task-workspaces/health` shows `health: "drifted"`                                               | The worktree state (branch, HEAD, .git pointer) does not match the persisted record.                                 | Run `POST /api/task-workspaces/:id/repair` with the strategy suggested by the drift marker (e.g., `reattach-branch` or `recreate-worktree`).                                                                                               | Check `reconciliation.entry[id].driftMarkers` for the specific drift type.                                              |
| `POST /api/task-workspaces/:id/cleanup` returns `{ outcome: "refused", refusalReason: "worktree-dirty" }` | The worktree has uncommitted changes and cleanup is blocked (SC4 safety gate).                                       | Commit or stash changes: `git -C <activeRoot> stash`, then retry cleanup. Or transition the workspace to `paused`/`archived` before cleaning up.                                                                                           | Run `git -C <activeRoot> status` to inspect uncommitted changes. Cleanup refusals are first-class outcomes, not errors. |
| `POST /api/task-workspaces/:id/cleanup` returns `{ outcome: "refused", refusalReason: "lock-live" }`      | Another actor holds an advisory lock.                                                                                | Wait for the lock to TTL-expire or run `POST /api/task-workspaces/:id/repair { strategy: "release-stale-lock" }` if expired, then retry cleanup.                                                                                           | Check `instance.lock.expiresAt`; if it's in the past, release it; otherwise wait.                                       |
| `POST /api/task-workspaces/:id/cleanup` returns `{ outcome: "refused", refusalReason: "path-escape" }`    | The worktree path is outside the managed root (SC4 safety gate).                                                     | Do not clean up this instance. Investigate how the path was set to a location outside the managed root (likely a data corruption or operator manual path edit). File a support ticket.                                                     | This refusal is a sign that the database or filesystem is in an inconsistent state; do not force-delete.                |
| `GET /api/task-workspaces/active` returns `activeRestoration: { kind: "ambiguous" }`                      | The active pointer is stale or missing, and multiple instances exist; reconciliation cannot choose.                  | Explicitly call `POST /api/task-workspaces/active { workspaceId: <known-id> }` or `DELETE /api/task-workspaces/active` to reset the active pointer.                                                                                        | Reconciliation provides hints on which instances are healthy. Operator must make the choice.                            |
| Files surface does not retarget after `POST /api/task-workspaces/active { workspaceId }`                  | Browser context is out of sync; active pointer was updated server-side but the client UI did not receive the update. | Refresh the browser page (`Cmd+R` / `Ctrl+R`). The UI will re-fetch the active binding and retarget all surfaces.                                                                                                                          | Check the Network tab in browser dev tools; confirm `GET /api/task-workspaces/active` returns the new binding.          |
| Terminal in the active workspace is running commands from the project root, not the worktree              | Active pointer was cleared or workspace was paused.                                                                  | Check `GET /api/task-workspaces/active`; if `activeBinding: null`, the workspace is not active. Call `POST /api/task-workspaces/:id/activate` to re-activate.                                                                              | The terminal shows the working directory; it should be `<managedRoot>/<workspaceId>`.                                   |
| Git Delivery commit/push/merge routes return `WORKSPACE_NOT_FOUND`                                        | The browser sent a stale `projectId` (active workspace changed after the request was issued).                        | This is rare but possible if the UI is very slow to update. The request carries the stale projectId; the server authorizes it against the stale root (which no longer exists or is not a valid repository). Refresh the browser and retry. | Check the request body `projectId` in the Network tab and compare it to the current active root.                        |

---

### Cleanup safety gates

The cleanup-safety gate is the final protection before physical removal. It checks five conditions in this order; **any refusal blocks cleanup**:

| Refusal reason       | Condition                                                                                       | Operator recovery                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-eligible-state` | Workspace is not in one of: `archived`, `merged`, `abandoned`, `failed`, `cleanup-pending`.     | Transition the workspace to a settled state before cleanup (e.g., call `POST /api/task-workspaces/:id` with `action: "archive"` if the route supports it). Do not cleanup active/paused/recovery-required workspaces.        |
| `worktree-dirty`     | `git status` reports uncommitted or untracked changes.                                          | Commit or stash changes: `git -C <activeRoot> commit …` or `git -C <activeRoot> stash`. Then retry cleanup.                                                                                                                  |
| `lock-live`          | An advisory lock is held and has not expired (SC2).                                             | Wait for `lock.expiresAt` to pass, or call `POST /api/task-workspaces/:id/repair { strategy: "release-stale-lock" }` if the lock is expired. Then retry cleanup.                                                             |
| `ownership-unproven` | The worktree directory lacks the `.keiko-managed` ownership marker, or the marker is corrupted. | This indicates a workspace was created outside Keiko or the managed root was tampered with. Do not force-delete; file a support ticket. Keiko never created this directory, and forced removal could delete user data (SC1). |
| `path-escape`        | The worktree realpath is outside the repository's managed root (SC4).                           | This is a data corruption or operator mistake. Do not force-delete. File a support ticket. Keiko prevents this at provisioning time; its presence indicates the database or filesystem is corrupt.                           |

Cleanup refusals are **first-class outcomes**, not errors. The response is `{ outcome: "refused", reasons: […] }`, not a thrown error. The operator surfaces the refusal and takes manual action (commit changes, release lock, etc.). No retry is attempted until the blocker is resolved.

---

### Ambiguous active workspace (activeRestoration: "ambiguous")

**Scenario:** After restart, the stored active pointer references a workspace id that no longer exists (the instance row was deleted), **and** multiple other healthy instances exist.

**Behavior:**

- Reconciliation cannot deterministically choose among the candidates.
- `GET /api/task-workspaces/active` returns `{ activeBinding: null, activeRestoration: { kind: "ambiguous", candidates: […] } }`.
- The active pointer is cleared; all surfaces fall back to the project root.

**Operator action:**

- Review the candidate workspaces. `candidates` includes the id, branch, health, and last-activity timestamp.
- Explicitly call `POST /api/task-workspaces/active { workspaceId: <chosen-id> }` to set the active workspace.
- Or call `DELETE /api/task-workspaces/active` to remain on the project root (no active workspace).

**Why reconciliation does not guess:**

- Silently choosing the "most recent" candidate could activate the wrong workspace and corrupt work.
- The operator is always the source of truth for which workspace was being worked on.

---

## Evidence interpretation

Lifecycle evidence is **content-free** and stored for audit/compliance purposes.

### Fields operators can rely on:

- **workspaceId** — the opaque workspace identifier (no structure, no correlation to task name or branch).
- **actor** / **setBy** — the identity that initiated the mutation (username, API key id, or service account id).
- **lifecycle state** — the current state (e.g., `active`, `paused`, `archived`).
- **driftMarkers** — a list of detected drift types (e.g., `["missing-worktree", "head-moved"]`), no values or paths.
- **lockOwner** — the identity holding an advisory lock (operator or process name, no details).
- **lockExpiresAt** — timestamp of when the lock will auto-release.
- **eventType** — what mutation occurred (e.g., `provisioned`, `activated`, `cleanup-requested`).
- **outcome** — the result (e.g., `completed`, `refused`, `failed-retryable`, `failed-terminal`).
- **refusalReasons** — why cleanup/repair was refused (e.g., `["worktree-dirty", "lock-live"]`).
- **recoveryStrategy** — the repair strategy applied (e.g., `recreate-worktree`, `release-stale-lock`).

### Fields operators should NOT rely on:

- **Repository paths, branch names, commit SHAs** — redacted in evidence.
- **Source text, file contents** — never stored (content-free invariant, SC3).
- **Raw Git stderr/stdout** — normalized to typed failure codes.

Evidence is designed so compliance/audit teams can detect **that** a mutation occurred and **who** requested it, without seeing project details.

---

## Prerequisites and limits

### System requirements

1. **Git must be installed** (`git --version` must succeed). Keiko spawns `git` commands to create, inspect, and repair worktrees.

2. **Managed root must be writable** (the `task-workspaces/` directory inside the repository). File system permissions must allow the Keiko process to create, modify, and delete worktree directories.

3. **Database must be reachable.** The task-workspace persistent store is a SQLite database (path configured at deployment). It must be readable and writable.

### Concurrency model

- **In-process mutex:** Keiko uses an in-process async mutex to serialize mutating operations on the same workspace. It prevents TOCTOU (check-then-write) races within a single process.
- **Advisory lock:** A persisted `WorkspaceLock` record in the database coordinates across processes and survives restarts. It has a default TTL of 5 minutes and is checked deterministically inside the mutex.
- **Cross-process coordination:** Only the persisted advisory lock (not the in-process mutex) survives process death. On restart, reconciliation classifies stale locks and repair can release them.

### Performance bounds (N=200 instances)

These are the documented limits for a typical deployment with 200 paused/archived workspaces:

| Operation                                                  | Bound       | Measurement                               |
| ---------------------------------------------------------- | ----------- | ----------------------------------------- |
| `listAll()` — fetch all instances from DB                  | ≤50 ms      | O(1) database query                       |
| `reconciliation()` — scan filesystem + DB, classify health | ≤2000 ms    | O(N) filesystem + in-memory logic         |
| `health()` — live-compute health classification            | ≤2000 ms    | O(N) filesystem + in-memory logic         |
| `switch` / `setActive` — change active pointer             | <50 ms p95  | O(1) pointer update (single DB row write) |
| `activate` / `pause` — change lifecycle state              | <100 ms p95 | O(1) DB update + file handle checks       |

These bounds assume:

- SQLite database on local disk (not network).
- Managed root is on local disk (not NFS or slow storage).
- No heavy concurrent load (other processes not competing for the same worktrees).

See [ADR-0093 D4](../adr/ADR-0093-task-workspace-security-concurrency-and-failure-recovery-hardening.md#d4--document-and-measure-performance-bounds) for measurement methodology.

### Known limitations

- **No cross-repository active pointer:** Each repository has its own active pointer. If you work across multiple repositories, each one has an independent active workspace.
- **Cleanup is one-way:** Once a workspace is cleaned up (worktree + row deleted), it cannot be recovered. Archive first if you need audit retention.
- **Advisory lock TTL is fixed:** The default lock TTL is 5 minutes; it is not configurable per-operation.
- **Terminal is read-only:** Human terminal commands cannot mutate Git state (committed by design). Use the UI or API for all Git Delivery operations.
- **Evidence is hashed, not queryable:** Audit export does not support full-text search of repository names or branch names (by design, to avoid storing sensitive data).

---

## Verification before rollout

Run the verification gate:

```text
npm run check:git-delivery-evidence
```

Run the task-workspace focused test suites:

```text
npm exec vitest -- run \
  packages/keiko-contracts/src/task-workspace.test.ts \
  packages/keiko-contracts/src/task-workspace-health.test.ts \
  packages/keiko-contracts/src/task-workspace-reconciliation.test.ts \
  packages/keiko-server/src/task-workspace/*.test.ts
```

Run the browser e2e test for active-workspace binding (Issue #446):

```text
npm run test:e2e:task-binding-446
```

Confirm you can run:

```text
npm run typecheck
npm run lint
npm run arch:check
npm run test
```

---

## See also

- [Verification matrix](443-verification-matrix.md) — mapping each closure acceptance criterion to code and tests.
- [Closure evidence](443-closure-evidence.md) — final manifest of Epic #443 completion.
- [ADR-0088 (Domain contract)](../adr/ADR-0088-task-workspace-domain-contract.md) — lifecycle states, transitions, and contracts.
- [ADR-0089 (Provisioning)](../adr/ADR-0089-managed-task-worktree-provisioning.md) — managed worktree creation.
- [ADR-0090 (Active binding)](../adr/ADR-0090-active-task-workspace-binding-and-surface-retargeting.md) — cross-surface binding.
- [ADR-0091 (Reconciliation and repair)](../adr/ADR-0091-task-workspace-startup-reconciliation-and-repair.md) — startup recovery.
- [ADR-0092 (Health and cleanup)](../adr/ADR-0092-task-workspace-health-drift-audit-and-governed-cleanup.md) — health classification, safety gates.
- [ADR-0093 (Security and concurrency)](../adr/ADR-0093-task-workspace-security-concurrency-and-failure-recovery-hardening.md) — mutex, lock coordination, failure taxonomy.
