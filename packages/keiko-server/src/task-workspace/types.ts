// Service-layer contracts for managed task-workspace provisioning + activation (Issue #445).
// The wire entities (WorkspaceInstance / WorkspaceBinding / WorkspaceActivation) stay owned by the
// #444 contract in @oscharko-dev/keiko-contracts; these are the request/result envelopes and the
// injectable dependency bundle the server-side service and BFF routes share.

import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type {
  TaskWorkspaceDriftMarker,
  TaskWorkspaceLifecycleState,
  WorkspaceBinding,
  WorkspaceCleanupRefusalReason,
  WorkspaceCleanupMode,
  WorkspaceHealthReport,
  WorkspaceInstance,
  WorkspaceInfo,
  WorkspaceReconciliationReport,
  WorkspaceReconciliationStatus,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspacePointer, ActiveWorkspacePointerStore } from "./active-store.js";
import type { WorkspaceActivityLogSeam } from "./activity-log.js";
import type { WorkspaceInstanceStore } from "./store.js";
import type { WorkspaceMutexRegistry } from "./mutex.js";
import type { ProvenCreationTimeSupport } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { ManagedIdentityDrift } from "./gitdir-identity.js";

export interface WorkspaceProvisionRequest {
  // The repository request path the route already resolved (realpath'd project/arbitrary root). The
  // service resolves the git top-level from here before deriving identities.
  readonly repositoryRequestPath: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly requestedBy: string;
  // The triggering HTTP request's own correlation id (RouteContext.correlationId), threaded into this
  // operation's lifecycle evidence so the timeline it produces can be joined back to the request that
  // caused it (AGENTS.md §8). Undefined only for a caller with genuinely no request scope (e.g. an
  // internal repair re-materialization not driven by a fresh HTTP call) — the evidence layer falls
  // back to UNKNOWN_CORRELATION_ID in that case, never a silently reused workspace identity.
  readonly correlationId?: string | undefined;
  /**
   * This call IS the operator-approved recovery repair, not an ordinary provision.
   *
   * Only that path may reissue the identity of a worktree that already exists on disk. An ordinary
   * request must never do it: `recovery-required` is a completable state, so without the
   * distinction the very next identical request would silently upgrade an identity a guard just
   * refused — including a genuinely replaced worktree. Set exclusively by the repair service, which
   * requires `operatorApproved`.
   */
  readonly operatorApprovedRepair?: boolean | undefined;
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
  // See WorkspaceProvisionRequest.correlationId.
  readonly correlationId?: string | undefined;
}

export interface WorkspaceActivateResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
}

export interface WorkspaceProvisioningService {
  readonly provision: (request: WorkspaceProvisionRequest) => Promise<WorkspaceProvisionResult>;
  readonly activate: (request: WorkspaceActivateRequest) => Promise<WorkspaceActivateResult>;
  readonly getInstance: (workspaceId: string) => WorkspaceInstance | undefined;
  // Internal upgrade seam used by the active-binding authority after restart. It may repair only
  // server-owned Project/Manifest identity; it must never infer or renew execution trust.
  readonly ensureIdentity?: ((instance: WorkspaceInstance) => void) | undefined;
}

export type GitWorktreeAdapterFactory = (
  workspace: WorkspaceInfo,
  correlationId: string,
  fs?: WorkspaceFs,
) => GitWorktreeAdapter;

export interface WorkspaceProvisioningServiceDeps extends WorkspaceActivityLogSeam {
  readonly store: WorkspaceInstanceStore;
  readonly evidenceStore: EvidenceStore;
  // The Keiko-owned managed worktree root (absolute). Provisioning proves ownership of this before
  // writing any worktree under it.
  readonly managedRoot: string;
  // Builds a narrow worktree adapter bound to a repository root. Injected so tests can supply a fake.
  //
  // `correlationId` is part of the signature, not of the composition, because the adapter emits
  // termination evidence and that evidence must join the operation that caused it (AGENTS.md §8).
  // The port used to take only the workspace, so `deps.ts` had no id to give and stamped every one
  // of the five managed-worktree lanes with UNKNOWN_CORRELATION_ID — while the surrounding
  // workspace events on the SAME operation carried the real one, which is precisely the timeline
  // join this evidence exists to enable (PR #3355 review, P2). Callers pass the id they already
  // hold; `UNKNOWN_CORRELATION_ID` remains the sanctioned fallback where an operation genuinely
  // has none, never an ad-hoc string.
  readonly createAdapter: GitWorktreeAdapterFactory;
  readonly redactString: (input: string) => string;
  // Clock + id generator, injected for deterministic tests. `now` is epoch ms.
  readonly now: () => number;
  readonly newId: () => string;
  // Optional, tests only: whether every volume the identity hashes keeps a durable creation time.
  // Production uses the real proof (`proveCreationTimeSupport`): the managed root by probe, the
  // repository read-only at the common git directory the identity hashes (resolved through the
  // pointer a linked worktree or a separate-git-dir layout leaves at `<root>/.git`); an identity is
  // never minted on a volume whose "creation time" is the ctime under another name (#3376 review P2).
  readonly proveCreationTimeSupport?:
    | ((managedRoot: string, repositoryCommonDirectory: string) => ProvenCreationTimeSupport)
    | undefined;
  // The server-owned Project → single-root manifest identity for a managed worktree. Production
  // supplies the existing UiStore paired-write owner; tests may omit it when trust/catalog behavior
  // is outside their scope. Explicit provision may initialize exact trust; resume, activate, and
  // getActive call it idempotently without trust initialization so persisted pre-integration
  // workspaces are repaired before they are exposed as active.
  readonly ensureManagedWorkspaceIdentity?:
    ((instance: WorkspaceInstance, initializeTrust: boolean) => void) | undefined;
  // Optional: how long a provisioning/activation lock stays valid before it is treated as stale.
  readonly lockTtlMs?: number | undefined;
  // In-process serializer shared across all mutating workspace services (#449, ADR-0093 D1): provision
  // takes the `prov:<repo>:<task>` key, activate the `ws:<workspaceId>` key, so concurrent same-resource
  // mutations queue instead of racing. Must be the SAME instance the lifecycle/repair/cleanup services
  // hold so they serialize against each other on the shared `ws:` keyspace.
  readonly mutex: WorkspaceMutexRegistry;
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
  // See WorkspaceProvisionRequest.correlationId.
  readonly correlationId?: string | undefined;
}

export interface WorkspaceLifecycleActionRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
  // See WorkspaceProvisionRequest.correlationId.
  readonly correlationId?: string | undefined;
}

export interface WorkspaceLifecycleActionResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
}

export interface WorkspaceLifecycleService {
  // List the persisted instances for an already-resolved repository root.
  readonly list: (repositoryRoot: string) => readonly WorkspaceInstance[];
  // Every persisted instance across repositories — the switcher's inventory. The active pointer is
  // global, so a switch may target a workspace of ANY repository; an inventory scoped to the
  // selected folder hid every other repository's workspaces (a paused one could not be resumed
  // after a reload; observed live, 2026-09-03).
  readonly listAll: () => readonly WorkspaceInstance[];
  // Current active instance + derived binding + pointer, or undefined in unbound mode.
  // The request's correlation id, so a refused or unprovable binding on the read path joins the
  // request timeline; a proof that cannot run throws the classified IDENTITY_PROOF_FAILED (#3376).
  readonly getActive: (correlationId?: string) => ActiveWorkspaceView | undefined;
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

export interface WorkspaceLifecycleServiceDeps extends WorkspaceActivityLogSeam {
  readonly store: WorkspaceInstanceStore;
  readonly activePointerStore: ActiveWorkspacePointerStore;
  // The Keiko-owned managed worktree root. Active binding re-proves persisted paths are still
  // contained before exposing them to task-bound surfaces.
  readonly managedRoot: string;
  // Reused #445 service: setActive/resume delegate the lifecycle walk into `active` to it.
  readonly provisioning: WorkspaceProvisioningService;
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (input: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
  // Optional, tests only: the live managed-identity verdict for one instance. Production proves it
  // on disk (`liveManagedIdentityDrift`) before any binding or readiness state is exposed.
  readonly identityDrift?: ((instance: WorkspaceInstance) => ManagedIdentityDrift) | undefined;
  // Optional: how long a mutation lock stays valid before it is treated as stale. Mirrors provisioning.
  readonly lockTtlMs?: number | undefined;
  // The SAME shared in-process serializer the provisioning service holds (#449, ADR-0093 D1): pause /
  // handoff take the `ws:<workspaceId>` key; the setActive pointer write takes the `active:<repo>` key.
  readonly mutex: WorkspaceMutexRegistry;
}

// ─── #447 startup reconciliation + repair services ──────────────────────────────────────────────
// reconcile() walks the durable instances, verifies each against the real filesystem + git worktree
// state (containment, pointer, branch/HEAD, lock liveness), classifies it via the pure #444/#447
// contract, persists the classification within legal lifecycle transitions, and decides whether the
// last active workspace can be safely restored. report() derives the same report from the persisted
// content-free fields without re-running IO (the read-only GET surface). The repair service applies a
// controlled, operator-approval-gated recovery — reusing the #445 provisioning re-materialization path
// for worktree repairs, never a second git engine (SC1).

export interface WorkspaceReconciliationService {
  // Read-only: derive the report from the currently persisted instances (no filesystem/git IO).
  readonly report: (repositoryRoot?: string) => WorkspaceReconciliationReport;
  // Live: verify every (or one repository's) instance against disk + git, persist the classification,
  // and return the fresh report. Used at startup and by the explicit refresh route. `correlationId` is
  // the triggering HTTP request's own id (see WorkspaceProvisionRequest.correlationId); the startup
  // caller has no request scope and omits it, so evidence from that pass falls back to
  // UNKNOWN_CORRELATION_ID — genuinely correct there, since no request produced it.
  readonly reconcile: (
    repositoryRoot?: string,
    correlationId?: string,
  ) => Promise<WorkspaceReconciliationReport>;
}

export interface WorkspaceReconciliationServiceDeps extends WorkspaceActivityLogSeam {
  readonly store: WorkspaceInstanceStore;
  readonly activePointerStore: ActiveWorkspacePointerStore;
  readonly evidenceStore: EvidenceStore;
  // The Keiko-owned managed worktree root (absolute) — every persisted path is realpath-checked for
  // containment inside it before it is trusted (SC).
  readonly managedRoot: string;
  readonly createAdapter: GitWorktreeAdapterFactory;
  readonly redactString: (input: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
  readonly lockTtlMs?: number | undefined;
  // The SAME shared in-process serializer (#449, ADR-0093 D1): the live reconcile's whole per-instance
  // critical section (re-read + fact-gathering + classification + write) takes the `ws:<workspaceId>`
  // key, mirroring WorkspaceCleanupServiceDeps, so it cannot race — or write over the result of — a
  // concurrent activate/pause/repair/cleanup of the same workspace (KEIKO-0996, #3339).
  readonly mutex: WorkspaceMutexRegistry;
}

export type WorkspaceRepairOutcome = "repaired" | "operator-required";

export interface WorkspaceRepairRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly strategy: WorkspaceRecoveryStrategy;
  // The #444 `repair` operation requires operator approval; an automatic repair refuses to mutate
  // without it.
  readonly operatorApproved: boolean;
  // See WorkspaceProvisionRequest.correlationId.
  readonly correlationId?: string | undefined;
}

export interface WorkspaceRepairResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly strategy: WorkspaceRecoveryStrategy;
  // True when a controlled mutation completed; false when the recommended recovery needs an operator.
  readonly applied: boolean;
  readonly outcome: WorkspaceRepairOutcome;
  readonly status: WorkspaceReconciliationStatus;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly operatorActionRequired: boolean;
}

export interface WorkspaceRepairService {
  readonly repair: (request: WorkspaceRepairRequest) => Promise<WorkspaceRepairResult>;
}

export interface WorkspaceRepairServiceDeps extends WorkspaceActivityLogSeam {
  readonly store: WorkspaceInstanceStore;
  readonly activePointerStore: ActiveWorkspacePointerStore;
  readonly evidenceStore: EvidenceStore;
  // Reused #445 service: worktree-recreating repairs delegate the re-materialization walk to it.
  readonly provisioning: WorkspaceProvisioningService;
  readonly managedRoot: string;
  readonly createAdapter: GitWorktreeAdapterFactory;
  readonly redactString: (input: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
  readonly lockTtlMs?: number | undefined;
  // The SAME shared in-process serializer (#449, ADR-0093 D1): repair takes the `ws:<workspaceId>` key so
  // it cannot race a concurrent activate/pause/cleanup of the same workspace.
  readonly mutex: WorkspaceMutexRegistry;
}

// ─── #448 operational health + governed cleanup services ────────────────────────────────────────
// The health service is read-only: it gathers the SAME #447 reconciliation facts (no second engine),
// adds a live `git status` dirty probe + a managed-root ownership check, classifies via the pure
// contract, detects orphaned managed worktrees by cross-referencing the managed-root directory with the
// store, and returns a content-free WorkspaceHealthReport. It performs NO store writes and emits NO
// evidence — health is observation. The cleanup service is the mutating counterpart: it re-verifies
// containment + ownership + dirty + lock LIVE before any removal (never trusting the persisted path),
// removes through the governed adapter, deletes the retired row, clears the active pointer, and audits
// every outcome — treating a safety refusal as a first-class successful result, never an error.

// The health/cleanup services need exactly the reconciliation deps bundle (store, active pointer,
// evidence, managed root, adapter factory, redactor, clock, id). Aliased rather than re-declared so the
// shape can never drift from the fact-gathering path they reuse.
export type WorkspaceHealthServiceDeps = WorkspaceReconciliationServiceDeps;
// Cleanup is the MUTATING counterpart to health, so it carries the shared in-process serializer (#449,
// ADR-0093 D1) on top of the reconciliation fact-gathering deps: request/complete-cleanup take the
// `ws:<workspaceId>` key and each orphan sweep takes the orphan's derived `ws:` key, so a governed
// removal cannot race a concurrent mutation of the same workspace. Health stays read-only (no mutex).
export interface WorkspaceCleanupServiceDeps extends WorkspaceReconciliationServiceDeps {
  readonly mutex: WorkspaceMutexRegistry;
  // Inverse of ensureManagedWorkspaceIdentity. Production delegates to UiStore.deleteProject,
  // which removes the single-root manifest and its trust row in the same transaction.
  readonly removeManagedWorkspaceIdentity?: ((instance: WorkspaceInstance) => void) | undefined;
}

export interface WorkspaceHealthService {
  // Live: classify every persisted instance for a repository root (or all repositories) plus any
  // orphaned managed worktrees, and return the content-free report. Read-only — no persistence.
  readonly report: (
    repositoryRoot?: string,
    correlationId?: string,
  ) => Promise<WorkspaceHealthReport>;
}

export interface WorkspaceCleanupRequest {
  readonly workspaceId: string;
  readonly requestedBy: string;
  // The #444 request-cleanup / complete-cleanup operations both require operator approval.
  readonly operatorApproved: boolean;
  // `request` transitions a settled instance to cleanup-pending; `complete` performs the live-verified
  // governed physical removal of a cleanup-pending instance.
  readonly mode: WorkspaceCleanupMode;
  // See WorkspaceProvisionRequest.correlationId.
  readonly correlationId?: string | undefined;
}

export type WorkspaceCleanupOutcome = "requested" | "completed" | "refused";

export interface WorkspaceCleanupResult {
  readonly outcome: WorkspaceCleanupOutcome;
  readonly workspaceId: string;
  // present for `requested` (the freshly cleanup-pending instance).
  readonly instance?: WorkspaceInstance;
  // present for `refused` — the content-free reason the live safety gate declined removal (SC4).
  readonly refusalReason?: WorkspaceCleanupRefusalReason;
}

export interface WorkspaceOrphanCleanupRequest {
  readonly repositoryRoot?: string | undefined;
  readonly requestedBy: string;
  readonly operatorApproved: boolean;
  // See WorkspaceProvisionRequest.correlationId.
  readonly correlationId?: string | undefined;
}

export interface WorkspaceOrphanRefusal {
  readonly orphanId: string;
  readonly refusalReason: WorkspaceCleanupRefusalReason;
}

export interface WorkspaceOrphanCleanupResult {
  readonly removed: number;
  readonly refused: readonly WorkspaceOrphanRefusal[];
}

export interface WorkspaceCleanupService {
  // request-cleanup (settled → cleanup-pending) or complete-cleanup (governed physical removal).
  readonly cleanup: (request: WorkspaceCleanupRequest) => Promise<WorkspaceCleanupResult>;
  // Governed removal of orphaned managed worktrees (on-disk directories with no persisted record).
  readonly cleanupOrphans: (
    request: WorkspaceOrphanCleanupRequest,
  ) => Promise<WorkspaceOrphanCleanupResult>;
}
