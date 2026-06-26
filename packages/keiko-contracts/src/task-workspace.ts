// Public type contracts for the task-scoped isolated workspace domain (Issue #444, Epic #443).
// Ownership: the task-workspace domain — what a task-scoped isolated workspace IS, how a task binds
// to it, its lifecycle state machine, drift/recovery semantics, and the read-only vs mutating
// operation authority. Disjoint from the subsystems it DELEGATES to: it never re-implements Git
// mutation (owned by git-delivery.ts, #470), editor/runtime context (owned by editor-agent.ts /
// editor-session.ts, #1491), terminal mutation (keiko-tools terminal policy, ADR-0018), or workspace
// discovery + path containment (owned by @oscharko-dev/keiko-workspace). The delegation boundary is
// encoded as data in TASK_WORKSPACE_DELEGATED_SUBSYSTEMS so a second copy of any of those subsystems
// is structurally prevented (AC4).
//
// Leaf-package rules (ADR-0019): pure types, frozen `as const` tables, and pure functions only. No IO,
// no clock, no crypto, no randomness, and no imports of any @oscharko-dev/* package. Hashes, ids, and
// correlation ids are produced by callers (opaque strings); timestamps are caller-provided ISO strings.
// CONTENT-FREE invariant (SC3): every persisted/audit field is an opaque id/hash, a count, a boolean
// flag, an enum, an ISO timestamp string, or a branch/path name — NEVER source text, secrets, tokens,
// raw provider payloads, or unbounded command output. `validateWorkspaceEvent` enforces this by
// rejecting any unknown key (WORKSPACE_EVENT_ALLOWED_KEYS).

export const TASK_WORKSPACE_SCHEMA_VERSION = "1" as const;

// ─── Local type guards (copied per leaf convention; see git-repository.ts) ──────

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.length > 0;
}

function isBoolean(input: unknown): input is boolean {
  return typeof input === "boolean";
}

// ─── Validation result type (same shape as git-repository.ts validators) ────────

export interface TaskWorkspaceValidationOk {
  readonly ok: true;
}

export interface TaskWorkspaceValidationFail {
  readonly ok: false;
  readonly reasons: readonly string[];
}

export type TaskWorkspaceValidation = TaskWorkspaceValidationOk | TaskWorkspaceValidationFail;

// `validateTaskWorkspaceTransition` returns the same shape but is aliased so callers reading the
// transition result type read intent at the call site.
export type TaskWorkspaceTransitionValidation = TaskWorkspaceValidation;

// ─── Lifecycle states (10) ──────────────────────────────────────────────────────

export type TaskWorkspaceLifecycleState =
  | "provisioning"
  | "active"
  | "paused"
  | "handoff-ready"
  | "archived"
  | "merged"
  | "abandoned"
  | "recovery-required"
  | "failed"
  | "cleanup-pending";

export const TASK_WORKSPACE_LIFECYCLE_STATES: readonly TaskWorkspaceLifecycleState[] = [
  "provisioning",
  "active",
  "paused",
  "handoff-ready",
  "archived",
  "merged",
  "abandoned",
  "recovery-required",
  "failed",
  "cleanup-pending",
] as const;

export function isTaskWorkspaceLifecycleState(
  value: unknown,
): value is TaskWorkspaceLifecycleState {
  return (
    typeof value === "string" &&
    TASK_WORKSPACE_LIFECYCLE_STATES.includes(value as TaskWorkspaceLifecycleState)
  );
}

// ─── Legal transition matrix (AC2) ────────────────────────────────────────────────
// Self-transitions (from === to) are ILLEGAL: no state lists itself as a successor.

export const TASK_WORKSPACE_LEGAL_TRANSITIONS: Readonly<
  Record<TaskWorkspaceLifecycleState, readonly TaskWorkspaceLifecycleState[]>
> = {
  provisioning: ["active", "recovery-required", "failed", "cleanup-pending"],
  active: ["paused", "handoff-ready", "recovery-required", "failed", "cleanup-pending"],
  paused: [
    "active",
    "handoff-ready",
    "archived",
    "abandoned",
    "recovery-required",
    "cleanup-pending",
  ],
  "handoff-ready": [
    "active",
    "merged",
    "archived",
    "abandoned",
    "recovery-required",
    "cleanup-pending",
  ],
  merged: ["archived", "cleanup-pending"],
  archived: ["cleanup-pending"],
  abandoned: ["cleanup-pending"],
  "recovery-required": ["active", "paused", "failed", "abandoned", "cleanup-pending"],
  failed: ["recovery-required", "abandoned", "cleanup-pending"],
  "cleanup-pending": ["archived", "abandoned", "recovery-required"],
} as const;

export function isLegalTaskWorkspaceTransition(
  from: TaskWorkspaceLifecycleState,
  to: TaskWorkspaceLifecycleState,
): boolean {
  return TASK_WORKSPACE_LEGAL_TRANSITIONS[from].includes(to);
}

export function nextLegalTaskWorkspaceStates(
  from: TaskWorkspaceLifecycleState,
): readonly TaskWorkspaceLifecycleState[] {
  return TASK_WORKSPACE_LEGAL_TRANSITIONS[from];
}

// ─── Transition preconditions (SC4) ─────────────────────────────────────────────

export type TaskWorkspaceTransitionPrecondition =
  | "lock-held-by-actor"
  | "path-contained"
  | "worktree-clean"
  | "branch-ready"
  | "provider-ready"
  | "operator-approval";

export const TASK_WORKSPACE_TRANSITION_PRECONDITIONS: readonly TaskWorkspaceTransitionPrecondition[] =
  [
    "lock-held-by-actor",
    "path-contained",
    "worktree-clean",
    "branch-ready",
    "provider-ready",
    "operator-approval",
  ] as const;

export function isTaskWorkspaceTransitionPrecondition(
  value: unknown,
): value is TaskWorkspaceTransitionPrecondition {
  return (
    typeof value === "string" &&
    TASK_WORKSPACE_TRANSITION_PRECONDITIONS.includes(value as TaskWorkspaceTransitionPrecondition)
  );
}

// Data table keyed `${from}->${to}`. Every LEGAL transition that carries a precondition is listed;
// any legal transition absent from this table defaults to no preconditions ([]). All
// `*->cleanup-pending` transitions require operator-approval. Illegal transitions never reach this
// table — they are rejected first by validateTaskWorkspaceTransition.
const TASK_WORKSPACE_TRANSITION_PRECONDITION_TABLE: Readonly<
  Record<string, readonly TaskWorkspaceTransitionPrecondition[]>
> = {
  "provisioning->active": ["lock-held-by-actor", "path-contained", "branch-ready"],
  "provisioning->recovery-required": ["lock-held-by-actor"],
  "provisioning->failed": [],
  "provisioning->cleanup-pending": ["operator-approval"],
  "active->paused": ["lock-held-by-actor"],
  "active->handoff-ready": ["lock-held-by-actor", "worktree-clean"],
  "active->recovery-required": [],
  "active->failed": [],
  "active->cleanup-pending": ["operator-approval"],
  "paused->active": ["lock-held-by-actor", "path-contained"],
  "paused->handoff-ready": ["lock-held-by-actor", "worktree-clean"],
  "paused->archived": ["operator-approval"],
  "paused->abandoned": ["operator-approval"],
  "paused->recovery-required": [],
  "paused->cleanup-pending": ["operator-approval"],
  "handoff-ready->active": ["lock-held-by-actor", "path-contained"],
  "handoff-ready->merged": ["provider-ready", "operator-approval"],
  "handoff-ready->archived": ["operator-approval"],
  "handoff-ready->abandoned": ["operator-approval"],
  "handoff-ready->recovery-required": [],
  "handoff-ready->cleanup-pending": ["operator-approval"],
  "merged->archived": ["operator-approval"],
  "merged->cleanup-pending": ["operator-approval"],
  "archived->cleanup-pending": ["operator-approval"],
  "abandoned->cleanup-pending": ["operator-approval"],
  "recovery-required->active": ["lock-held-by-actor", "path-contained"],
  "recovery-required->paused": ["lock-held-by-actor"],
  "recovery-required->failed": [],
  "recovery-required->abandoned": ["operator-approval"],
  "recovery-required->cleanup-pending": ["operator-approval"],
  "failed->recovery-required": [],
  "failed->abandoned": ["operator-approval"],
  "failed->cleanup-pending": ["operator-approval"],
  "cleanup-pending->archived": ["lock-held-by-actor", "worktree-clean"],
  "cleanup-pending->abandoned": ["operator-approval"],
  "cleanup-pending->recovery-required": [],
} as const;

export function requiredTaskWorkspaceTransitionPreconditions(
  from: TaskWorkspaceLifecycleState,
  to: TaskWorkspaceLifecycleState,
): readonly TaskWorkspaceTransitionPrecondition[] {
  return TASK_WORKSPACE_TRANSITION_PRECONDITION_TABLE[`${from}->${to}`] ?? [];
}

// Caller-resolved boolean facts about the current attempt. Each maps to one precondition.
export interface TaskWorkspaceTransitionContext {
  readonly lockHeldByActor: boolean;
  readonly pathContained: boolean;
  readonly worktreeClean: boolean;
  readonly branchReady: boolean;
  readonly providerReady: boolean;
  readonly operatorApproved: boolean;
}

const PRECONDITION_CONTEXT_KEY: Readonly<
  Record<TaskWorkspaceTransitionPrecondition, keyof TaskWorkspaceTransitionContext>
> = {
  "lock-held-by-actor": "lockHeldByActor",
  "path-contained": "pathContained",
  "worktree-clean": "worktreeClean",
  "branch-ready": "branchReady",
  "provider-ready": "providerReady",
  "operator-approval": "operatorApproved",
} as const;

export interface TaskWorkspaceTransitionInput {
  readonly from: TaskWorkspaceLifecycleState;
  readonly to: TaskWorkspaceLifecycleState;
  readonly context: TaskWorkspaceTransitionContext;
}

export function validateTaskWorkspaceTransition(
  input: TaskWorkspaceTransitionInput,
): TaskWorkspaceTransitionValidation {
  const { from, to, context } = input;
  if (!isLegalTaskWorkspaceTransition(from, to)) {
    return { ok: false, reasons: [`illegal transition from ${from} to ${to}`] };
  }
  const reasons: string[] = [];
  for (const precondition of requiredTaskWorkspaceTransitionPreconditions(from, to)) {
    if (!context[PRECONDITION_CONTEXT_KEY[precondition]]) {
      reasons.push(`unmet precondition: ${precondition}`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── Health states ────────────────────────────────────────────────────────────

export type TaskWorkspaceHealth =
  | "healthy"
  | "degraded"
  | "drifted"
  | "locked-out"
  | "missing"
  | "unknown";

export const TASK_WORKSPACE_HEALTH_STATES: readonly TaskWorkspaceHealth[] = [
  "healthy",
  "degraded",
  "drifted",
  "locked-out",
  "missing",
  "unknown",
] as const;

export function isTaskWorkspaceHealth(value: unknown): value is TaskWorkspaceHealth {
  return (
    typeof value === "string" && TASK_WORKSPACE_HEALTH_STATES.includes(value as TaskWorkspaceHealth)
  );
}

// ─── Drift markers ──────────────────────────────────────────────────────────────

export type TaskWorkspaceDriftMarker =
  | "worktree-missing"
  | "gitdir-mismatch"
  | "head-moved"
  | "branch-deleted"
  | "uncommitted-changes"
  | "lock-stale"
  | "path-escape"
  | "pointer-stale";

export const TASK_WORKSPACE_DRIFT_MARKERS: readonly TaskWorkspaceDriftMarker[] = [
  "worktree-missing",
  "gitdir-mismatch",
  "head-moved",
  "branch-deleted",
  "uncommitted-changes",
  "lock-stale",
  "path-escape",
  "pointer-stale",
] as const;

export function isTaskWorkspaceDriftMarker(value: unknown): value is TaskWorkspaceDriftMarker {
  return (
    typeof value === "string" &&
    TASK_WORKSPACE_DRIFT_MARKERS.includes(value as TaskWorkspaceDriftMarker)
  );
}

// ─── Lock ───────────────────────────────────────────────────────────────────────

export type WorkspaceLockReason = "provisioning" | "activation" | "mutation" | "repair" | "cleanup";

export const WORKSPACE_LOCK_REASONS: readonly WorkspaceLockReason[] = [
  "provisioning",
  "activation",
  "mutation",
  "repair",
  "cleanup",
] as const;

export function isWorkspaceLockReason(value: unknown): value is WorkspaceLockReason {
  return typeof value === "string" && WORKSPACE_LOCK_REASONS.includes(value as WorkspaceLockReason);
}

export interface WorkspaceLock {
  readonly lockId: string;
  readonly owner: string;
  readonly reason: WorkspaceLockReason;
  readonly acquiredAt: string;
  readonly expiresAt?: string;
}

// ─── Recovery hint ────────────────────────────────────────────────────────────────
// WORKSPACE recovery only. GIT-MUTATION recovery stays owned by #470 (git-delivery recovery hints).

export type WorkspaceRecoveryStrategy =
  | "reconcile-pointer"
  | "recreate-worktree"
  | "reattach-branch"
  | "release-stale-lock"
  | "commit-or-stash-required"
  | "operator-repair"
  | "abandon-and-cleanup";

export const WORKSPACE_RECOVERY_STRATEGIES: readonly WorkspaceRecoveryStrategy[] = [
  "reconcile-pointer",
  "recreate-worktree",
  "reattach-branch",
  "release-stale-lock",
  "commit-or-stash-required",
  "operator-repair",
  "abandon-and-cleanup",
] as const;

export function isWorkspaceRecoveryStrategy(value: unknown): value is WorkspaceRecoveryStrategy {
  return (
    typeof value === "string" &&
    WORKSPACE_RECOVERY_STRATEGIES.includes(value as WorkspaceRecoveryStrategy)
  );
}

export interface WorkspaceRecoveryHint {
  readonly marker: TaskWorkspaceDriftMarker;
  readonly strategy: WorkspaceRecoveryStrategy;
  readonly operatorActionRequired: boolean;
}

// ─── Surfaces ─────────────────────────────────────────────────────────────────────

export type WorkspaceSurface =
  | "chat"
  | "files"
  | "terminal"
  | "browser"
  | "editor"
  | "runtime"
  | "git-delivery"
  | "review";

export const TASK_WORKSPACE_SURFACES: readonly WorkspaceSurface[] = [
  "chat",
  "files",
  "terminal",
  "browser",
  "editor",
  "runtime",
  "git-delivery",
  "review",
] as const;

export function isWorkspaceSurface(value: unknown): value is WorkspaceSurface {
  return typeof value === "string" && TASK_WORKSPACE_SURFACES.includes(value as WorkspaceSurface);
}

// ─── Content-free audit event (SC3) ──────────────────────────────────────────────

export type WorkspaceEventType =
  | "provisioned"
  | "activated"
  | "paused"
  | "resumed"
  | "handoff-prepared"
  | "merged"
  | "archived"
  | "abandoned"
  | "recovery-flagged"
  | "repaired"
  | "cleanup-requested"
  | "cleanup-completed"
  | "lock-acquired"
  | "lock-released"
  | "drift-detected"
  | "health-changed"
  | "transition-rejected";

export const WORKSPACE_EVENT_TYPES: readonly WorkspaceEventType[] = [
  "provisioned",
  "activated",
  "paused",
  "resumed",
  "handoff-prepared",
  "merged",
  "archived",
  "abandoned",
  "recovery-flagged",
  "repaired",
  "cleanup-requested",
  "cleanup-completed",
  "lock-acquired",
  "lock-released",
  "drift-detected",
  "health-changed",
  "transition-rejected",
] as const;

export function isWorkspaceEventType(value: unknown): value is WorkspaceEventType {
  return typeof value === "string" && WORKSPACE_EVENT_TYPES.includes(value as WorkspaceEventType);
}

export interface WorkspaceEvent {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly type: WorkspaceEventType;
  readonly at: string;
  readonly correlationId: string;
  readonly fromState?: TaskWorkspaceLifecycleState;
  readonly toState?: TaskWorkspaceLifecycleState;
  readonly health?: TaskWorkspaceHealth;
  readonly driftMarkers?: readonly TaskWorkspaceDriftMarker[];
  readonly lockId?: string;
}

// The closed set of keys a WorkspaceEvent may carry. Any other key means an attempt to smuggle
// source text / secrets / raw payloads through the audit stream, so the validator rejects it (SC3).
export const WORKSPACE_EVENT_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "eventId",
  "workspaceId",
  "taskId",
  "type",
  "at",
  "correlationId",
  "fromState",
  "toState",
  "health",
  "driftMarkers",
  "lockId",
] as const;

// eslint-disable-next-line complexity
export function validateWorkspaceEvent(input: unknown): TaskWorkspaceValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["event must be an object"] };
  for (const key of Object.keys(input)) {
    if (!WORKSPACE_EVENT_ALLOWED_KEYS.includes(key)) {
      reasons.push(`unknown key not allowed (content-free): ${key}`);
    }
  }
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  for (const key of ["eventId", "workspaceId", "taskId", "at", "correlationId"] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
  }
  if (!isWorkspaceEventType(input.type)) reasons.push("type invalid");
  if (input.fromState !== undefined && !isTaskWorkspaceLifecycleState(input.fromState)) {
    reasons.push("fromState invalid");
  }
  if (input.toState !== undefined && !isTaskWorkspaceLifecycleState(input.toState)) {
    reasons.push("toState invalid");
  }
  if (input.health !== undefined && !isTaskWorkspaceHealth(input.health)) {
    reasons.push("health invalid");
  }
  if (input.driftMarkers !== undefined) {
    if (!Array.isArray(input.driftMarkers)) reasons.push("driftMarkers must be an array");
    else if (!input.driftMarkers.every(isTaskWorkspaceDriftMarker)) {
      reasons.push("driftMarkers contains an invalid marker");
    }
  }
  if (input.lockId !== undefined && !isNonEmptyString(input.lockId)) {
    reasons.push("lockId must be a non-empty string when present");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── WorkspaceInstance (durable persisted object) ──────────────────────────────────

export interface WorkspaceInstance {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly baseBranch: string;
  readonly taskBranch: string;
  readonly managedWorktreePath: string;
  readonly gitdirIdentity: string;
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly health: TaskWorkspaceHealth;
  readonly lock: WorkspaceLock | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
  readonly lastVerifiedHead?: string;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  readonly auditCorrelationId: string;
}

function validateWorkspaceLock(input: unknown, reasons: string[]): void {
  if (!isRecord(input)) {
    reasons.push("lock must be an object or null");
    return;
  }
  for (const key of ["lockId", "owner", "acquiredAt"] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`lock.${key} must be a non-empty string`);
  }
  if (!isWorkspaceLockReason(input.reason)) reasons.push("lock.reason invalid");
  if (input.expiresAt !== undefined && !isNonEmptyString(input.expiresAt)) {
    reasons.push("lock.expiresAt must be a non-empty string when present");
  }
}

function validateRecoveryHints(input: unknown, reasons: string[]): void {
  if (!Array.isArray(input)) {
    reasons.push("recoveryHints must be an array");
    return;
  }
  input.forEach((hint, index) => {
    if (!isRecord(hint)) {
      reasons.push(`recoveryHints[${String(index)}] must be an object`);
      return;
    }
    if (!isTaskWorkspaceDriftMarker(hint.marker)) {
      reasons.push(`recoveryHints[${String(index)}].marker invalid`);
    }
    if (!isWorkspaceRecoveryStrategy(hint.strategy)) {
      reasons.push(`recoveryHints[${String(index)}].strategy invalid`);
    }
    if (!isBoolean(hint.operatorActionRequired)) {
      reasons.push(`recoveryHints[${String(index)}].operatorActionRequired must be a boolean`);
    }
  });
}

// eslint-disable-next-line complexity
export function validateWorkspaceInstance(input: unknown): TaskWorkspaceValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["instance must be an object"] };
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  for (const key of [
    "workspaceId",
    "taskId",
    "repositoryId",
    "repositoryRoot",
    "baseBranch",
    "taskBranch",
    "managedWorktreePath",
    "gitdirIdentity",
    "createdAt",
    "updatedAt",
    "auditCorrelationId",
  ] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
  }
  if (!isTaskWorkspaceLifecycleState(input.lifecycleState)) reasons.push("lifecycleState invalid");
  if (!isTaskWorkspaceHealth(input.health)) reasons.push("health invalid");
  if (input.lock !== null) validateWorkspaceLock(input.lock, reasons);
  if (input.lastVerifiedAt !== undefined && !isNonEmptyString(input.lastVerifiedAt)) {
    reasons.push("lastVerifiedAt must be a non-empty string when present");
  }
  if (input.lastVerifiedHead !== undefined && !isNonEmptyString(input.lastVerifiedHead)) {
    reasons.push("lastVerifiedHead must be a non-empty string when present");
  }
  if (!Array.isArray(input.driftMarkers)) reasons.push("driftMarkers must be an array");
  else if (!input.driftMarkers.every(isTaskWorkspaceDriftMarker)) {
    reasons.push("driftMarkers contains an invalid marker");
  }
  validateRecoveryHints(input.recoveryHints, reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── WorkspaceBinding (the authoritative active project root) ────────────────────────
// gitDeliveryRoot === activeRoot is consumed by #470 WITHOUT new authority; editorProjectRoot ===
// activeRoot is bound by #1491 WITHOUT duplicating project-context logic. Path-containment
// ENFORCEMENT remains delegated to @oscharko-dev/keiko-workspace (AC4).

export interface WorkspaceBinding {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly activeRoot: string;
  readonly boundSurfaces: readonly WorkspaceSurface[];
  readonly gitDeliveryRoot: string;
  readonly editorProjectRoot: string;
}

// eslint-disable-next-line complexity
export function validateWorkspaceBinding(input: unknown): TaskWorkspaceValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["binding must be an object"] };
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  for (const key of [
    "workspaceId",
    "taskId",
    "activeRoot",
    "gitDeliveryRoot",
    "editorProjectRoot",
  ] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(input.boundSurfaces)) reasons.push("boundSurfaces must be an array");
  else if (!input.boundSurfaces.every(isWorkspaceSurface)) {
    reasons.push("boundSurfaces contains an invalid surface");
  }
  if (isNonEmptyString(input.activeRoot)) {
    if (input.gitDeliveryRoot !== input.activeRoot) {
      reasons.push("gitDeliveryRoot must equal activeRoot");
    }
    if (input.editorProjectRoot !== input.activeRoot) {
      reasons.push("editorProjectRoot must equal activeRoot");
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── WorkspaceActivation (mutating server-action intent) ────────────────────────────

export interface WorkspaceActivation {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly requestedBy: string;
  readonly acquireLock: boolean;
  readonly expectedLifecycleState?: TaskWorkspaceLifecycleState;
}

export function validateWorkspaceActivation(input: unknown): TaskWorkspaceValidation {
  const reasons: string[] = [];
  if (!isRecord(input)) return { ok: false, reasons: ["activation must be an object"] };
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  for (const key of ["workspaceId", "taskId", "requestedBy"] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
  }
  if (!isBoolean(input.acquireLock)) reasons.push("acquireLock must be a boolean");
  if (
    input.expectedLifecycleState !== undefined &&
    !isTaskWorkspaceLifecycleState(input.expectedLifecycleState)
  ) {
    reasons.push("expectedLifecycleState invalid");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── Operation authority (AC3) ──────────────────────────────────────────────────────

export type WorkspaceOperationAuthority = "read-only" | "mutating-server-action";

export type WorkspaceOperationName =
  | "discover"
  | "get-instance"
  | "get-health"
  | "resolve-binding"
  | "provision"
  | "activate"
  | "pause"
  | "resume"
  | "prepare-handoff"
  | "mark-merged"
  | "archive"
  | "abandon"
  | "flag-recovery"
  | "repair"
  | "request-cleanup"
  | "complete-cleanup"
  | "acquire-lock"
  | "release-lock"
  | "append-event";

export interface WorkspaceOperation {
  readonly name: WorkspaceOperationName;
  readonly authority: WorkspaceOperationAuthority;
  readonly requiresLock: boolean;
  readonly requiresOperatorApproval: boolean;
}

export const TASK_WORKSPACE_OPERATIONS: readonly WorkspaceOperation[] = [
  {
    name: "discover",
    authority: "read-only",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "get-instance",
    authority: "read-only",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "get-health",
    authority: "read-only",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "resolve-binding",
    authority: "read-only",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "provision",
    authority: "mutating-server-action",
    requiresLock: true,
    requiresOperatorApproval: false,
  },
  {
    name: "activate",
    authority: "mutating-server-action",
    requiresLock: true,
    requiresOperatorApproval: false,
  },
  {
    name: "pause",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "resume",
    authority: "mutating-server-action",
    requiresLock: true,
    requiresOperatorApproval: false,
  },
  {
    name: "prepare-handoff",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "mark-merged",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "archive",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "abandon",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "flag-recovery",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "repair",
    authority: "mutating-server-action",
    requiresLock: true,
    requiresOperatorApproval: true,
  },
  {
    name: "request-cleanup",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: true,
  },
  {
    name: "complete-cleanup",
    authority: "mutating-server-action",
    requiresLock: true,
    requiresOperatorApproval: true,
  },
  {
    name: "acquire-lock",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "release-lock",
    authority: "mutating-server-action",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
  {
    name: "append-event",
    authority: "read-only",
    requiresLock: false,
    requiresOperatorApproval: false,
  },
] as const;

export function taskWorkspaceOperation(
  name: WorkspaceOperationName,
): WorkspaceOperation | undefined {
  return TASK_WORKSPACE_OPERATIONS.find((operation) => operation.name === name);
}

export function isReadOnlyTaskWorkspaceOperation(name: WorkspaceOperationName): boolean {
  return taskWorkspaceOperation(name)?.authority === "read-only";
}

export function isMutatingTaskWorkspaceOperation(name: WorkspaceOperationName): boolean {
  return taskWorkspaceOperation(name)?.authority === "mutating-server-action";
}

// ─── No-duplicate-subsystem boundary (AC4) ────────────────────────────────────────
// This contract defines NO git mutation, NO editor runtime, NO terminal mutation, and NO new
// path-containment engine. Those four concerns are DELEGATED to their owning subsystems. The
// leaf-package rule (ADR-0019) enforces this at compile time — keiko-contracts cannot import any of
// those packages — and this table makes the delegation explicit for downstream readers and tests.

export type TaskWorkspaceDelegatedConcern =
  | "git-mutation"
  | "editor-runtime-context"
  | "terminal-mutation"
  | "workspace-discovery-and-containment";

export interface TaskWorkspaceDelegatedSubsystem {
  readonly concern: TaskWorkspaceDelegatedConcern;
  readonly owner: string;
}

export const TASK_WORKSPACE_DELEGATED_SUBSYSTEMS: readonly TaskWorkspaceDelegatedSubsystem[] = [
  { concern: "git-mutation", owner: "git-delivery (#470)" },
  { concern: "editor-runtime-context", owner: "editor-agent / editor-session (#1491)" },
  { concern: "terminal-mutation", owner: "keiko-tools terminal policy (ADR-0018) — unchanged" },
  {
    concern: "workspace-discovery-and-containment",
    owner: "@oscharko-dev/keiko-workspace",
  },
] as const;

export function isDelegatedTaskWorkspaceConcern(
  concern: unknown,
): concern is TaskWorkspaceDelegatedConcern {
  return (
    typeof concern === "string" &&
    TASK_WORKSPACE_DELEGATED_SUBSYSTEMS.some((entry) => entry.concern === concern)
  );
}

export function taskWorkspaceDelegatedOwner(
  concern: TaskWorkspaceDelegatedConcern,
): string | undefined {
  return TASK_WORKSPACE_DELEGATED_SUBSYSTEMS.find((entry) => entry.concern === concern)?.owner;
}
