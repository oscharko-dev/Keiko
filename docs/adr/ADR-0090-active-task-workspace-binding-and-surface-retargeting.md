# ADR-0090: Active task-workspace binding and surface retargeting

## Status

Accepted

## Context

Epic #443 builds task-scoped isolated workspaces. ADR-0088 (#444) shipped the
leaf-pure domain contract in `packages/keiko-contracts/src/task-workspace.ts`:
`WorkspaceInstance` (the durable record), `WorkspaceBinding` (the authoritative
active project root, with `validateWorkspaceBinding` enforcing
`gitDeliveryRoot === activeRoot === editorProjectRoot` whenever `activeRoot` is
non-empty), the 8 `WorkspaceSurface` values (`TASK_WORKSPACE_SURFACES`), the
10-state lifecycle with `validateTaskWorkspaceTransition` + per-transition
preconditions, health/drift/lock/recovery semantics, and the content-free
closed-allowlist invariant (SC3). ADR-0089 (#445) shipped the provisioning
authority in `packages/keiko-server/src/task-workspace/`: the
`WorkspaceInstanceStore` over the shared `node:sqlite` `DatabaseSync` handle
(schema V7, `task_workspace_instances`), `createWorkspaceProvisioningService`
(`provision`/`activate`/`getInstance`) reusing the narrow keiko-tools worktree
adapter, content-free lifecycle evidence, and the three BFF routes
(`POST /api/task-workspaces`, `POST /api/task-workspaces/:workspaceId/activate`,
`GET /api/task-workspaces/:workspaceId`).

What does **not** exist yet is the thing that makes #443 useful (#446): a single
durable *active* pointer and the wiring that retargets every operator-facing
surface to it. Confirmed by reading the current code:

- **No server-side or UI-wide active pointer.** Every BFF surface route takes its
  working root **client-supplied per request** — `files.ts` (`resolveRoot`),
  `gitRoutes.ts`, `command-runner-routes.ts` (`projectId`), the editor
  completion/inline/language routes, container routes, and terminal all read a
  query param (`root`/`projectId`) or POST body `root` and validate via
  `resolveRoot`. `session.activeProject` (`useChatSession`) is the launched repo,
  **not** a task-workspace binding.
- **Each desktop window holds its own root in `cfg`.** Root resolution in
  `packages/keiko-ui/src/app/components/desktop/widgets/index.tsx` is per-widget
  and varied: editor reads `str(cfg, "root")`; runtime/container/PR/merge read
  `str(cfg, "projectPath") ?? str(cfg, "workspaceRoot") ?? ctx.linkedRoot`;
  terminal reads `cfg.cwd`/`cfg.projectPath`. The fallback chain bottoms out at
  `WindowRenderContext.linkedRoot` (`windows/WindowsRegistry.ts`).
- `buildBinding(instance)` already exists inside `provisioning.ts` (private) and
  derives `activeRoot = gitDeliveryRoot = editorProjectRoot =
  managedWorktreePath`, `boundSurfaces = TASK_WORKSPACE_SURFACES`. The binding is
  fully derivable from an instance; **no second project-context model is needed.**

The decision this ADR makes: introduce ONE durable active-workspace pointer, the
read/switch/lifecycle BFF routes around it, and a single UI choke point that
retargets all bound surfaces atomically — strictly **consuming** the #470 and
#1491 governed routes, never re-implementing them.

Forces:

- **Single-operator Studio.** Exactly one task workspace is active at a time;
  there is no multi-tenant concurrency to model.
- **Durability.** The active context must survive a page reload — a client-only
  pointer loses it.
- **No parallel subsystem (ADR-0088 AC4).** `WorkspaceBinding` and the 8 surfaces
  already exist; adding a `keiko-contracts` change or a second project-context
  store would violate the no-duplicate-subsystem rule.
- **Atomicity / no mixed context (#446 AC2, Stop Condition).** After a switch, no
  surface may remain pointed at the previous workspace; the editor must not keep a
  stale Monaco model.
- **Package boundaries (ADR-0019).** `keiko-server` task-workspace modules may
  import contracts/security/workspace/tools/evidence but never `keiko-ui`;
  `keiko-ui` may **type-import** `@oscharko-dev/keiko-contracts` only (rule 8) and
  must never value-import `keiko-server`.

## Decision

We will add a **server-persisted singleton active-workspace pointer**, derive the
`WorkspaceBinding` from the active `WorkspaceInstance`, expose read/switch/clear
plus pause/resume/handoff lifecycle routes, and retarget all bound UI surfaces
through **one** choke point in `WindowRenderContext`. No `keiko-contracts` change;
`KEIKO_CONTRACTS_VERSION` is untouched.

**D1 — One durable active pointer (singleton).** A new SQLite table over the
**same** `DatabaseSync` handle as the #445 instance store (schema **V8**), holding
at most one row (a fixed primary key). It stores only the `workspace_id` of the
active instance plus audit timestamps; the `WorkspaceBinding` is **derived** from
the referenced `WorkspaceInstance` (`buildBinding`), never persisted as a second
copy. The pointer persists across reload. Clearing the pointer = **unbound mode**.

**D2 — Lifecycle-action service composes #445, never duplicates it.** A new
`createWorkspaceLifecycleService` wraps the existing `WorkspaceInstanceStore`,
`appendWorkspaceLifecycleEvidence`/`buildWorkspaceEvent`, the worktree adapter,
and the existing `WorkspaceProvisioningService`. `setActive` delegates the
activate-or-resume walk to `provisioningService.activate(...)` (which already
gates `validateTaskWorkspaceTransition`, resolves lock/path/clean preconditions
via the adapter, persists the instance, and emits evidence), then persists the
returned instance's id into the pointer. `pause`/`resume`/`prepareHandoff` resolve
the precondition `TaskWorkspaceTransitionContext` from the worktree adapter +
lock, gate `validateTaskWorkspaceTransition`, persist via the **same** store
`upsert`, and append the **same** content-free evidence. Pausing the active
workspace clears the pointer; resume sets it active. No worktree/lock/transition
logic is re-implemented.

**D3 — New BFF routes extend `task-workspace/routes.ts`.** All mutations are
CSRF-gated by the server's existing global state-changing gate; all responses pass
through `deps.redactor`; all errors map via `TaskWorkspaceError` + redaction; all
reuse `resolveRoot`, `readJsonObject`, `boundedString`, `runHandler`, `redacted`,
and `mapError` already in that file.

**D4 — One UI choke point.** Add `activeRoot: string | null` and
`activeBinding: WorkspaceBinding | null` to `WindowRenderContext`. In
`widgets/index.tsx`, every bound-surface root resolution **prefers
`ctx.activeRoot` when a workspace is active**, overriding per-window `cfg` and
`linkedRoot`; it falls back to the existing `cfg`/`linkedRoot` chain **only** in
unbound mode. Because `activeRoot` lives on the shared render context, a switch
re-renders every widget atomically. The editor widget is **keyed on
`activeRoot`** so Monaco remounts on switch and no stale model/document survives
(AC4 + Stop Condition).

**D5 — `TaskWorkspaceSwitcher` in the Header strip.** Shows task identity, branch,
base branch, managed worktree path, health badge, dirty badge (`driftMarkers`
includes `"uncommitted-changes"`), lock badge (`lock !== null`), recent lifecycle
activity (`updatedAt`), a selector to switch, and pause/resume/switch/handoff
actions gated by `nextLegalTaskWorkspaceStates`. a11y: `role=status` /
`aria-live=polite` for state, `aria-disabled` (not native `disabled`) during busy,
`role=alert` for errors, `<details>` for recovery hints. Reuses design tokens and
the `ConnectedScopePill` / `ContextStatusPanel` / `EditorMenu` patterns.

**D6 — No contract change.** `WorkspaceBinding`, `WorkspaceSurface`,
`validateWorkspaceBinding`, and the lifecycle/precondition functions already cover
every need. `keiko-contracts` stays a leaf with no new edges;
`KEIKO_CONTRACTS_VERSION` is unchanged.

### Acceptance-Criteria & Stop-Condition mapping

| Issue #446 AC / Stop Condition | Design mechanism |
| --- | --- |
| AC1 — all bound surfaces target the active workspace consistently | D1 singleton pointer → D4 single `ctx.activeRoot` choke point; `boundSurfaces = TASK_WORKSPACE_SURFACES` (all 8) so every surface is in scope. |
| AC2 — switching updates all surfaces with no mixed-context leakage | D2 atomic `setActive` (one pointer write) → D4 single context value re-renders all widgets in one pass; D4 editor remount key drops stale Monaco state. |
| AC3 — Git Delivery still runs only through #470 governed preview/policy/approval/evidence, scoped to active root | D4 retargets the `projectId`/`projectPath` the existing `GovernedGitFlowCard`/`GovernedPullRequestCard`/`GovernedMergeCard` already send to the unchanged #470 routes. No #470 route, policy, or evidence path is touched. |
| AC4 — editor/runtime still enforce #1491 document/command/output/containment safeguards, scoped to active root | D4 retargets the `root`/`projectPath` the existing #1491 editor/runtime/command/container widgets already send to the unchanged #1491 routes; editor remount key prevents stale documents. |
| AC5 — UI makes active task, branch, path, health, dirty, lock visible | D5 `TaskWorkspaceSwitcher` renders all six from the active `WorkspaceInstance` (dirty = `driftMarkers.includes("uncommitted-changes")`). |
| AC6 — no degraded responsiveness / confusing transient mixed states | D4 single synchronous context swap (no per-surface async fan-out); D5 `switching` flag drives `aria-busy`/skeleton on the switcher only; widgets re-render once. |
| Stop Condition — no surface remains pointed at the previous workspace; no stale editor model | D4 `ctx.activeRoot` override is unconditional while active (per-window `cfg` cannot win) + editor remount key. |

## Consequences

### Positive

- One source of truth, one choke point: the system has fewer paths and a switch is
  one pointer write + one context re-render.
- Zero contract churn and zero new package edges; the binding is derived, so the
  `activeRoot === gitDeliveryRoot === editorProjectRoot` invariant cannot drift.
- #470 and #1491 are consumed unchanged — their governance is structurally
  preserved because this ADR adds no route into either subsystem.
- Reversible: deleting the V8 table + the choke-point override returns the UI to
  per-window `cfg` roots with no data migration (forward-only schema, additive
  table).

### Negative

- The choke-point override means a per-window `cfg.root` is **ignored** while a
  workspace is active. This is intended (it is the mechanism), but it changes the
  current "each window owns its root" mental model; documented in D4 and surfaced
  by the switcher so the active root is always visible.
- The editor remount-on-switch discards unsaved in-editor state on switch. This is
  the correct safety behavior (no stale model), but implementers must ensure the
  existing #1491 dirty-buffer/hot-exit path (#1376) still fires before the
  remount — see File Ownership note.
- Singleton means no side-by-side comparison of two workspaces. Accepted:
  single-operator Studio, and out-of-scope per the Issue.

### Neutral

- The pointer is a new V8 migration; the DB advances `user_version` 7 → 8.
- Unbound mode (no active workspace) is a first-class state the switcher and the
  fallback chain both handle.

## Alternatives Considered

### Alternative 1: Per-session (per-window) binding

- **Pros**: matches today's "each window owns its root"; no global state.
- **Cons**: there is no single active context, so AC1/AC2 (consistent + atomic
  rebinding across surfaces) cannot be met without an N-window fan-out; mixed
  context becomes the default failure mode.
- **Why rejected**: Studio is single-operator and the Issue explicitly requires a
  *shared* active binding and atomic switching. A per-session model re-creates the
  exact problem #446 exists to remove.

### Alternative 2: Client-only binding (React context / localStorage)

- **Pros**: no schema change; fastest to build.
- **Cons**: not durable across reload in a server-authoritative way; the BFF
  surface routes (which validate roots server-side) would have no server pointer to
  consult for future server-initiated flows; two sources of truth (client memory
  vs. the persisted instances) can diverge.
- **Why rejected**: the Issue requires a durable source of truth and the binding
  must be derivable/validatable server-side. A server-persisted pointer over the
  existing handle is barely more work and removes the divergence risk. (The UI
  still holds a *cache* of the pointer in context — D3 — but the server is
  authoritative.)

### Alternative 3: New project-context model / second store

- **Pros**: could carry UI-specific context (open files, layout) alongside the
  root.
- **Cons**: duplicates `WorkspaceBinding` + the instance store; violates ADR-0088
  AC4 (no-duplicate-subsystem) and ADR-0019 single-source-of-truth.
- **Why rejected**: `WorkspaceBinding` + `WorkspaceInstance` already model the
  root and all surface coordinates; UI-specific layout already lives in window
  `cfg`. A parallel model is a textbook premature abstraction and a layer
  violation.

### Alternative 4: Retarget each surface route server-side (ignore client root)

- **Pros**: enforces the active root even against a hand-crafted request.
- **Cons**: requires editing every surface route (`files.ts`, `gitRoutes.ts`,
  command/container/editor routes) to consult the pointer — a wide, hard-to-revert
  blast radius touching #470/#1491 route code, risking exactly the governance
  coupling this ADR avoids.
- **Why rejected**: the UI choke point (D4) achieves AC1–AC4 with a single edit
  point and zero changes to #470/#1491 routes. Server-side enforcement is a
  reversible future hardening (the pointer already exists for it) and is recorded
  as a follow-up, not built now (no premature scope).

## Implementation Contract

> Developers/UI/test engineers implement against these signatures **verbatim**.
> No `keiko-contracts` change. `KEIKO_CONTRACTS_VERSION` unchanged.

### (a) SQL DDL — new active-pointer table (schema V8)

Add to `packages/keiko-server/src/store/schema.ts`, immediately after `V7_SQL`,
and register `{ version: 8, sql: V8_SQL }` in `MIGRATIONS`; bump
`SCHEMA_VERSION` `7` → `8`.

```sql
-- V8 (issue #446, epic #443) — singleton active task-workspace pointer. At most one row
-- (id is pinned to the constant 'active'); a CHECK enforces the singleton. The binding is DERIVED
-- from the referenced WorkspaceInstance, never stored. Content-free: an opaque workspace id + audit
-- timestamps + an opaque actor id only.
CREATE TABLE task_workspace_active_pointer (
  id            TEXT NOT NULL PRIMARY KEY DEFAULT 'active',
  workspace_id  TEXT NOT NULL,
  set_by        TEXT NOT NULL,
  set_at        TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (id = 'active'),
  FOREIGN KEY (workspace_id) REFERENCES task_workspace_instances(workspace_id) ON DELETE CASCADE
) STRICT;
```

Notes: `ON DELETE CASCADE` means deleting/cleaning up the active instance clears
the pointer automatically. "Clear active" = `DELETE FROM
task_workspace_active_pointer`. No new index (single row). PRAGMA `foreign_keys`
must be ON for the cascade — confirm it is enabled where the handle is opened;
if not, the lifecycle service must clear the pointer explicitly on instance delete.

### (b) New active-pointer store — `task-workspace/active-store.ts` (dev/server)

```ts
import type { DatabaseSync } from "node:sqlite";

export interface ActiveWorkspacePointer {
  readonly workspaceId: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly updatedAt: string;
}

export interface ActiveWorkspacePointerStore {
  readonly get: () => ActiveWorkspacePointer | undefined;
  /** Upsert the singleton row (id pinned to 'active'); returns the persisted pointer. */
  readonly set: (input: { readonly workspaceId: string; readonly setBy: string; readonly atIso: string }) => ActiveWorkspacePointer;
  /** Delete the singleton row → unbound mode. Idempotent. */
  readonly clear: () => void;
}

export function buildActiveWorkspacePointerStoreOverDatabase(db: DatabaseSync): ActiveWorkspacePointerStore;
```

### (c) New lifecycle-action service — `task-workspace/lifecycle.ts` (dev/server)

Composes #445 without duplicating worktree/lock/transition logic. Request/result
envelopes go in `task-workspace/types.ts` (extend the existing file).

```ts
// types.ts additions
import type { WorkspaceBinding, WorkspaceInstance, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { ActiveWorkspacePointer, ActiveWorkspacePointerStore } from "./active-store.js";

export interface ActiveWorkspaceView {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly pointer: ActiveWorkspacePointer;
}

export interface SetActiveWorkspaceRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly acquireLock: boolean;
}

export interface WorkspaceLifecycleActionRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
}

export interface WorkspaceLifecycleActionResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
}

export interface WorkspaceLifecycleService {
  /** List the persisted instances for an already-resolved repository root. Delegates to store.listByRepository (via deriveRepositoryId). */
  readonly list: (repositoryRoot: string) => readonly WorkspaceInstance[];
  /** Current active instance+binding+pointer, or undefined in unbound mode. */
  readonly getActive: () => ActiveWorkspaceView | undefined;
  /** ATOMIC SWITCH: activate/resume target via the #445 service, then persist it as the pointer. */
  readonly setActive: (request: SetActiveWorkspaceRequest) => Promise<ActiveWorkspaceView>;
  /** Clear the pointer → unbound mode (does not change the instance lifecycle state). */
  readonly clearActive: () => void;
  /** active → paused. If the paused workspace was active, clears the pointer. */
  readonly pause: (request: WorkspaceLifecycleActionRequest) => Promise<WorkspaceLifecycleActionResult>;
  /** paused → active. Sets the pointer to the resumed workspace. */
  readonly resume: (request: WorkspaceLifecycleActionRequest) => Promise<WorkspaceLifecycleActionResult>;
  /** active|paused → handoff-ready. Does not change the pointer. */
  readonly prepareHandoff: (request: WorkspaceLifecycleActionRequest) => Promise<WorkspaceLifecycleActionResult>;
}

export interface WorkspaceLifecycleServiceDeps {
  readonly store: WorkspaceInstanceStore;              // reused from #445
  readonly activePointerStore: ActiveWorkspacePointerStore;
  readonly provisioning: WorkspaceProvisioningService; // reused: setActive/resume delegate to .activate
  readonly evidenceStore: EvidenceStore;               // reused: append the SAME lifecycle evidence
  readonly createAdapter: (workspace: WorkspaceInfo) => GitWorktreeAdapter; // reused: resolve worktree-clean/path
  readonly redactString: (input: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
}

export function createWorkspaceLifecycleService(deps: WorkspaceLifecycleServiceDeps): WorkspaceLifecycleService;
```

Implementation rules (binding on the developer):

- `setActive` MUST call `deps.provisioning.activate({ workspaceId, taskId: "",
  requestedBy, acquireLock })` to perform the lifecycle walk (it already gates
  `validateTaskWorkspaceTransition`, resolves preconditions, persists, emits
  evidence, and rejects drift), then `deps.activePointerStore.set(...)` with the
  returned instance id. The binding returned to the caller is the one
  `activate` produced (`buildBinding`) — do NOT recompute it independently.
- `pause`/`resume`/`prepareHandoff` MUST: load the instance via
  `deps.store.getById`, resolve the `TaskWorkspaceTransitionContext`
  (`lockHeldByActor` from `instance.lock?.owner === requestedBy`;
  `pathContained`/`worktreeClean` via the adapter; the remaining facts as the
  existing provisioning service does), call `validateTaskWorkspaceTransition`, and
  on `ok` persist through `deps.store.upsert(...)` and append evidence via
  `appendWorkspaceLifecycleEvidence` + `buildWorkspaceEvent`. On not-ok, throw
  `new TaskWorkspaceError("ILLEGAL_TRANSITION", ..., reasons)`. (Per the contract,
  `active->paused` and `paused->active` require `lock-held-by-actor`;
  `*->handoff-ready` requires `lock-held-by-actor` + `worktree-clean`.)
- `pause` MUST clear the pointer iff the paused workspace is the active one
  (`getActive()?.instance.workspaceId === workspaceId`). `resume` MUST set the
  pointer to the resumed workspace.
- `WorkspaceLifecycleOperation`/`WorkspaceLifecycleOutcome` in `evidence.ts` are
  currently `"provision" | "activate"` and a fixed outcome union. Extend those two
  unions minimally to cover `pause`/`resume`/`handoff` operations and the
  `paused`/`resumed`/`handoff-prepared` outcomes used by the new `WorkspaceEvent`
  types — this is an additive widening of the evidence enums, NOT a contract
  change (the `WorkspaceEvent.type` values `paused`/`resumed`/`handoff-prepared`
  already exist in the #444 contract).
- **Promote** the existing private `buildBinding(instance)` in `provisioning.ts`
  to an exported helper (or move it to a new `task-workspace/binding.ts`) so
  `getActive` and `list` callers derive the binding from a stored instance without
  duplication. This is the only edit to `provisioning.ts`.

### (d) New route handlers — extend `task-workspace/routes.ts` (dev/server)

Reuse `requireService`/`unavailable` pattern but gated on a new optional
`deps.workspaceLifecycle`. Reuse `readJsonObject`, `boundedString`, `runHandler`,
`redacted`, `mapError`, `resolveRoot`, `TaskWorkspaceError`, `errorBody`.

| Method | URL pattern | Handler | Request body | 200 body | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/task-workspaces?root=<repoRoot>` | `handleListTaskWorkspaces` | — | `{ instances: WorkspaceInstance[] }` | `resolveRoot(deps.store, root, deps.redactor)` then `lifecycle.list(realRoot)`. Read-only. Matches the **collection** path with a `root` query, distinct from the existing `GET /api/task-workspaces/:workspaceId`. |
| GET | `/api/task-workspaces/active` | `handleGetActiveTaskWorkspace` | — | `{ active: ActiveWorkspaceView \| null }` | `lifecycle.getActive() ?? null`. Read-only. MUST be registered **before** `GET /api/task-workspaces/:workspaceId` so the literal `active` wins over `:workspaceId`. |
| POST | `/api/task-workspaces/active` | `handleSetActiveTaskWorkspace` | `{ workspaceId, requestedBy, acquireLock? }` | `{ instance, binding }` | CSRF-gated. `boundedString` each field; `acquireLock = body.acquireLock === true`. Calls `lifecycle.setActive`. |
| DELETE | `/api/task-workspaces/active` | `handleClearActiveTaskWorkspace` | — | `{ active: null }` | CSRF-gated. `lifecycle.clearActive()`. |
| POST | `/api/task-workspaces/:workspaceId/pause` | `handlePauseTaskWorkspace` | `{ requestedBy }` | `{ instance, binding }` | CSRF-gated. `lifecycle.pause`. |
| POST | `/api/task-workspaces/:workspaceId/resume` | `handleResumeTaskWorkspace` | `{ requestedBy }` | `{ instance, binding }` | CSRF-gated. `lifecycle.resume`. |
| POST | `/api/task-workspaces/:workspaceId/handoff` | `handleHandoffTaskWorkspace` | `{ requestedBy }` | `{ instance, binding }` | CSRF-gated. `lifecycle.prepareHandoff`. |

Route registration order in `packages/keiko-server/src/routes.ts` (literal-before-param):

```
GET    /api/task-workspaces                       (list; reads ?root)
GET    /api/task-workspaces/active                (must precede :workspaceId)
POST   /api/task-workspaces/active
DELETE /api/task-workspaces/active
POST   /api/task-workspaces/:workspaceId/pause
POST   /api/task-workspaces/:workspaceId/resume
POST   /api/task-workspaces/:workspaceId/handoff
... existing #445 routes (provision / :workspaceId/activate / GET :workspaceId) ...
```

Every handler body wraps its work in `runHandler(deps, async () => {...})` and
returns `redacted(deps, ...)`; errors flow through the existing `mapError`
(extend `TaskWorkspaceError` usage only — no new error subsystem).

### (e) `deps.ts` wiring additions (dev/server)

```ts
// UiHandlerDeps + BuildHandlerDepsOptions: add the optional service (mirrors workspaceProvisioning).
readonly workspaceLifecycle?: WorkspaceLifecycleService | undefined;

// ComposedPersistence: add the active-pointer store alongside workspaceInstanceStore.
readonly activeWorkspacePointerStore: ActiveWorkspacePointerStore | undefined;
// composePersistence(): when opening the node DB, also
//   activeWorkspacePointerStore: buildActiveWorkspacePointerStoreOverDatabase(db),
//   (and when a UiStore is injected → undefined, exactly like workspaceInstanceStore.)

// New builder mirroring buildWorkspaceProvisioning():
function buildWorkspaceLifecycle(
  options: BuildHandlerDepsOptions,
  instanceStore: WorkspaceInstanceStore | undefined,
  activePointerStore: ActiveWorkspacePointerStore | undefined,
  provisioning: WorkspaceProvisioningService | undefined,
  resolvedUiDbPath: string,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  env: EnvSource,
): WorkspaceLifecycleService | undefined {
  if (options.workspaceLifecycle !== undefined) return options.workspaceLifecycle;
  if (instanceStore === undefined || activePointerStore === undefined || provisioning === undefined) return undefined;
  return createWorkspaceLifecycleService({
    store: instanceStore,
    activePointerStore,
    provisioning,
    evidenceStore,
    createAdapter: (workspace) => createNodeGitWorktreeAdapter({ workspace, processEnv: options.env }),
    redactString, now: () => Date.now(), newId: randomUUID,
  });
}
// In buildUiHandlerDeps: thread workspaceLifecycle into the returned deps exactly like workspaceProvisioning
// (spread `...(workspaceLifecycle === undefined ? {} : { workspaceLifecycle })`).
```

### (f) UI contract (ui-engineer)

`keiko-ui` may **type-import** `@oscharko-dev/keiko-contracts` only; it MUST NOT
value-import `keiko-server`. The client calls same-origin BFF routes via `fetch`.

**`lib/task-workspace-api.ts`** (new) — thin same-origin client:

```ts
import type { WorkspaceInstance, WorkspaceBinding } from "@oscharko-dev/keiko-contracts";

export interface ActiveWorkspaceView {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly pointer: { readonly workspaceId: string; readonly setBy: string; readonly setAt: string; readonly updatedAt: string };
}

export function listTaskWorkspaces(root: string): Promise<readonly WorkspaceInstance[]>;
export function getActiveTaskWorkspace(): Promise<ActiveWorkspaceView | null>;
export function setActiveTaskWorkspace(input: { workspaceId: string; requestedBy: string; acquireLock?: boolean }): Promise<{ instance: WorkspaceInstance; binding: WorkspaceBinding }>;
export function clearActiveTaskWorkspace(): Promise<void>;
export function pauseTaskWorkspace(input: { workspaceId: string; requestedBy: string }): Promise<{ instance: WorkspaceInstance; binding: WorkspaceBinding }>;
export function resumeTaskWorkspace(input: { workspaceId: string; requestedBy: string }): Promise<{ instance: WorkspaceInstance; binding: WorkspaceBinding }>;
export function prepareHandoffTaskWorkspace(input: { workspaceId: string; requestedBy: string }): Promise<{ instance: WorkspaceInstance; binding: WorkspaceBinding }>;
```

All mutating calls send the CSRF header the existing UI client helpers use (reuse
the same wrapper as `lib` Git Delivery / command clients).

**`components/desktop/context/ActiveWorkspaceContext.tsx`** (new) — mirrors the
`ChatSessionContext` pattern:

```ts
import type { WorkspaceInstance, WorkspaceBinding } from "@oscharko-dev/keiko-contracts";

export interface ActiveWorkspaceApi {
  readonly instances: readonly WorkspaceInstance[];
  readonly activeBinding: WorkspaceBinding | null;
  readonly activeInstance: WorkspaceInstance | null;
  /** Convenience: activeBinding?.activeRoot ?? null. The value D4 feeds into WindowRenderContext. */
  readonly activeRoot: string | null;
  readonly loading: boolean;
  readonly switching: boolean;
  readonly error: string | null;
  readonly refresh: (root?: string) => Promise<void>;
  readonly switchTo: (workspaceId: string) => Promise<void>;
  readonly clearActive: () => Promise<void>;
  readonly pause: (workspaceId: string) => Promise<void>;
  readonly resume: (workspaceId: string) => Promise<void>;
  readonly prepareHandoff: (workspaceId: string) => Promise<void>;
  readonly provision: (input: { root: string; taskId: string; baseBranch: string }) => Promise<void>;
}

export function ActiveWorkspaceProvider(props: { value: ActiveWorkspaceApi; children: ReactNode }): ReactNode;
export function useActiveWorkspace(): ActiveWorkspaceApi;          // throws outside provider
export function useOptionalActiveWorkspace(): ActiveWorkspaceApi | null; // null outside provider (tests/standalone)
```

The provider is mounted at `AppShell` level (alongside `ChatSessionProvider`). A
`useActiveWorkspaceState()` hook owns the state machine (`useReducer`),
`requestedBy` resolved from the existing session/loopback identity, and is the
only value-importer of `lib/task-workspace-api.ts`.

**`WindowRenderContext` additions** (`windows/WindowsRegistry.ts`):

```ts
export interface WindowRenderContext {
  // ...existing fields...
  /** Issue #446 — active task-workspace root; null in unbound mode. The single retarget choke point. */
  readonly activeRoot: string | null;
  /** Issue #446 — the derived active binding; null in unbound mode. */
  readonly activeBinding: WorkspaceBinding | null;
}
```

The site that constructs `WindowRenderContext` (the desktop workspace renderer)
reads them from `useOptionalActiveWorkspace()` and passes them through.

**`widgets/index.tsx` override rule** — introduce one shared helper and use it in
every **bound-surface** widget renderer:

```ts
// When a workspace is active, the active root OVERRIDES per-window cfg/linkedRoot for bound surfaces.
// In unbound mode, fall back to the existing chain unchanged.
function resolveBoundRoot(ctx: WindowRenderContext, cfgRoot: string | undefined): string | undefined {
  return ctx.activeRoot ?? cfgRoot ?? ctx.linkedRoot ?? undefined;
}
```

Apply to: `files`, `editor`, `terminal`, `commands`, `runtime`, `container`,
`governedGit`, `governedPullRequest`, `governedMerge`, `browser`/`review` (where a
root is meaningful). The `chat` surface keeps `session.activeProject` as today but
reads `ctx.activeRoot` for any root-scoped child. The **editor** renderer
additionally sets a remount key so a switch drops the Monaco model:

```tsx
const boundRoot = resolveBoundRoot(ctx, str(cfg, "root"));
if (boundRoot !== undefined) props.root = boundRoot;
return <EditorWidget key={ctx.activeRoot ?? "unbound"} {...props} />;
```

(Confirm the #1491 dirty-buffer/hot-exit save path fires on unmount before relying
on the remount — see File Ownership note for editor.)

**`TaskWorkspaceSwitcher.tsx`** (new, Header strip) prop contract:

```ts
export interface TaskWorkspaceSwitcherProps {
  readonly instances: readonly WorkspaceInstance[];
  readonly activeInstance: WorkspaceInstance | null;
  readonly switching: boolean;
  readonly error: string | null;
  readonly onSwitch: (workspaceId: string) => void;
  readonly onPause: (workspaceId: string) => void;
  readonly onResume: (workspaceId: string) => void;
  readonly onPrepareHandoff: (workspaceId: string) => void;
  readonly onClearActive: () => void;
  readonly onRefresh: () => void;
}
```

Rendering rules: dirty badge iff
`activeInstance.driftMarkers.includes("uncommitted-changes")`; lock badge iff
`activeInstance.lock !== null` (show `lock.reason`/`lock.owner`); action buttons
enabled iff the target state is in
`nextLegalTaskWorkspaceStates(activeInstance.lifecycleState)`; busy state via
`aria-disabled` + `aria-busy`, never native `disabled`; state changes in a
`role=status aria-live=polite` region; errors in `role=alert`; recovery hints in a
`<details>` disclosure. Reuse `--feedback-*`, `--accent`, `--radius-sm`,
`--focus-ring` tokens and the `ConnectedScopePill`/`ContextStatusPanel`/`EditorMenu`
visual patterns (no `globals.css` edits — that file is behind a SHA-pinned proof
gate).

### (g) File-ownership boundaries (3-way parallel team)

**dev / server** (owns; no UI imports):
- `packages/keiko-server/src/store/schema.ts` — add `V8_SQL`, register migration, bump `SCHEMA_VERSION`.
- `packages/keiko-server/src/task-workspace/active-store.ts` — NEW (b).
- `packages/keiko-server/src/task-workspace/lifecycle.ts` — NEW (c).
- `packages/keiko-server/src/task-workspace/binding.ts` — NEW (export `buildBinding`) OR export it from `provisioning.ts`.
- `packages/keiko-server/src/task-workspace/types.ts` — extend with (c) envelopes.
- `packages/keiko-server/src/task-workspace/evidence.ts` — additively widen `WorkspaceLifecycleOperation`/`WorkspaceLifecycleOutcome` for pause/resume/handoff.
- `packages/keiko-server/src/task-workspace/routes.ts` — add the 7 handlers (d).
- `packages/keiko-server/src/task-workspace/provisioning.ts` — promote `buildBinding` to exported (only edit).
- `packages/keiko-server/src/routes.ts` — register the 7 routes in the order shown (d).
- `packages/keiko-server/src/deps.ts` — wiring (e).

**ui / components** (owns; type-only contracts imports):
- `packages/keiko-ui/src/app/lib/task-workspace-api.ts` — NEW (f).
- `packages/keiko-ui/src/app/components/desktop/context/ActiveWorkspaceContext.tsx` — NEW (f).
- `packages/keiko-ui/src/app/components/desktop/hooks/useActiveWorkspaceState.ts` — NEW state machine.
- `packages/keiko-ui/src/app/components/desktop/TaskWorkspaceSwitcher.tsx` — NEW (f, D5).
- `packages/keiko-ui/src/app/components/desktop/AppShell.tsx` — mount `ActiveWorkspaceProvider` + Header switcher.
- `packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts` — add `activeRoot`/`activeBinding` to `WindowRenderContext` (f).
- `packages/keiko-ui/src/app/components/desktop/widgets/index.tsx` — `resolveBoundRoot` helper + apply to bound surfaces + editor remount key (f, D4).
- The desktop renderer that constructs `WindowRenderContext` — thread the two new fields from `useOptionalActiveWorkspace()`.

**test** (owns; `*.test.*` only):
- Server: `active-store.test.ts`, `lifecycle.test.ts` (atomic setActive, pause clears pointer, resume sets it, transition rejection, drift), `routes.test.ts` additions (CSRF, redaction, list-by-root, literal-before-param ordering), schema migration 7→8 test.
- UI: `ActiveWorkspaceContext.test.tsx`, `TaskWorkspaceSwitcher.test.tsx` (+ `.a11y.test.tsx`), `widgets` retarget tests (active root overrides cfg; unbound falls back; editor remount key changes on switch), an AppShell integration test for atomic surface rebinding + stale-context prevention.
- e2e/browser: task-switch regression across editor/Files/Terminal/Runtime/Git Delivery.

Coordination seams (touch, do not own): the editor `key=` remount lives in
`widgets/index.tsx` (ui), but the #1491 dirty-buffer/hot-exit save-on-unmount it
relies on is existing editor-package behavior — test-engineer adds a regression
asserting unsaved buffers are not silently lost on switch; if that path does not
fire on unmount, that is a defect to file against #1491, **not** a reason to add
save logic here (no feature code in this ADR's scope).

## Package-boundary legality (confirmed)

- `keiko-contracts` stays a **leaf**: no change, no new edges. `WorkspaceBinding`,
  `WorkspaceSurface`, `validateWorkspaceBinding`, `nextLegalTaskWorkspaceStates`,
  `validateTaskWorkspaceTransition`, and `TASK_WORKSPACE_SURFACES` already exist
  (ADR-0088). `KEIKO_CONTRACTS_VERSION` **untouched**; no exhaustiveness impact.
- `keiko-server` task-workspace modules import contracts/evidence/tools/workspace
  (already do via #445) — legal. They MUST NOT import `keiko-ui`.
- `keiko-ui` **type-imports** `@oscharko-dev/keiko-contracts` only and reaches the
  BFF over same-origin `fetch` (ADR-0019 rule 8). It MUST NOT value-import
  `keiko-server`; `lib/task-workspace-api.ts` is the single network boundary.
- #470 and #1491 route code is **not edited** — they are consumed unchanged via
  the retargeted root, preserving their governance by construction (ADR-0088 AC4).

## Governance conflict check

No conflict found with ADR-0019, ADR-0088, ADR-0089, the #470 governed-git
delivery, or the #1491 editor/runtime governance. Four items flagged for the
implementation team rather than silently resolved:

1. **Editor unsaved-state on switch.** D4's remount key correctly drops stale
   Monaco models (AC4/Stop Condition) but relies on the existing #1491
   dirty-buffer/hot-exit save-on-unmount (#1376) firing first. If it does not,
   that is a #1491 defect to file, not new save logic to add here.
2. **`WorkspaceBinding` empty-`activeRoot` representability.** `validateWorkspaceBinding`
   only enforces the three-way root equality when `activeRoot` is non-empty.
   Unbound mode is therefore modeled as **no binding** (`activeBinding === null`),
   never as a binding with an empty `activeRoot`. The pointer table's `NOT NULL`
   `workspace_id` makes an empty-root binding unrepresentable server-side.
3. **List route shape.** `GET /api/task-workspaces?root=...` shares a path prefix
   with the existing `GET /api/task-workspaces/:workspaceId`. Implementers MUST
   register the literal/collection routes (`?root`, `/active`) so they resolve
   before the `:workspaceId` param route; the route table in (d) fixes the order.
4. **Foreign-key cascade.** The pointer→instance `ON DELETE CASCADE` only fires
   when `PRAGMA foreign_keys = ON` for the handle. If the shared handle does not
   enable it, the lifecycle service must clear the pointer explicitly whenever it
   deletes the referenced instance — flagged in (a).

## Related

- ADR-0088: Governed isolated task-workspace contract (#444) — the binding/surface/lifecycle types this ADR consumes unchanged.
- ADR-0089: Managed task-worktree provisioning + activation (#445) — the store/service this ADR composes for `setActive`/`resume`.
- ADR-0019: Package boundaries — leaf `keiko-contracts`, `keiko-ui` type-only imports (rule 8), `keiko-server` BFF authority.
- ADR-0013: SQLite schema + `PRAGMA user_version` migration runner — the V8 migration follows this pattern.
- #470 governed Git Delivery (ADR-0080–0087) and #1491 editor/runtime — consumed unchanged via the retargeted root.

## Date

2026-06-26
