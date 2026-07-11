// Epic #518 / Issue #528 — Workspace object descriptor metadata contracts.
//
// ADR-0029 extends the workspace object registry with four declarative
// metadata fields per object type: lifecycle, trustBoundary, authority,
// persistence. The enums below are the closed sets the registration-time
// validator (in `@oscharko-dev/keiko-ui`) checks against.
//
// These types are kept side-table-friendly so the existing
// WindowsRegistry.ts in keiko-ui does not need invasive edits. The UI
// package exposes a parallel `WIN_META: Record<WindowType, WorkspaceDescriptorMeta>`
// table consumed by the validator and any object-aware UI surface.

// ─── Lifecycle states (closed set) ────────────────────────────────────────

export type WorkspaceObjectLifecycleState =
  // generic
  | "idle"
  | "live"
  | "error"
  | "empty"
  | "focused"
  // connection
  | "none"
  | "connecting"
  | "connected"
  | "degraded"
  | "disconnected"
  // conversation
  | "draft"
  | "streaming"
  | "final"
  | "archived"
  // workflow / run
  | "proposed"
  | "running"
  | "blocked"
  | "needs-review"
  | "verified"
  | "cancelled"
  // patch
  | "applied"
  | "reverted"
  // verification
  | "passed"
  | "failed"
  // file editor
  | "viewing"
  | "editing"
  | "unsaved"
  | "saved"
  // notifications
  | "unread"
  | "read"
  | "dismissed"
  // pairing
  | "paired"
  | "unpaired"
  // search
  | "searching"
  | "results"
  // plugins / automations
  | "installed"
  | "disabled"
  | "enabled";

// ─── Trust boundary (closed set) ──────────────────────────────────────────

export type WorkspaceObjectTrustBoundary =
  | "ui" // UI-only, no cross-boundary effects
  | "fs" // crosses keiko-workspace path containment
  | "tool" // crosses keiko-tools terminal policy
  | "model" // crosses keiko-model-gateway
  | "evidence" // crosses keiko-evidence redaction
  | "memory" // crosses keiko-memory governance
  | "network"; // crosses an outbound network surface (browser tab, mobile pairing)

// ─── Authority requirement (closed set) ──────────────────────────────────

export type WorkspaceObjectAuthority =
  | "ui-only" // does not require explicit user confirmation per action
  | "user" // explicit user action originates each effect
  | "user-confirm" // explicit confirmation required at each boundary crossing
  | "read-only"; // never mutates anything

// ─── Persistence expectation (closed set) ─────────────────────────────────

export type WorkspaceObjectPersistence =
  | "transient"
  | "durable.ui"
  | "durable.config"
  | "evidence-reference"
  | "fs-reference"
  | "memory-reference";

// ─── Descriptor metadata record ──────────────────────────────────────────

export interface WorkspaceDescriptorMeta {
  readonly lifecycle: readonly WorkspaceObjectLifecycleState[];
  readonly trustBoundary: readonly WorkspaceObjectTrustBoundary[];
  readonly authority: WorkspaceObjectAuthority;
  readonly persistence: WorkspaceObjectPersistence;
}

// ─── Closed-set membership (for the validator) ────────────────────────────

export const WORKSPACE_LIFECYCLE_STATES: readonly WorkspaceObjectLifecycleState[] = [
  "idle",
  "live",
  "error",
  "empty",
  "focused",
  "none",
  "connecting",
  "connected",
  "degraded",
  "disconnected",
  "draft",
  "streaming",
  "final",
  "archived",
  "proposed",
  "running",
  "blocked",
  "needs-review",
  "verified",
  "cancelled",
  "applied",
  "reverted",
  "passed",
  "failed",
  "viewing",
  "editing",
  "unsaved",
  "saved",
  "unread",
  "read",
  "dismissed",
  "paired",
  "unpaired",
  "searching",
  "results",
  "installed",
  "disabled",
  "enabled",
];

export const WORKSPACE_TRUST_BOUNDARIES: readonly WorkspaceObjectTrustBoundary[] = [
  "ui",
  "fs",
  "tool",
  "model",
  "evidence",
  "memory",
  "network",
];

export const WORKSPACE_AUTHORITY_REQUIREMENTS: readonly WorkspaceObjectAuthority[] = [
  "ui-only",
  "user",
  "user-confirm",
  "read-only",
];

export const WORKSPACE_PERSISTENCE_EXPECTATIONS: readonly WorkspaceObjectPersistence[] = [
  "transient",
  "durable.ui",
  "durable.config",
  "evidence-reference",
  "fs-reference",
  "memory-reference",
];

// ─── Validation error type ────────────────────────────────────────────────

export interface WorkspaceDescriptorValidationError {
  readonly objectType: string;
  readonly field: "lifecycle" | "trustBoundary" | "authority" | "persistence" | "consistency";
  readonly message: string;
}

// ─── Pure validator ──────────────────────────────────────────────────────
//
// Validates a single descriptor meta record against the closed sets and
// the ADR-0029 / ADR-0030 consistency rules:
//
// R1 unknown enum: every member of lifecycle / trustBoundary, and the
//   authority / persistence value, must belong to its closed set.
// R2 trust-vs-authority: authority="ui-only" requires trustBoundary be
//   ["ui"] only; any other trust class implies the user originates the
//   action.
// R3 evidence-persistence: persistence="evidence-reference" requires the
//   trustBoundary set to include "evidence".
// R4 fs-persistence: persistence="fs-reference" requires the
//   trustBoundary set to include "fs".
// R5 memory-persistence: persistence="memory-reference" requires the
//   trustBoundary set to include "memory".
// R6 durable.ui-readonly: persistence="durable.ui" with authority="read-only"
//   is allowed but trustBoundary must include "ui" (the durable record
//   itself is a UI surface).
//
// The validator is pure; the failing entries are returned as a list so the
// caller decides how to surface them (dev: throw, prod: assert in test).
//
// Each rule below is a single-purpose helper composed in
// validateWorkspaceDescriptorMeta; this keeps every individual check small
// and independently reviewable while the exported function stays a plain
// sequence of rule invocations.

// R1 (lifecycle) — closed-set membership for the lifecycle state array.
function validateLifecycleEnum(
  objectType: string,
  lifecycle: readonly WorkspaceObjectLifecycleState[],
): WorkspaceDescriptorValidationError[] {
  const errors: WorkspaceDescriptorValidationError[] = [];
  for (const state of lifecycle) {
    if (!WORKSPACE_LIFECYCLE_STATES.includes(state)) {
      errors.push({
        objectType,
        field: "lifecycle",
        message: `unknown lifecycle state '${state}'`,
      });
    }
  }
  return errors;
}

// R1 (trustBoundary) — closed-set membership for the trust boundary array.
function validateTrustBoundaryEnum(
  objectType: string,
  trustBoundary: readonly WorkspaceObjectTrustBoundary[],
): WorkspaceDescriptorValidationError[] {
  const errors: WorkspaceDescriptorValidationError[] = [];
  for (const tb of trustBoundary) {
    if (!WORKSPACE_TRUST_BOUNDARIES.includes(tb)) {
      errors.push({
        objectType,
        field: "trustBoundary",
        message: `unknown trust boundary '${tb}'`,
      });
    }
  }
  return errors;
}

// R1 (authority) — closed-set membership for the authority requirement.
function validateAuthorityEnum(
  objectType: string,
  authority: WorkspaceObjectAuthority,
): WorkspaceDescriptorValidationError | null {
  if (WORKSPACE_AUTHORITY_REQUIREMENTS.includes(authority)) {
    return null;
  }
  return {
    objectType,
    field: "authority",
    message: `unknown authority requirement '${authority}'`,
  };
}

// R1 (persistence) — closed-set membership for the persistence expectation.
function validatePersistenceEnum(
  objectType: string,
  persistence: WorkspaceObjectPersistence,
): WorkspaceDescriptorValidationError | null {
  if (WORKSPACE_PERSISTENCE_EXPECTATIONS.includes(persistence)) {
    return null;
  }
  return {
    objectType,
    field: "persistence",
    message: `unknown persistence expectation '${persistence}'`,
  };
}

// R2 — ui-only authority must not cross any boundary other than ui.
function validateUiOnlyConsistency(
  objectType: string,
  meta: WorkspaceDescriptorMeta,
): WorkspaceDescriptorValidationError | null {
  if (meta.authority !== "ui-only") {
    return null;
  }
  const nonUi = meta.trustBoundary.filter((tb) => tb !== "ui");
  if (nonUi.length === 0) {
    return null;
  }
  return {
    objectType,
    field: "consistency",
    message: `authority 'ui-only' is inconsistent with trust boundary [${nonUi.join(", ")}]`,
  };
}

// R3 / R4 / R5 / R6 — a given persistence expectation requires a matching
// entry in the trust boundary set. The four rules share this exact shape,
// differing only in which persistence value implies which boundary.
function validatePersistenceRequiresTrustBoundary(
  objectType: string,
  meta: WorkspaceDescriptorMeta,
  persistence: WorkspaceObjectPersistence,
  requiredBoundary: WorkspaceObjectTrustBoundary,
): WorkspaceDescriptorValidationError | null {
  if (meta.persistence !== persistence || meta.trustBoundary.includes(requiredBoundary)) {
    return null;
  }
  return {
    objectType,
    field: "consistency",
    message: `persistence '${persistence}' requires trustBoundary to include '${requiredBoundary}'`,
  };
}

// Pushes `error` onto `errors` when present; keeps the composed validator a
// flat sequence of calls instead of repeating null-checks at each call site.
function pushIfPresent(
  errors: WorkspaceDescriptorValidationError[],
  error: WorkspaceDescriptorValidationError | null,
): void {
  if (error !== null) {
    errors.push(error);
  }
}

export function validateWorkspaceDescriptorMeta(
  objectType: string,
  meta: WorkspaceDescriptorMeta,
): readonly WorkspaceDescriptorValidationError[] {
  const errors: WorkspaceDescriptorValidationError[] = [];

  errors.push(...validateLifecycleEnum(objectType, meta.lifecycle));
  errors.push(...validateTrustBoundaryEnum(objectType, meta.trustBoundary));
  pushIfPresent(errors, validateAuthorityEnum(objectType, meta.authority));
  pushIfPresent(errors, validatePersistenceEnum(objectType, meta.persistence));

  pushIfPresent(errors, validateUiOnlyConsistency(objectType, meta));
  pushIfPresent(
    errors,
    validatePersistenceRequiresTrustBoundary(objectType, meta, "evidence-reference", "evidence"),
  );
  pushIfPresent(
    errors,
    validatePersistenceRequiresTrustBoundary(objectType, meta, "fs-reference", "fs"),
  );
  pushIfPresent(
    errors,
    validatePersistenceRequiresTrustBoundary(objectType, meta, "memory-reference", "memory"),
  );
  pushIfPresent(
    errors,
    validatePersistenceRequiresTrustBoundary(objectType, meta, "durable.ui", "ui"),
  );

  return errors;
}
