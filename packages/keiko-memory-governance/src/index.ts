// Public surface of @oscharko-dev/keiko-memory-governance (Epic #204 child #209).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). Internal modules are package-private.
//
// Every function in this barrel is pure: same input + same `GovernanceContext` =>
// byte-identical output. The package never reads a clock, never invokes randomness, never
// touches the filesystem. The caller supplies `nowMs` and a `reviewerId` through
// `GovernanceContext`. Every returned envelope is REVALIDATED through the
// `@oscharko-dev/keiko-contracts` validators before being returned; a construction bug
// surfaces as a `GovernanceError("envelope-validation-failed", …)` rather than letting an
// invalid envelope cross the API boundary.

export { KEIKO_MEMORY_GOVERNANCE_VERSION } from "./version.js";

// ─── Public type surface ─────────────────────────────────────────────────────
export type {
  BuildForgetOperationsOptions,
  ConflictPair,
  ConflictReason,
  ConflictResolution,
  ForgetSelector,
  ForgetSelectorKind,
  GovernanceContext,
  SelectMemoriesForForgetOptions,
  StatusTransition,
} from "./types.js";
export { FORGET_SELECTOR_KINDS } from "./types.js";

// ─── Errors ──────────────────────────────────────────────────────────────────
export { GovernanceError, type GovernanceErrorCode } from "./errors.js";

// ─── Correction ──────────────────────────────────────────────────────────────
export {
  buildCorrection,
  type BuildCorrectionInput,
  type CorrectionEnvelopes,
} from "./correction.js";

// ─── Conflict ────────────────────────────────────────────────────────────────
export {
  buildConflictTransitions,
  type ConflictTransitionResult,
  detectConflictPair,
} from "./conflict.js";

// ─── Forget ──────────────────────────────────────────────────────────────────
export { buildForgetOperations, selectMemoriesForForget } from "./forget.js";

// ─── Retention ───────────────────────────────────────────────────────────────
export { buildExpirationUpdate } from "./retention.js";

// ─── Pin / unpin / archive ───────────────────────────────────────────────────
export { buildArchiveOperation, buildPinOperation, buildUnpinOperation } from "./status-ops.js";

// ─── Retrieval suppression ───────────────────────────────────────────────────
export {
  isMemorySuppressedFromRetrieval,
  type SuppressionOptions,
  type SuppressionReason,
  type SuppressionResult,
} from "./suppression.js";

// ─── Maintenance planner (#204) ──────────────────────────────────────────────
export {
  effectiveStrength,
  planMemoryMaintenance,
  MEMORY_MAINTENANCE_DEFAULTS,
  type MemoryAccessStatLike,
  type MemoryMaintenancePlan,
  type MemoryMaintenancePolicy,
  type PlanMaintenanceOptions,
} from "./maintenance.js";
