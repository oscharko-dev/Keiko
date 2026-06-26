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
