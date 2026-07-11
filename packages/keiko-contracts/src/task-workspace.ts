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
// raw provider payloads, or unbounded command output. Enforced at runtime by rejecting any unknown
// key against a closed allowlist in EVERY persisted-object validator — the audit event
// (validateWorkspaceEvent / WORKSPACE_EVENT_ALLOWED_KEYS), the durable instance
// (validateWorkspaceInstance / WORKSPACE_INSTANCE_ALLOWED_KEYS), the binding
// (validateWorkspaceBinding / WORKSPACE_BINDING_ALLOWED_KEYS), and the activation intent
// (validateWorkspaceActivation / WORKSPACE_ACTIVATION_ALLOWED_KEYS) — so a downstream persistence
// layer that trusts `.ok` cannot store smuggled content through any shape.

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

// Collect "unknown key not allowed" reasons for a content-free object: any key outside the closed
// allowlist is treated as an attempt to smuggle source text / secrets / tokens / raw payloads, so
// the validator rejects it (SC3). Shared by the audit-event validator AND the persisted-object
// validators (instance/binding/activation) so the content-free invariant is enforced uniformly
// across the durable surface, not only the event stream.
function unknownKeyReasons(
  input: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): string[] {
  const reasons: string[] = [];
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      reasons.push(`unknown key not allowed (content-free): ${key}`);
    }
  }
  return reasons;
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

// `from`/`to` are guarded with isTaskWorkspaceLifecycleState before the table lookup so a
// post-deserialization or wire-supplied non-state value (e.g. "", "__proto__", "constructor", a
// number, null) fails CLOSED — returns false / [] — instead of throwing or resolving to a
// prototype-chain value. This keeps every exported predicate throw-free on `unknown` input,
// matching the sibling validators (ADR-0088 D6).
export function isLegalTaskWorkspaceTransition(
  from: TaskWorkspaceLifecycleState,
  to: TaskWorkspaceLifecycleState,
): boolean {
  if (!isTaskWorkspaceLifecycleState(from) || !isTaskWorkspaceLifecycleState(to)) return false;
  return TASK_WORKSPACE_LEGAL_TRANSITIONS[from].includes(to);
}

export function nextLegalTaskWorkspaceStates(
  from: TaskWorkspaceLifecycleState,
): readonly TaskWorkspaceLifecycleState[] {
  if (!isTaskWorkspaceLifecycleState(from)) return [];
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
  "healthy" | "degraded" | "drifted" | "locked-out" | "missing" | "unknown";

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

// ─── Failure classification ───────────────────────────────────────────────────────
// The caller-facing failure vocabulary (Issue #449, ADR-0093). It is a DISTINCT axis from the
// evidence-recording outcome (`blocked`/`failed`/`retry-required`): the outcome describes what the
// ledger saw, this class describes what the CALLER should do next. The keiko-server error taxonomy maps
// every `TaskWorkspaceErrorCode` onto exactly one of these classes (`classifyTaskWorkspaceError`), so a
// BFF/UI caller can branch on a stable, content-free signal instead of a raw code list.
//
//   retryable     — transient/contended; the SAME request may succeed if retried as-is (e.g. a live
//                   advisory lock held by another actor that will expire).
//   repairable    — a drift/partial state that #447 reconciliation + repair resolves; a bare retry would
//                   re-hit the same stale condition, so the caller routes to repair.
//   blocked       — a precondition/validation/conflict gate; the caller must change inputs or environment.
//   policy-denied — an authority/approval gate (operator approval, eligibility); needs governance, not retry.
//   terminal      — a non-recoverable server fault; do not retry without out-of-band intervention.
export type WorkspaceFailureClass =
  "retryable" | "repairable" | "blocked" | "policy-denied" | "terminal";

export const WORKSPACE_FAILURE_CLASSES: readonly WorkspaceFailureClass[] = [
  "retryable",
  "repairable",
  "blocked",
  "policy-denied",
  "terminal",
] as const;

export function isWorkspaceFailureClass(value: unknown): value is WorkspaceFailureClass {
  return (
    typeof value === "string" && WORKSPACE_FAILURE_CLASSES.includes(value as WorkspaceFailureClass)
  );
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
  "chat" | "files" | "terminal" | "browser" | "editor" | "runtime" | "git-delivery" | "review";

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

// Optional lifecycle-transition fields (fromState/toState/health): only checked when present, since
// not every event type carries a transition. Split out of validateWorkspaceEvent to keep it within
// the complexity budget while preserving the exact same checks in the same order.
function validateWorkspaceEventLifecycleFields(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.fromState !== undefined && !isTaskWorkspaceLifecycleState(input.fromState)) {
    reasons.push("fromState invalid");
  }
  if (input.toState !== undefined && !isTaskWorkspaceLifecycleState(input.toState)) {
    reasons.push("toState invalid");
  }
  if (input.health !== undefined && !isTaskWorkspaceHealth(input.health)) {
    reasons.push("health invalid");
  }
}

// Optional driftMarkers/lockId fields: only checked when present. Split out of validateWorkspaceEvent
// alongside validateWorkspaceEventLifecycleFields for the same reason.
function validateWorkspaceEventDriftAndLock(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
): void {
  if (input.driftMarkers !== undefined) {
    if (!Array.isArray(input.driftMarkers)) reasons.push("driftMarkers must be an array");
    else if (!input.driftMarkers.every(isTaskWorkspaceDriftMarker)) {
      reasons.push("driftMarkers contains an invalid marker");
    }
  }
  if (input.lockId !== undefined && !isNonEmptyString(input.lockId)) {
    reasons.push("lockId must be a non-empty string when present");
  }
}

export function validateWorkspaceEvent(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["event must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_EVENT_ALLOWED_KEYS);
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  for (const key of ["eventId", "workspaceId", "taskId", "at", "correlationId"] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
  }
  if (!isWorkspaceEventType(input.type)) reasons.push("type invalid");
  validateWorkspaceEventLifecycleFields(input, reasons);
  validateWorkspaceEventDriftAndLock(input, reasons);
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

// The closed set of top-level keys a persisted WorkspaceInstance may carry. Enforced by
// validateWorkspaceInstance so the durable record stays content-free (SC3): a #447 persistence layer
// that trusts `validateWorkspaceInstance(input).ok` cannot store a record carrying a smuggled
// `sourceDiff` / `commandOutput` / `tokenValue` field. Nested `lock` and `recoveryHints` shapes are
// validated by their own helpers.
export const WORKSPACE_INSTANCE_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "workspaceId",
  "taskId",
  "repositoryId",
  "repositoryRoot",
  "baseBranch",
  "taskBranch",
  "managedWorktreePath",
  "gitdirIdentity",
  "lifecycleState",
  "health",
  "lock",
  "createdAt",
  "updatedAt",
  "lastVerifiedAt",
  "lastVerifiedHead",
  "driftMarkers",
  "recoveryHints",
  "auditCorrelationId",
] as const;

// eslint-disable-next-line complexity
export function validateWorkspaceInstance(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["instance must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_INSTANCE_ALLOWED_KEYS);
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

// The closed set of keys a WorkspaceBinding may carry (content-free, SC3).
export const WORKSPACE_BINDING_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "workspaceId",
  "taskId",
  "activeRoot",
  "boundSurfaces",
  "gitDeliveryRoot",
  "editorProjectRoot",
] as const;

// eslint-disable-next-line complexity
export function validateWorkspaceBinding(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["binding must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_BINDING_ALLOWED_KEYS);
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

// The closed set of keys a WorkspaceActivation intent may carry (content-free, SC3).
export const WORKSPACE_ACTIVATION_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "workspaceId",
  "taskId",
  "requestedBy",
  "acquireLock",
  "expectedLifecycleState",
] as const;

export function validateWorkspaceActivation(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["activation must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_ACTIVATION_ALLOWED_KEYS);
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

// ─── Startup reconciliation + repair (Issue #447) ───────────────────────────────────
// #445 made a workspace's durable record; #446 made the active binding. #447 turns those into
// trustworthy OPERATIONAL state across restarts/partial failures/external filesystem changes/git
// worktree drift. ALL reconciliation decision logic lives here as pure functions over content-free
// FACTS the server gathers by IO (path existence, realpath containment, git pointer/HEAD/branch
// identity, lock liveness) — the keiko-server service is a thin IO+persistence+evidence shell. This
// keeps classification deterministic and 100%-testable, and (AC5) lets #446 UI and #448 health/audit/
// cleanup/verification consume the SAME semantics without inventing their own.

// The eight Issue-mandated reconciliation classifications. `partially-created` = a workspace that never
// completed initial provisioning (lifecycle still provisioning/failed). `stale-pointer` = the worktree
// directory exists but its `.git` linked-worktree pointer is missing/malformed or points elsewhere.
// `unmanaged-path` = the persisted managed-worktree path no longer realpath-resolves inside the
// Keiko-owned managed root (a containment escape — never auto-repairable). `locked` = a live lock held
// by another actor, so reconciliation defers rather than racing it.
export type WorkspaceReconciliationStatus =
  | "healthy"
  | "missing"
  | "drifted"
  | "locked"
  | "partially-created"
  | "stale-pointer"
  | "unmanaged-path"
  | "recovery-required";

export const WORKSPACE_RECONCILIATION_STATUSES: readonly WorkspaceReconciliationStatus[] = [
  "healthy",
  "missing",
  "drifted",
  "locked",
  "partially-created",
  "stale-pointer",
  "unmanaged-path",
  "recovery-required",
] as const;

export function isWorkspaceReconciliationStatus(
  value: unknown,
): value is WorkspaceReconciliationStatus {
  return (
    typeof value === "string" &&
    WORKSPACE_RECONCILIATION_STATUSES.includes(value as WorkspaceReconciliationStatus)
  );
}

// The content-free facts the server resolves by IO for one persisted instance, fed to the pure
// classifier. Every field is a boolean or the persisted lifecycle enum — no path, no command output.
export interface WorkspaceReconciliationFacts {
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  // realpath containment of the persisted managed-worktree path inside the managed root (SC: a
  // persisted path is NEVER trusted without realpath verification).
  readonly pathContained: boolean;
  readonly worktreeDirExists: boolean;
  // the worktree's `.git` linked-worktree pointer file is present and well-formed.
  readonly gitPointerPresent: boolean;
  // the pointer's content-free gitdir identity equals the persisted `gitdirIdentity`.
  readonly gitdirIdentityMatches: boolean;
  // the dedicated task branch still exists / the worktree is still bound to it.
  readonly taskBranchPresent: boolean;
  // the worktree HEAD equals the persisted `lastVerifiedHead` (true when no baseline was recorded).
  readonly headMatches: boolean;
  readonly uncommittedChanges: boolean;
  readonly lockPresent: boolean;
  readonly lockLive: boolean;
  readonly lockedByOtherActor: boolean;
}

export interface WorkspaceReconciliationOutcome {
  readonly status: WorkspaceReconciliationStatus;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
}

// Lifecycle states past the operational window: a missing worktree for one of these is EXPECTED
// (cleanup), so reconciliation treats them as settled rather than drifted.
const TERMINAL_LIFECYCLE_STATES: readonly TaskWorkspaceLifecycleState[] = [
  "merged",
  "archived",
  "abandoned",
  "cleanup-pending",
] as const;

const PARTIAL_LIFECYCLE_STATES: readonly TaskWorkspaceLifecycleState[] = [
  "provisioning",
  "failed",
] as const;

// The single authoritative map from a drift marker to its recovery strategy + whether an operator
// must act (e.g. a moved HEAD or uncommitted work may carry intentional changes, and a containment
// escape is never auto-repaired). Consumed by both reconciliation and the repair service (AC5).
const DRIFT_MARKER_RECOVERY: Readonly<
  Record<
    TaskWorkspaceDriftMarker,
    { readonly strategy: WorkspaceRecoveryStrategy; readonly operatorActionRequired: boolean }
  >
> = {
  "worktree-missing": { strategy: "recreate-worktree", operatorActionRequired: false },
  // A moved-but-readable gitdir can be re-linked automatically (the pointer identity is re-derived);
  // a missing/corrupt `.git` pointer cannot be repaired by the narrow worktree adapter without risking
  // loss of the worktree's uncommitted work, so it is operator-guided.
  "gitdir-mismatch": { strategy: "reconcile-pointer", operatorActionRequired: false },
  "pointer-stale": { strategy: "operator-repair", operatorActionRequired: true },
  "head-moved": { strategy: "operator-repair", operatorActionRequired: true },
  // A deleted local branch cannot be safely re-created by the narrow worktree adapter without risking
  // loss of the worktree's commits, so reattachment is operator-guided, never automatic.
  "branch-deleted": { strategy: "reattach-branch", operatorActionRequired: true },
  "uncommitted-changes": { strategy: "commit-or-stash-required", operatorActionRequired: true },
  "lock-stale": { strategy: "release-stale-lock", operatorActionRequired: false },
  "path-escape": { strategy: "operator-repair", operatorActionRequired: true },
} as const;

// Pure: map a set of drift markers to ordered, de-duplicated recovery hints. The order follows the
// input marker order so the most salient drift drives the first suggested repair.
export function planWorkspaceRecoveryHints(
  driftMarkers: readonly TaskWorkspaceDriftMarker[],
): readonly WorkspaceRecoveryHint[] {
  const hints: WorkspaceRecoveryHint[] = [];
  const seen = new Set<TaskWorkspaceDriftMarker>();
  for (const marker of driftMarkers) {
    if (!isTaskWorkspaceDriftMarker(marker) || seen.has(marker)) continue;
    seen.add(marker);
    const mapping = DRIFT_MARKER_RECOVERY[marker];
    hints.push({
      marker,
      strategy: mapping.strategy,
      operatorActionRequired: mapping.operatorActionRequired,
    });
  }
  return hints;
}

function withStaleLock(
  markers: readonly TaskWorkspaceDriftMarker[],
  facts: WorkspaceReconciliationFacts,
): readonly TaskWorkspaceDriftMarker[] {
  return facts.lockPresent && !facts.lockLive ? [...markers, "lock-stale"] : markers;
}

function outcome(
  status: WorkspaceReconciliationStatus,
  markers: readonly TaskWorkspaceDriftMarker[],
): WorkspaceReconciliationOutcome {
  return { status, driftMarkers: markers, recoveryHints: planWorkspaceRecoveryHints(markers) };
}

// The drift marker (if any) for a partially-created (provisioning/failed) workspace: still creating
// its worktree, or the worktree exists but the git pointer hasn't landed yet. Split out of
// classifyWorkspaceReconciliation — same nested-ternary precedence, expressed as early returns.
function partialCreationMarkers(
  facts: WorkspaceReconciliationFacts,
): readonly TaskWorkspaceDriftMarker[] {
  if (!facts.worktreeDirExists) return ["worktree-missing"];
  if (!facts.gitPointerPresent) return ["pointer-stale"];
  return [];
}

// The on-disk drift chain for an operationally-active workspace (missing → stale pointer → gitdir
// mismatch → branch/HEAD/dirty), in the same fixed precedence as classifyWorkspaceReconciliation.
// Returns null when the worktree is fully in sync, so the caller falls through to the remaining
// (non-disk) checks.
function classifyOnDiskDrift(
  facts: WorkspaceReconciliationFacts,
): WorkspaceReconciliationOutcome | null {
  if (!facts.worktreeDirExists)
    return outcome("missing", withStaleLock(["worktree-missing"], facts));
  if (!facts.gitPointerPresent)
    return outcome("stale-pointer", withStaleLock(["pointer-stale"], facts));
  if (!facts.gitdirIdentityMatches) {
    return outcome("stale-pointer", withStaleLock(["gitdir-mismatch"], facts));
  }
  if (!facts.taskBranchPresent) return outcome("drifted", withStaleLock(["branch-deleted"], facts));
  if (!facts.headMatches) return outcome("drifted", withStaleLock(["head-moved"], facts));
  if (facts.uncommittedChanges) {
    return outcome("drifted", withStaleLock(["uncommitted-changes"], facts));
  }
  return null;
}

// Pure deterministic classifier with a fixed precedence (most severe first): a containment escape and
// a live foreign lock short-circuit before any disk classification; terminal lifecycles are settled;
// then partial-creation, then on-disk drift (missing → stale pointer → branch/HEAD/dirty), then a
// lingering recovery-required flag, then a stale lock on an otherwise-healthy workspace.
export function classifyWorkspaceReconciliation(
  facts: WorkspaceReconciliationFacts,
): WorkspaceReconciliationOutcome {
  if (!facts.pathContained) return outcome("unmanaged-path", ["path-escape"]);
  if (facts.lockedByOtherActor) return outcome("locked", []);
  if (TERMINAL_LIFECYCLE_STATES.includes(facts.lifecycleState)) return outcome("healthy", []);
  if (PARTIAL_LIFECYCLE_STATES.includes(facts.lifecycleState)) {
    return outcome("partially-created", withStaleLock(partialCreationMarkers(facts), facts));
  }
  const diskDrift = classifyOnDiskDrift(facts);
  if (diskDrift) return diskDrift;
  if (facts.lifecycleState === "recovery-required") {
    return outcome("recovery-required", withStaleLock([], facts));
  }
  if (facts.lockPresent && !facts.lockLive) return outcome("drifted", ["lock-stale"]);
  return outcome("healthy", []);
}

// Pure: the health enum value reconciliation persists for a given status, so the stored health stays
// consistent with the classification (and #448 can read either).
export function reconciliationHealth(status: WorkspaceReconciliationStatus): TaskWorkspaceHealth {
  switch (status) {
    case "healthy":
      return "healthy";
    case "missing":
      return "missing";
    case "drifted":
    case "stale-pointer":
      return "drifted";
    case "locked":
      return "locked-out";
    case "partially-created":
    case "unmanaged-path":
    case "recovery-required":
      return "degraded";
    default:
      return "unknown";
  }
}

// Pure: whether reconciliation should flag a once-operational workspace (active/paused/handoff-ready)
// as recovery-required because its worktree is GONE or structurally unusable (missing, a broken/moved
// git pointer, or an escaped path). A merely `drifted` workspace (moved HEAD, uncommitted work, branch
// mismatch, stale lock) keeps a usable worktree, so it is surfaced via health + drift markers + hints
// WITHOUT being forced out of its lifecycle — crisp classification over aggressive auto-healing. A
// partially-created (provisioning/failed) workspace is left to the provisioning retry path, and a live
// foreign lock is deferred, never flagged.
export function reconciliationRequiresRecoveryFlag(
  status: WorkspaceReconciliationStatus,
  lifecycleState: TaskWorkspaceLifecycleState,
): boolean {
  if (
    lifecycleState !== "active" &&
    lifecycleState !== "paused" &&
    lifecycleState !== "handoff-ready"
  ) {
    return false;
  }
  return status === "missing" || status === "stale-pointer" || status === "unmanaged-path";
}

// Pure: reconstruct the reconciliation status from the CONTENT-FREE persisted instance fields, so a
// read-only report can be derived without re-running IO (the GET surface) and matches what a live
// reconcile last persisted. Mirrors the precedence of classifyWorkspaceReconciliation.
// eslint-disable-next-line complexity
export function reconciliationStatusFromInstance(input: {
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly health: TaskWorkspaceHealth;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
}): WorkspaceReconciliationStatus {
  const markers = input.driftMarkers;
  if (markers.includes("path-escape")) return "unmanaged-path";
  if (input.health === "locked-out") return "locked";
  if (TERMINAL_LIFECYCLE_STATES.includes(input.lifecycleState)) return "healthy";
  if (PARTIAL_LIFECYCLE_STATES.includes(input.lifecycleState)) return "partially-created";
  if (markers.includes("worktree-missing")) return "missing";
  if (markers.includes("pointer-stale") || markers.includes("gitdir-mismatch")) {
    return "stale-pointer";
  }
  if (
    markers.includes("branch-deleted") ||
    markers.includes("head-moved") ||
    markers.includes("uncommitted-changes") ||
    markers.includes("lock-stale")
  ) {
    return "drifted";
  }
  if (input.lifecycleState === "recovery-required") return "recovery-required";
  return "healthy";
}

// ─── Repair applicability (Issue #447) ──────────────────────────────────────────────
// A repair may only apply a strategy the reconciliation actually recommended for the workspace, so a
// caller cannot drive an arbitrary git mutation: the repair service validates the requested strategy
// against the instance's current recovery hints. `abandon-and-cleanup` is the one universal escape
// (always available for a non-healthy workspace) and `operator-repair`/`commit-or-stash-required`
// signal that no automatic mutation is safe — the operator must act first.

// The strategies the repair service can apply WITHOUT operator action, because each is reversible /
// non-destructive: recreate a missing worktree from the still-present branch, refresh a stale/moved
// worktree pointer, or release an expired lock. `reattach-branch`, `operator-repair`, and
// `commit-or-stash-required` are deliberately excluded — they require a human decision.
export function isAutomaticWorkspaceRepairStrategy(strategy: WorkspaceRecoveryStrategy): boolean {
  return (
    strategy === "reconcile-pointer" ||
    strategy === "recreate-worktree" ||
    strategy === "release-stale-lock"
  );
}

// Pure: whether `strategy` is applicable given the recovery hints reconciliation produced. An
// automatic strategy is applicable iff a hint recommends it; `abandon-and-cleanup` is applicable for
// any non-healthy status; operator strategies are never "applicable" as an automatic repair.
export function isWorkspaceRepairStrategyApplicable(input: {
  readonly status: WorkspaceReconciliationStatus;
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  readonly strategy: WorkspaceRecoveryStrategy;
}): boolean {
  if (input.strategy === "abandon-and-cleanup") return input.status !== "healthy";
  if (!isAutomaticWorkspaceRepairStrategy(input.strategy)) return false;
  return input.recoveryHints.some(
    (hint) => hint.strategy === input.strategy && !hint.operatorActionRequired,
  );
}

// ─── Reconciliation report (Issue #447, content-free; consumed by #446 UI + #448) ────

// The per-workspace reconciliation record. Content-free: ids, enums, the existing drift-marker /
// recovery-hint shapes, two derived booleans, and an optional ISO timestamp.
export interface WorkspaceReconciliationEntry {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly status: WorkspaceReconciliationStatus;
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly health: TaskWorkspaceHealth;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  // an automatic (non-operator) repair is available.
  readonly repairable: boolean;
  // at least one recommended recovery needs an operator to act first.
  readonly operatorActionRequired: boolean;
  readonly lastVerifiedAt?: string;
}

export const WORKSPACE_RECONCILIATION_ENTRY_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "workspaceId",
  "taskId",
  "status",
  "lifecycleState",
  "health",
  "driftMarkers",
  "recoveryHints",
  "repairable",
  "operatorActionRequired",
  "lastVerifiedAt",
] as const;

// Pure: the two derived booleans on a reconciliation entry. `repairable` is true when an automatic
// strategy is available OR the workspace is partially-created (the canonical retry case, AC3).
export function workspaceEntryRepairable(input: {
  readonly status: WorkspaceReconciliationStatus;
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
}): boolean {
  if (input.status === "partially-created") return true;
  return input.recoveryHints.some((hint) => !hint.operatorActionRequired);
}

export function workspaceEntryOperatorActionRequired(
  recoveryHints: readonly WorkspaceRecoveryHint[],
): boolean {
  return recoveryHints.some((hint) => hint.operatorActionRequired);
}

// Pure: build a content-free reconciliation entry from the persisted (content-free) instance fields.
// The status is reconstructed from those fields so a read-only report matches what a live reconcile
// last persisted, and the two derived booleans come from the recovery hints. Used by both the live and
// stored-derived report paths so they cannot diverge (AC5).
export function deriveReconciliationEntry(input: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly health: TaskWorkspaceHealth;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  readonly lastVerifiedAt?: string;
}): WorkspaceReconciliationEntry {
  const status = reconciliationStatusFromInstance({
    lifecycleState: input.lifecycleState,
    health: input.health,
    driftMarkers: input.driftMarkers,
  });
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    status,
    lifecycleState: input.lifecycleState,
    health: input.health,
    driftMarkers: input.driftMarkers,
    recoveryHints: input.recoveryHints,
    repairable: workspaceEntryRepairable({ status, recoveryHints: input.recoveryHints }),
    operatorActionRequired: workspaceEntryOperatorActionRequired(input.recoveryHints),
    ...(input.lastVerifiedAt !== undefined ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
  };
}

// eslint-disable-next-line complexity
export function validateWorkspaceReconciliationEntry(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["entry must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_RECONCILIATION_ENTRY_ALLOWED_KEYS);
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  for (const key of ["workspaceId", "taskId"] as const) {
    if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
  }
  if (!isWorkspaceReconciliationStatus(input.status)) reasons.push("status invalid");
  if (!isTaskWorkspaceLifecycleState(input.lifecycleState)) reasons.push("lifecycleState invalid");
  if (!isTaskWorkspaceHealth(input.health)) reasons.push("health invalid");
  if (!Array.isArray(input.driftMarkers) || !input.driftMarkers.every(isTaskWorkspaceDriftMarker)) {
    reasons.push("driftMarkers must be an array of valid markers");
  }
  validateRecoveryHints(input.recoveryHints, reasons);
  if (!isBoolean(input.repairable)) reasons.push("repairable must be a boolean");
  if (!isBoolean(input.operatorActionRequired)) {
    reasons.push("operatorActionRequired must be a boolean");
  }
  if (input.lastVerifiedAt !== undefined && !isNonEmptyString(input.lastVerifiedAt)) {
    reasons.push("lastVerifiedAt must be a non-empty string when present");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// The active-workspace restoration decision after a startup reconciliation. `none` = nothing to
// restore (no pointer; safe unbound mode). `restored` = the pointer target is healthy and stays
// active. `recovery-required` = the pointer target drifted/missing and is kept visible but flagged
// (never silently disappears, AC2). `cleared-dangling` = the pointer referenced a deleted instance
// and was cleared. `ambiguous` = no pointer but ≥2 instances claim `active` lifecycle, so restoration
// refuses to choose (SC: restart recovery never silently picks among ambiguous active workspaces).
export type WorkspaceActiveRestorationKind =
  "none" | "restored" | "recovery-required" | "cleared-dangling" | "ambiguous";

export const WORKSPACE_ACTIVE_RESTORATION_KINDS: readonly WorkspaceActiveRestorationKind[] = [
  "none",
  "restored",
  "recovery-required",
  "cleared-dangling",
  "ambiguous",
] as const;

export function isWorkspaceActiveRestorationKind(
  value: unknown,
): value is WorkspaceActiveRestorationKind {
  return (
    typeof value === "string" &&
    WORKSPACE_ACTIVE_RESTORATION_KINDS.includes(value as WorkspaceActiveRestorationKind)
  );
}

export interface WorkspaceActiveRestoration {
  readonly kind: WorkspaceActiveRestorationKind;
  readonly workspaceId?: string;
  readonly ambiguousWorkspaceIds?: readonly string[];
}

// Pure: decide how (and whether) to restore the active workspace after restart, given the persisted
// pointer target (or undefined for unbound mode) and the reconciliation entries. Deterministic and
// conservative — it never auto-selects among ambiguous active workspaces.
export function resolveActiveRestoration(
  pointerWorkspaceId: string | undefined,
  entries: readonly WorkspaceReconciliationEntry[],
): WorkspaceActiveRestoration {
  if (pointerWorkspaceId === undefined || pointerWorkspaceId.length === 0) {
    const activeIds = entries
      .filter((entry) => entry.lifecycleState === "active")
      .map((entry) => entry.workspaceId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (activeIds.length >= 2) return { kind: "ambiguous", ambiguousWorkspaceIds: activeIds };
    return { kind: "none" };
  }
  const target = entries.find((entry) => entry.workspaceId === pointerWorkspaceId);
  if (target === undefined) return { kind: "cleared-dangling", workspaceId: pointerWorkspaceId };
  if (target.status === "healthy") return { kind: "restored", workspaceId: pointerWorkspaceId };
  return { kind: "recovery-required", workspaceId: pointerWorkspaceId };
}

export function validateWorkspaceActiveRestoration(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["restoration must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, [
    "kind",
    "workspaceId",
    "ambiguousWorkspaceIds",
  ]);
  if (!isWorkspaceActiveRestorationKind(input.kind)) reasons.push("kind invalid");
  if (input.workspaceId !== undefined && !isNonEmptyString(input.workspaceId)) {
    reasons.push("workspaceId must be a non-empty string when present");
  }
  if (input.ambiguousWorkspaceIds !== undefined) {
    if (
      !Array.isArray(input.ambiguousWorkspaceIds) ||
      !input.ambiguousWorkspaceIds.every(isNonEmptyString)
    ) {
      reasons.push("ambiguousWorkspaceIds must be an array of non-empty strings when present");
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface WorkspaceReconciliationReport {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly entries: readonly WorkspaceReconciliationEntry[];
  readonly activeRestoration: WorkspaceActiveRestoration;
}

export const WORKSPACE_RECONCILIATION_REPORT_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "generatedAt",
  "entries",
  "activeRestoration",
] as const;

export function validateWorkspaceReconciliationReport(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["report must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_RECONCILIATION_REPORT_ALLOWED_KEYS);
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isNonEmptyString(input.generatedAt)) reasons.push("generatedAt must be a non-empty string");
  if (!Array.isArray(input.entries)) reasons.push("entries must be an array");
  else {
    input.entries.forEach((entry, index) => {
      const entryValidation = validateWorkspaceReconciliationEntry(entry);
      if (!entryValidation.ok) {
        reasons.push(`entries[${String(index)}]: ${entryValidation.reasons.join("; ")}`);
      }
    });
  }
  const restorationValidation = validateWorkspaceActiveRestoration(input.activeRestoration);
  if (!restorationValidation.ok) {
    reasons.push(`activeRestoration: ${restorationValidation.reasons.join("; ")}`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── Operational health + governed cleanup (Issue #448, content-free; consumed by #449/#450) ────────
// #447 made persisted state trustworthy after restarts. #448 turns that into the OPERATIONAL support
// surface: a richer health classification (adds dirty / orphaned / archived / cleanup-ready on top of
// the reconciliation status), a single pure cleanup-safety gate, and the content-free health report.
// All decision logic is pure (no IO): the keiko-server health/cleanup services gather content-free
// facts (live realpath containment, the `.git` pointer/HEAD/branch state, a live `git status` dirty
// probe, lock liveness, managed-root ownership) and defer every classification + safety decision here,
// so health and cleanup semantics stay deterministic and 100%-testable without a filesystem (AC5).

// The ten Issue-mandated operational-health classifications (AC1). A SUPERSET of the reconciliation
// vocabulary: `dirty` = a structurally healthy worktree with live uncommitted/untracked changes;
// `orphaned` = a managed worktree directory on disk with no persisted record; `archived` = a settled
// (archived/merged) instance retained on disk; `cleanup-ready` = an abandoned/failed/cleanup-pending
// instance whose live cleanup-safety gate passes (safe to physically remove now).
export type WorkspaceHealthClassification =
  | "healthy"
  | "dirty"
  | "drifted"
  | "missing"
  | "stale-pointer"
  | "locked"
  | "orphaned"
  | "archived"
  | "cleanup-ready"
  | "recovery-required";

export const WORKSPACE_HEALTH_CLASSIFICATIONS: readonly WorkspaceHealthClassification[] = [
  "healthy",
  "dirty",
  "drifted",
  "missing",
  "stale-pointer",
  "locked",
  "orphaned",
  "archived",
  "cleanup-ready",
  "recovery-required",
] as const;

export function isWorkspaceHealthClassification(
  value: unknown,
): value is WorkspaceHealthClassification {
  return (
    typeof value === "string" &&
    WORKSPACE_HEALTH_CLASSIFICATIONS.includes(value as WorkspaceHealthClassification)
  );
}

// The lifecycle states from which a workspace may be physically cleaned up. STRICTER than the contract
// transition table (which permits `active->cleanup-pending` with operator approval): #448 policy
// requires a workspace be SETTLED (archived/merged/abandoned/failed) or already cleanup-pending before
// its worktree can be removed, so an active/paused/handoff-ready/recovery-required workspace can never
// be cleaned without first transitioning it to a settled state (defense in depth, SC4).
export const WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES: readonly TaskWorkspaceLifecycleState[] = [
  "archived",
  "merged",
  "abandoned",
  "failed",
  "cleanup-pending",
] as const;

export function isCleanupEligibleLifecycleState(value: TaskWorkspaceLifecycleState): boolean {
  return (
    isTaskWorkspaceLifecycleState(value) &&
    WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES.includes(value)
  );
}

// Why a cleanup was refused. Every reason is a content-free safety outcome, not an error: a refusal is
// a successful first-class result the caller surfaces, never a thrown failure (SC4).
export type WorkspaceCleanupRefusalReason =
  "ownership-unproven" | "path-escape" | "lock-live" | "worktree-dirty" | "not-eligible-state";

export const WORKSPACE_CLEANUP_REFUSAL_REASONS: readonly WorkspaceCleanupRefusalReason[] = [
  "ownership-unproven",
  "path-escape",
  "lock-live",
  "worktree-dirty",
  "not-eligible-state",
] as const;

export function isWorkspaceCleanupRefusalReason(
  value: unknown,
): value is WorkspaceCleanupRefusalReason {
  return (
    typeof value === "string" &&
    WORKSPACE_CLEANUP_REFUSAL_REASONS.includes(value as WorkspaceCleanupRefusalReason)
  );
}

// The content-free facts a cleanup-safety decision needs. `hasRecord` is false for an orphaned managed
// worktree (a directory with no persisted instance); the other four are LIVE-gathered booleans the
// keiko-server cleanup service re-verifies at the moment of removal — never read from the persisted
// path (SC2). `lockLive` blocks on ANY live lock (even the actor's own), because cleanup is destructive.
export interface WorkspaceCleanupSafetyFacts {
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly hasRecord: boolean;
  readonly pathContained: boolean;
  readonly ownershipProven: boolean;
  readonly worktreeDirty: boolean;
  readonly lockLive: boolean;
}

export interface WorkspaceCleanupDecision {
  readonly allowed: boolean;
  readonly refusalReason?: WorkspaceCleanupRefusalReason;
}

// Pure: the SINGLE cleanup-safety gate, shared by the health classifier (`cleanup-ready`) and the
// keiko-server cleanup service (refusal), so they can never diverge. Refusal precedence (most
// fundamental first): ownership must be proven (SC1), the path must be realpath-contained inside the
// managed root (SC1/SC2), no live lock may be held (SC4), the worktree must be clean (SC4), and a
// persisted instance must be in a cleanup-eligible lifecycle state. An orphaned worktree (no record)
// skips the lifecycle check — once owned, contained, clean, and unlocked it is always removable.
export function evaluateWorkspaceCleanupSafety(
  facts: WorkspaceCleanupSafetyFacts,
): WorkspaceCleanupDecision {
  if (!facts.ownershipProven) return { allowed: false, refusalReason: "ownership-unproven" };
  if (!facts.pathContained) return { allowed: false, refusalReason: "path-escape" };
  if (facts.lockLive) return { allowed: false, refusalReason: "lock-live" };
  if (facts.worktreeDirty) return { allowed: false, refusalReason: "worktree-dirty" };
  if (facts.hasRecord && !isCleanupEligibleLifecycleState(facts.lifecycleState)) {
    return { allowed: false, refusalReason: "not-eligible-state" };
  }
  return { allowed: true };
}

// The content-free input to the health classifier for ONE persisted instance: the #447 reconciliation
// facts (reused, not duplicated) plus the two #448-specific live signals — `worktreeDirty` (a live
// `git status --porcelain` probe; the #445 adapter has no status verb, so #447 could not gather it) and
// `ownershipProven` (the managed-root ownership marker, re-verified live).
export interface WorkspaceHealthSignals {
  readonly reconciliation: WorkspaceReconciliationFacts;
  readonly worktreeDirty: boolean;
  readonly ownershipProven: boolean;
}

export interface WorkspaceHealthEvaluation {
  readonly classification: WorkspaceHealthClassification;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  // whether `evaluateWorkspaceCleanupSafety` would allow cleanup of this instance right now.
  readonly cleanupEligible: boolean;
}

// Pure: maps a reconciliation status + lifecycle + live dirty/cleanup signals to the operational health
// classification. Severe structural conditions win first (they precede any cleanup consideration); a
// structurally healthy worktree then resolves by lifecycle — settled (archived/merged) → `archived`,
// settled-for-disposal (abandoned/failed/cleanup-pending) + cleanup-eligible → `cleanup-ready`,
// otherwise `dirty` when the working tree is dirty, else `healthy`.
// eslint-disable-next-line complexity
function healthClassificationFor(
  status: WorkspaceReconciliationStatus,
  lifecycleState: TaskWorkspaceLifecycleState,
  worktreeDirty: boolean,
  cleanupEligible: boolean,
): WorkspaceHealthClassification {
  if (status === "unmanaged-path") return "recovery-required";
  if (status === "locked") return "locked";
  if (status === "missing") return "missing";
  if (status === "stale-pointer") return "stale-pointer";
  if (status === "drifted") return "drifted";
  if (status === "partially-created" || status === "recovery-required") return "recovery-required";
  // status === "healthy": structurally sound (contained, pointer + branch + HEAD verified, no foreign
  // lock). A `failed`/`provisioning` lifecycle is a partial-creation reconciliation state, so it never
  // reaches here (it returns "partially-created" above). Resolve the remaining lifecycles by disposition.
  if (lifecycleState === "archived" || lifecycleState === "merged") return "archived";
  if ((lifecycleState === "abandoned" || lifecycleState === "cleanup-pending") && cleanupEligible) {
    return "cleanup-ready";
  }
  return worktreeDirty ? "dirty" : "healthy";
}

// Pure: classify ONE persisted instance. Delegates the structural classification to the #447
// reconciliation classifier (no second precedence chain) and the cleanup decision to the single safety
// gate, then composes them into the operational health evaluation.
export function classifyWorkspaceHealth(
  signals: WorkspaceHealthSignals,
): WorkspaceHealthEvaluation {
  const facts = signals.reconciliation;
  const recon = classifyWorkspaceReconciliation(facts);
  const decision = evaluateWorkspaceCleanupSafety({
    lifecycleState: facts.lifecycleState,
    hasRecord: true,
    pathContained: facts.pathContained,
    ownershipProven: signals.ownershipProven,
    worktreeDirty: signals.worktreeDirty,
    lockLive: facts.lockLive,
  });
  return {
    classification: healthClassificationFor(
      recon.status,
      facts.lifecycleState,
      signals.worktreeDirty,
      decision.allowed,
    ),
    driftMarkers: recon.driftMarkers,
    recoveryHints: recon.recoveryHints,
    cleanupEligible: decision.allowed,
  };
}

// A health report entry is either a persisted `instance` (carries workspace/task ids, lifecycle, and
// health) or an `orphan-worktree` (a managed directory on disk with no record — carries only a
// content-free `orphanId` hash and always classifies `orphaned`).
export type WorkspaceHealthEntryKind = "instance" | "orphan-worktree";

export const WORKSPACE_HEALTH_ENTRY_KINDS: readonly WorkspaceHealthEntryKind[] = [
  "instance",
  "orphan-worktree",
] as const;

export function isWorkspaceHealthEntryKind(value: unknown): value is WorkspaceHealthEntryKind {
  return (
    typeof value === "string" &&
    WORKSPACE_HEALTH_ENTRY_KINDS.includes(value as WorkspaceHealthEntryKind)
  );
}

// The per-entry content-free health record surfaced to UI/support/verification (AC5). Content-free:
// opaque ids, enums, the existing drift-marker / recovery-hint shapes, two booleans, and an optional
// ISO timestamp. No path, no command output.
export interface WorkspaceHealthEntry {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly kind: WorkspaceHealthEntryKind;
  readonly classification: WorkspaceHealthClassification;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly recoveryHints: readonly WorkspaceRecoveryHint[];
  readonly cleanupEligible: boolean;
  // present for kind `instance`:
  readonly workspaceId?: string;
  readonly taskId?: string;
  readonly lifecycleState?: TaskWorkspaceLifecycleState;
  readonly health?: TaskWorkspaceHealth;
  readonly lastVerifiedAt?: string;
  // present for kind `orphan-worktree`: a content-free hash identifying the orphaned managed directory.
  readonly orphanId?: string;
}

export const WORKSPACE_HEALTH_ENTRY_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "kind",
  "classification",
  "driftMarkers",
  "recoveryHints",
  "cleanupEligible",
  "workspaceId",
  "taskId",
  "lifecycleState",
  "health",
  "lastVerifiedAt",
  "orphanId",
] as const;

// Pure: build a content-free health entry for a persisted instance from its (content-free) fields plus
// the pure evaluation. Used by the server health service so the report shape cannot diverge from the
// classifier output.
export function deriveWorkspaceHealthEntry(input: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly lifecycleState: TaskWorkspaceLifecycleState;
  readonly health: TaskWorkspaceHealth;
  readonly evaluation: WorkspaceHealthEvaluation;
  readonly lastVerifiedAt?: string;
}): WorkspaceHealthEntry {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    kind: "instance",
    classification: input.evaluation.classification,
    driftMarkers: input.evaluation.driftMarkers,
    recoveryHints: input.evaluation.recoveryHints,
    cleanupEligible: input.evaluation.cleanupEligible,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    lifecycleState: input.lifecycleState,
    health: input.health,
    ...(input.lastVerifiedAt !== undefined ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
  };
}

// Pure: build a content-free health entry for an orphaned managed worktree (no persisted record). It
// always classifies `orphaned`; `cleanupEligible` reflects whether the live safety gate cleared it.
export function deriveOrphanWorktreeHealthEntry(input: {
  readonly orphanId: string;
  readonly cleanupEligible: boolean;
}): WorkspaceHealthEntry {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    kind: "orphan-worktree",
    classification: "orphaned",
    driftMarkers: [],
    recoveryHints: [],
    cleanupEligible: input.cleanupEligible,
    orphanId: input.orphanId,
  };
}

// eslint-disable-next-line complexity
export function validateWorkspaceHealthEntry(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["entry must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_HEALTH_ENTRY_ALLOWED_KEYS);
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isWorkspaceHealthEntryKind(input.kind)) reasons.push("kind invalid");
  if (!isWorkspaceHealthClassification(input.classification))
    reasons.push("classification invalid");
  if (!Array.isArray(input.driftMarkers) || !input.driftMarkers.every(isTaskWorkspaceDriftMarker)) {
    reasons.push("driftMarkers must be an array of valid markers");
  }
  validateRecoveryHints(input.recoveryHints, reasons);
  if (!isBoolean(input.cleanupEligible)) reasons.push("cleanupEligible must be a boolean");
  if (input.kind === "instance") {
    for (const key of ["workspaceId", "taskId"] as const) {
      if (!isNonEmptyString(input[key])) reasons.push(`${key} must be a non-empty string`);
    }
    if (!isTaskWorkspaceLifecycleState(input.lifecycleState))
      reasons.push("lifecycleState invalid");
    if (!isTaskWorkspaceHealth(input.health)) reasons.push("health invalid");
    if (input.orphanId !== undefined) reasons.push("orphanId not allowed for an instance entry");
  } else if (input.kind === "orphan-worktree") {
    if (!isNonEmptyString(input.orphanId)) reasons.push("orphanId must be a non-empty string");
    if (input.classification !== "orphaned") reasons.push("orphan entry must classify as orphaned");
    for (const key of ["workspaceId", "taskId", "lifecycleState", "health"] as const) {
      if (input[key] !== undefined) reasons.push(`${key} not allowed for an orphan entry`);
    }
  }
  if (input.lastVerifiedAt !== undefined && !isNonEmptyString(input.lastVerifiedAt)) {
    reasons.push("lastVerifiedAt must be a non-empty string when present");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface WorkspaceHealthReport {
  readonly schemaVersion: typeof TASK_WORKSPACE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly entries: readonly WorkspaceHealthEntry[];
}

export const WORKSPACE_HEALTH_REPORT_ALLOWED_KEYS: readonly string[] = [
  "schemaVersion",
  "generatedAt",
  "entries",
] as const;

export function validateWorkspaceHealthReport(input: unknown): TaskWorkspaceValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["report must be an object"] };
  const reasons: string[] = unknownKeyReasons(input, WORKSPACE_HEALTH_REPORT_ALLOWED_KEYS);
  if (input.schemaVersion !== TASK_WORKSPACE_SCHEMA_VERSION) reasons.push("schemaVersion invalid");
  if (!isNonEmptyString(input.generatedAt)) reasons.push("generatedAt must be a non-empty string");
  if (!Array.isArray(input.entries)) reasons.push("entries must be an array");
  else {
    input.entries.forEach((entry, index) => {
      const entryValidation = validateWorkspaceHealthEntry(entry);
      if (!entryValidation.ok) {
        reasons.push(`entries[${String(index)}]: ${entryValidation.reasons.join("; ")}`);
      }
    });
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
