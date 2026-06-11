// Multi-agent orchestration contract for Epic #435 / Issue #436.
//
// Pure types, closed enumerations, and deterministic transition helpers only. No IO, no clock
// reads, no randomness, and no filesystem access. This file extends the existing single-run
// harness contract with additive parent/child orchestration semantics so downstream scheduler,
// conflict-guard, settlement, API, UI, and evidence work can share one authoritative model.

import type { TaskType } from "./harness.js";

export const ORCHESTRATION_SCHEMA_VERSION = "1" as const;

export const ORCHESTRATION_RUN_KINDS = ["single-run", "parent-run", "child-run"] as const;
export type OrchestrationRunKind = (typeof ORCHESTRATION_RUN_KINDS)[number];

export const ORCHESTRATION_EXECUTION_MODES = ["single", "sequential", "parallel", "mixed"] as const;
export type OrchestrationExecutionMode = (typeof ORCHESTRATION_EXECUTION_MODES)[number];

export const ORCHESTRATION_STATES = [
  "planning",
  "ready",
  "dispatching",
  "running",
  "blocked",
  "conflicted",
  "merging",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
] as const;
export type OrchestrationState = (typeof ORCHESTRATION_STATES)[number];

export const ORCHESTRATION_TERMINAL_STATES: ReadonlySet<OrchestrationState> =
  new Set<OrchestrationState>(["completed", "cancelled", "failed"]);

export const ORCHESTRATION_CHILD_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "validator",
  "merger",
] as const;
export type OrchestrationChildRole = (typeof ORCHESTRATION_CHILD_ROLES)[number];

export const ORCHESTRATION_CHILD_OUTCOMES = [
  "succeeded",
  "partial-success",
  "discarded",
  "cancelled",
  "escalated",
  "failed",
] as const;
export type OrchestrationChildOutcome = (typeof ORCHESTRATION_CHILD_OUTCOMES)[number];

export interface OrchestrationStateTransition {
  readonly from: OrchestrationState;
  readonly to: OrchestrationState;
  readonly reason: string;
}

export interface OrchestrationAuthorityBoundary {
  readonly allowedTaskTypes: readonly TaskType[];
  readonly canReadWorkspace: boolean;
  readonly canWriteWorkspace: boolean;
  readonly canSpawnChildren: boolean;
  readonly canCancelSiblings: boolean;
  readonly canApproveSettlement: boolean;
  readonly maxConcurrentChildren: number;
  readonly maxRetryAttempts: number;
}

export interface OrchestrationRunIdentity {
  readonly runId: string;
  readonly kind: OrchestrationRunKind;
  readonly parentRunId?: string | undefined;
  readonly childId?: string | undefined;
}

export interface OrchestrationChildPlan {
  readonly childId: string;
  readonly title: string;
  readonly role: OrchestrationChildRole;
  readonly taskType: TaskType;
  readonly authority: OrchestrationAuthorityBoundary;
  readonly dependsOn: readonly string[];
}

export interface OrchestrationPlan {
  readonly schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  readonly parent: OrchestrationRunIdentity;
  readonly executionMode: OrchestrationExecutionMode;
  readonly children: readonly OrchestrationChildPlan[];
}

export interface OrchestrationChildSettlement {
  readonly childId: string;
  readonly outcome: OrchestrationChildOutcome;
  readonly accepted: boolean;
  readonly reason: string;
}

export const ORCHESTRATION_SETTLEMENT_OUTCOMES = [
  "accepted",
  "merged",
  "discarded",
  "escalated",
  "no-safe-result",
] as const;
export type OrchestrationSettlementOutcome =
  (typeof ORCHESTRATION_SETTLEMENT_OUTCOMES)[number];

export const ORCHESTRATION_SETTLEMENT_STRATEGIES = [
  "prefer-single-writer",
  "merge-compatible-results",
  "escalate-to-reviewer",
  "discard-unsafe-results",
] as const;
export type OrchestrationSettlementStrategy =
  (typeof ORCHESTRATION_SETTLEMENT_STRATEGIES)[number];

export interface OrchestrationSettlementReason {
  readonly code:
    | "single-completed-child"
    | "compatible-results"
    | "resource-conflict"
    | "policy-conflict"
    | "reviewer-required"
    | "no-safe-result";
  readonly message: string;
}

export interface OrchestrationSettlementDecision {
  readonly outcome: OrchestrationSettlementOutcome;
  readonly strategy: OrchestrationSettlementStrategy;
  readonly acceptedChildIds: readonly string[];
  readonly discardedChildIds: readonly string[];
  readonly escalatedChildIds: readonly string[];
  readonly mergedChildIds: readonly string[];
  readonly reason: OrchestrationSettlementReason;
}

export interface OrchestrationInvalidTransition {
  readonly from: OrchestrationState;
  readonly to: OrchestrationState;
  readonly reason: string;
}

export const ORCHESTRATION_ALLOWED_STATE_TRANSITIONS: Readonly<
  Record<OrchestrationState, readonly OrchestrationState[]>
> = {
  planning: ["ready", "blocked", "cancelling", "failed"],
  ready: ["dispatching", "blocked", "cancelling", "failed"],
  dispatching: ["running", "blocked", "cancelling", "failed"],
  running: ["blocked", "conflicted", "merging", "completed", "cancelling", "failed"],
  blocked: ["ready", "cancelling", "failed"],
  conflicted: ["running", "merging", "cancelling", "failed"],
  merging: ["running", "completed", "blocked", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
} as const;

export function isOrchestrationStateTransitionAllowed(
  from: OrchestrationState,
  to: OrchestrationState,
): boolean {
  return ORCHESTRATION_ALLOWED_STATE_TRANSITIONS[from].includes(to);
}

export function assertOrchestrationStateTransition(
  from: OrchestrationState,
  to: OrchestrationState,
): OrchestrationInvalidTransition | null {
  if (isOrchestrationStateTransitionAllowed(from, to)) {
    return null;
  }
  return {
    from,
    to,
    reason: `Illegal orchestration transition: ${from} -> ${to}`,
  };
}
