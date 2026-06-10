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

// The rules above are individually simple; keeping them in one function
// keeps the entire contract reviewable in one place.
// eslint-disable-next-line complexity, max-lines-per-function
export function validateWorkspaceDescriptorMeta(
  objectType: string,
  meta: WorkspaceDescriptorMeta,
): readonly WorkspaceDescriptorValidationError[] {
  const errors: WorkspaceDescriptorValidationError[] = [];

  // R1 — closed-set membership
  for (const state of meta.lifecycle) {
    if (!WORKSPACE_LIFECYCLE_STATES.includes(state)) {
      errors.push({
        objectType,
        field: "lifecycle",
        message: `unknown lifecycle state '${state}'`,
      });
    }
  }
  for (const tb of meta.trustBoundary) {
    if (!WORKSPACE_TRUST_BOUNDARIES.includes(tb)) {
      errors.push({
        objectType,
        field: "trustBoundary",
        message: `unknown trust boundary '${tb}'`,
      });
    }
  }
  if (!WORKSPACE_AUTHORITY_REQUIREMENTS.includes(meta.authority)) {
    errors.push({
      objectType,
      field: "authority",
      message: `unknown authority requirement '${meta.authority}'`,
    });
  }
  if (!WORKSPACE_PERSISTENCE_EXPECTATIONS.includes(meta.persistence)) {
    errors.push({
      objectType,
      field: "persistence",
      message: `unknown persistence expectation '${meta.persistence}'`,
    });
  }

  // R2 — ui-only authority must not cross any boundary other than ui
  if (meta.authority === "ui-only") {
    const nonUi = meta.trustBoundary.filter((tb) => tb !== "ui");
    if (nonUi.length > 0) {
      errors.push({
        objectType,
        field: "consistency",
        message: `authority 'ui-only' is inconsistent with trust boundary [${nonUi.join(", ")}]`,
      });
    }
  }

  // R3 — evidence-reference requires the evidence trust boundary
  if (meta.persistence === "evidence-reference" && !meta.trustBoundary.includes("evidence")) {
    errors.push({
      objectType,
      field: "consistency",
      message: `persistence 'evidence-reference' requires trustBoundary to include 'evidence'`,
    });
  }

  // R4 — fs-reference requires the fs trust boundary
  if (meta.persistence === "fs-reference" && !meta.trustBoundary.includes("fs")) {
    errors.push({
      objectType,
      field: "consistency",
      message: `persistence 'fs-reference' requires trustBoundary to include 'fs'`,
    });
  }

  // R5 — memory-reference requires the memory trust boundary
  if (meta.persistence === "memory-reference" && !meta.trustBoundary.includes("memory")) {
    errors.push({
      objectType,
      field: "consistency",
      message: `persistence 'memory-reference' requires trustBoundary to include 'memory'`,
    });
  }

  // R6 — durable.ui requires the ui trust boundary
  if (meta.persistence === "durable.ui" && !meta.trustBoundary.includes("ui")) {
    errors.push({
      objectType,
      field: "consistency",
      message: `persistence 'durable.ui' requires trustBoundary to include 'ui'`,
    });
  }

  return errors;
}
