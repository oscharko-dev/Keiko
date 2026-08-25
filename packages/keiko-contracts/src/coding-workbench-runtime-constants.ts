// Dependency-free constants leaf for the coding workbench runtime contract (KEIKO-0532).
//
// coding-workbench-runtime.ts and coding-workbench-runtime-api-validation.ts both need the runtime
// contract version and the two closed runtime vocabularies (state names, failure codes), and
// coding-workbench-runtime.ts also imports validation primitives FROM
// coding-workbench-runtime-api-validation.ts. If either validation module re-declared these
// constants instead of sharing one source, or if coding-workbench-runtime-api-validation.ts kept
// importing them from coding-workbench-runtime.ts the way it used to, the two modules would form an
// import cycle. Hosting the shared values here — a leaf with zero imports of its own — lets both
// modules depend inward on the same source without depending on each other for it.
//
// Leaf-package rule (ADR-0019): pure types and frozen const tables only. No imports.

export const CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION = "1" as const;

export type CodingWorkbenchRuntimeStateName =
  | "unavailable"
  | "idle"
  | "starting"
  | "ready"
  | "running"
  | "paused"
  | "awaiting-approval"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "taken-over"
  | "recovery-required";

export const CODING_WORKBENCH_RUNTIME_STATE_NAMES: readonly CodingWorkbenchRuntimeStateName[] =
  Object.freeze([
    "unavailable",
    "idle",
    "starting",
    "ready",
    "running",
    "paused",
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "taken-over",
    "recovery-required",
  ] as const);

export type CodingWorkbenchRuntimeFailureCode =
  | "runtime-unavailable"
  | "active-run-conflict"
  | "invalid-intent"
  | "approval-activation-failed"
  | "authority-resolution-failed"
  | "authority-expired"
  | "authority-replayed"
  | "task-drift"
  | "workspace-drift"
  | "project-drift"
  | "branch-drift"
  | "scope-drift"
  | "budget-drift"
  | "authority-budget-exceeded"
  | "source-drift"
  | "runtime-failed"
  | "revoked"
  | "recovery-required";

export const CODING_WORKBENCH_RUNTIME_FAILURE_CODES: readonly CodingWorkbenchRuntimeFailureCode[] =
  Object.freeze([
    "runtime-unavailable",
    "active-run-conflict",
    "invalid-intent",
    "approval-activation-failed",
    "authority-resolution-failed",
    "authority-expired",
    "authority-replayed",
    "task-drift",
    "workspace-drift",
    "project-drift",
    "branch-drift",
    "scope-drift",
    "budget-drift",
    "authority-budget-exceeded",
    "source-drift",
    "runtime-failed",
    "revoked",
    "recovery-required",
  ] as const);
