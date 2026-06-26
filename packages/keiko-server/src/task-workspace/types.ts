// Service-layer contracts for managed task-workspace provisioning + activation (Issue #445).
// The wire entities (WorkspaceInstance / WorkspaceBinding / WorkspaceActivation) stay owned by the
// #444 contract in @oscharko-dev/keiko-contracts; these are the request/result envelopes and the
// injectable dependency bundle the server-side service and BFF routes share.

import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  TaskWorkspaceLifecycleState,
  WorkspaceBinding,
  WorkspaceInstance,
  WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspacePointer, ActiveWorkspacePointerStore } from "./active-store.js";
import type { WorkspaceInstanceStore } from "./store.js";

export interface WorkspaceProvisionRequest {
  // The repository request path the route already resolved (realpath'd project/arbitrary root). The
  // service resolves the git top-level from here before deriving identities.
  readonly repositoryRequestPath: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly requestedBy: string;
}

export interface WorkspaceProvisionResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  // True when this call created (or completed) the worktree; false when an already-active workspace
  // was resumed idempotently.
  readonly created: boolean;
}

export interface WorkspaceActivateRequest {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly requestedBy: string;
  readonly acquireLock: boolean;
  readonly expectedLifecycleState?: TaskWorkspaceLifecycleState | undefined;
}

export interface WorkspaceActivateResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
}

export interface WorkspaceProvisioningService {
  readonly provision: (request: WorkspaceProvisionRequest) => Promise<WorkspaceProvisionResult>;
  readonly activate: (request: WorkspaceActivateRequest) => Promise<WorkspaceActivateResult>;
  readonly getInstance: (workspaceId: string) => WorkspaceInstance | undefined;
}

export interface WorkspaceProvisioningServiceDeps {
  readonly store: WorkspaceInstanceStore;
  readonly evidenceStore: EvidenceStore;
  // The Keiko-owned managed worktree root (absolute). Provisioning proves ownership of this before
  // writing any worktree under it.
  readonly managedRoot: string;
  // Builds a narrow worktree adapter bound to a repository root. Injected so tests can supply a fake.
  readonly createAdapter: (workspace: WorkspaceInfo) => GitWorktreeAdapter;
  readonly redactString: (input: string) => string;
  // Clock + id generator, injected for deterministic tests. `now` is epoch ms.
  readonly now: () => number;
  readonly newId: () => string;
  // Optional: how long a provisioning/activation lock stays valid before it is treated as stale.
  readonly lockTtlMs?: number | undefined;
}

// ─── #446 active-binding lifecycle service ──────────────────────────────────────────────────────
// The cross-surface binding authority: it owns the singleton active pointer and the operator-driven
// pause/resume/switch/handoff transitions. It REUSES the #445 provisioning service for the lifecycle
// walk into `active` (setActive/resume delegate to provisioning.activate) and the same store/evidence
// for pause/handoff — no second worktree, lock, or transition engine (SC1).

// The active view returned to the BFF: the durable instance, the DERIVED binding (binding.ts), and
// the pointer metadata (who set it / when) the switcher renders.
export interface ActiveWorkspaceView {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly pointer: ActiveWorkspacePointer;
}

export interface SetActiveWorkspaceRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
  // When true, the activation acquires the workspace lock for the actor (cross-actor exclusivity).
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
  // List the persisted instances for an already-resolved repository root (switcher inventory).
  readonly list: (repositoryRoot: string) => readonly WorkspaceInstance[];
  // Current active instance + derived binding + pointer, or undefined in unbound mode.
  readonly getActive: () => ActiveWorkspaceView | undefined;
  // ATOMIC SWITCH: activate/resume the target via the #445 service, then persist it as the pointer.
  readonly setActive: (request: SetActiveWorkspaceRequest) => Promise<ActiveWorkspaceView>;
  // Clear the pointer → unbound mode. Does not change any instance lifecycle state. Idempotent.
  readonly clearActive: () => void;
  // active → paused. Clears the pointer iff the paused workspace was the active one.
  readonly pause: (
    request: WorkspaceLifecycleActionRequest,
  ) => Promise<WorkspaceLifecycleActionResult>;
  // paused → active. Sets the pointer to the resumed workspace (delegates the walk to activate).
  readonly resume: (
    request: WorkspaceLifecycleActionRequest,
  ) => Promise<WorkspaceLifecycleActionResult>;
  // active | paused → handoff-ready (requires a clean worktree). Does not change the pointer.
  readonly prepareHandoff: (
    request: WorkspaceLifecycleActionRequest,
  ) => Promise<WorkspaceLifecycleActionResult>;
}

export interface WorkspaceLifecycleServiceDeps {
  readonly store: WorkspaceInstanceStore;
  readonly activePointerStore: ActiveWorkspacePointerStore;
  // Reused #445 service: setActive/resume delegate the lifecycle walk into `active` to it.
  readonly provisioning: WorkspaceProvisioningService;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (input: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
  // Optional: how long a mutation lock stays valid before it is treated as stale. Mirrors provisioning.
  readonly lockTtlMs?: number | undefined;
}
