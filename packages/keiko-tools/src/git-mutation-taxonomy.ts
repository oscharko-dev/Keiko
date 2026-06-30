// Orchestration-level lifecycle and failure taxonomy for governed Git writes
// (Issue #472, Epic #470). This module sits ABOVE the keiko-contracts git-delivery wire types.
//
// The contract layer (Issue #471) names two low-level vocabularies: execution error codes
// (`GitDeliveryExecutionErrorCode`) and policy block reasons (`GitDeliveryBlockReason`). This
// module names the orchestration-level concepts the contract layer deliberately left to the
// execution kernel:
//
//   1. The canonical, ordered LIFECYCLE PHASES every governed mutation advances through (AC1).
//   2. The five FAILURE CATEGORIES that approval UX, evidence capture, and recovery logic consume
//      WITHOUT string parsing (AC4).
//   3. Deterministic, total mappings from the contract's low-level error codes to those categories,
//      so later slices never re-derive severity from a free-form message.
//
// Pure module: type literals, frozen const tables, and total pure functions only. No IO, no clock,
// no randomness. Imports only type-level names from keiko-contracts. Relative imports end in ".js".

import type {
  GitDeliveryExecutionErrorCode,
  GitDeliveryExecutionResult,
} from "@oscharko-dev/keiko-contracts";

// ─── Lifecycle phases (AC1) ─────────────────────────────────────────────────────────
// The single repeatable path every supported mutation follows: resolve context, run preflight,
// produce preview, enforce policy, execute through the narrow adapter, emit the structured result.
// A mutation that stops early (a preflight block, a policy block) reports the furthest phase it
// reached via `phaseReached`, so callers can locate exactly where the lifecycle halted.

export type GitMutationLifecyclePhase =
  "resolve" | "preflight" | "preview" | "policy" | "execute" | "result";

export const GIT_MUTATION_LIFECYCLE_PHASES: readonly GitMutationLifecyclePhase[] = [
  "resolve",
  "preflight",
  "preview",
  "policy",
  "execute",
  "result",
] as const;

// Ordinal phase order. Higher ordinal = later in the lifecycle. Callers compare progress by ordinal
// (never by phase-name string) so "did execution start?" is `GIT_MUTATION_PHASE_ORDER[reached] >=
// GIT_MUTATION_PHASE_ORDER["execute"]`.
export const GIT_MUTATION_PHASE_ORDER: Readonly<Record<GitMutationLifecyclePhase, number>> = {
  resolve: 0,
  preflight: 1,
  preview: 2,
  policy: 3,
  execute: 4,
  result: 5,
} as const;

// ─── Failure categories (AC4) ─────────────────────────────────────────────────────────
// Exactly the five categories Issue #472 enumerates. Severity and recovery routing are DATA on
// this category, never inferred from a message string or an action-kind name.
//
//   policy-block       — an org/repo policy pack denied (or did not permit) the action.
//   preflight-block    — a deterministic preflight evaluator found a blocking repository condition.
//   execution-failure  — the adapter ran but the operation failed transiently or internally.
//   provider-failure   — a remote/provider rejected the action or was unreachable.
//   recovery-required  — the repository is in a state that needs a guided recovery path before the
//                        action can be retried (conflicts, stale preconditions, recovery actions).

export type GitMutationFailureCategory =
  | "policy-block"
  | "preflight-block"
  | "execution-failure"
  | "provider-failure"
  | "recovery-required";

export const GIT_MUTATION_FAILURE_CATEGORIES: readonly GitMutationFailureCategory[] = [
  "policy-block",
  "preflight-block",
  "execution-failure",
  "provider-failure",
  "recovery-required",
] as const;

// ─── Top-level lifecycle status ─────────────────────────────────────────────────────────
// `succeeded` and `approval-required` carry NO failure category (they are not failures).
// `blocked`, `failed`, and `recovery-required` always carry a category. The orchestrator's
// `GitMutationOutcome` (in git-mutation-orchestrator.ts) is the discriminated union that binds a
// status to its category and payload; the invariants here keep that binding total and checkable.

export type GitMutationStatus =
  "succeeded" | "approval-required" | "blocked" | "failed" | "recovery-required";

export const GIT_MUTATION_STATUSES: readonly GitMutationStatus[] = [
  "succeeded",
  "approval-required",
  "blocked",
  "failed",
  "recovery-required",
] as const;

// ─── Deterministic execution-error classification ───────────────────────────────────────
// Total mapping from the closed contract error-code union to a failure category. Keyed exhaustively
// so adding a new GitDeliveryExecutionErrorCode forces a compile error here (the Record is not
// Partial), guaranteeing every code has an explicit category and the kernel never falls back to a
// string heuristic.
//
//   provider-rejected / network-failure → provider-failure   (the remote refused or was unreachable)
//   conflict / precondition-failed      → recovery-required   (a guided fix path exists; re-resolve)
//   timeout / internal-error            → execution-failure   (transient or internal; safe to retry)

const EXECUTION_ERROR_CATEGORY: Readonly<
  Record<GitDeliveryExecutionErrorCode, GitMutationFailureCategory>
> = {
  "provider-rejected": "provider-failure",
  "network-failure": "provider-failure",
  conflict: "recovery-required",
  "precondition-failed": "recovery-required",
  timeout: "execution-failure",
  "internal-error": "execution-failure",
} as const;

export function gitMutationCategoryForExecutionError(
  code: GitDeliveryExecutionErrorCode,
): GitMutationFailureCategory {
  return EXECUTION_ERROR_CATEGORY[code];
}

// Classifies a finished adapter execution result. A `succeeded` / `partial` / `aborted` outcome with
// no error code is not a failure and returns undefined; otherwise the error code's category is
// returned. `partial` and `aborted` outcomes that DO carry an error code are classified by that
// code, so a partially-applied mutation that failed mid-flight is categorized rather than silently
// treated as success.
export function gitMutationCategoryForExecutionResult(
  result: GitDeliveryExecutionResult,
): GitMutationFailureCategory | undefined {
  if (result.outcome === "succeeded") {
    return undefined;
  }
  if (result.errorCode === undefined) {
    // `failed` with no code is an internal contract violation upstream; classify conservatively so
    // the kernel never emits a failed result with no category.
    return result.outcome === "failed" ? "execution-failure" : undefined;
  }
  return gitMutationCategoryForExecutionError(result.errorCode);
}

// True when a failure category should route into the guided recovery workflow rather than a plain
// retry. Only `recovery-required` does; the rest are retried or surfaced as a hard block/failure.
export function gitMutationFailureIsRecoverable(category: GitMutationFailureCategory): boolean {
  return category === "recovery-required";
}

// ─── Guards ─────────────────────────────────────────────────────────────────────────────

export function isGitMutationLifecyclePhase(value: unknown): value is GitMutationLifecyclePhase {
  return (
    typeof value === "string" &&
    (GIT_MUTATION_LIFECYCLE_PHASES as readonly string[]).includes(value)
  );
}

export function isGitMutationFailureCategory(value: unknown): value is GitMutationFailureCategory {
  return (
    typeof value === "string" &&
    (GIT_MUTATION_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isGitMutationStatus(value: unknown): value is GitMutationStatus {
  return typeof value === "string" && (GIT_MUTATION_STATUSES as readonly string[]).includes(value);
}
