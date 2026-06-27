// Structured failure taxonomy for managed task-workspace provisioning + activation (Issue #445).
//
// Every failure mode the Issue enumerates — invalid base branch, unsafe path, branch conflict,
// existing unmanaged path, lock contention, missing repository, worktree pointer drift — maps to ONE
// explicit code with a deterministic HTTP status and a content-free evidence outcome. A partial
// failure therefore always leaves a CLASSIFIED, visible state rather than an unclassified one (SC4):
// the service persists the instance in `failed`/`recovery-required` and emits the matching outcome
// before the error propagates to the route.

export type TaskWorkspaceErrorCode =
  | "INVALID_REQUEST"
  | "MISSING_REPOSITORY"
  | "INVALID_BASE_BRANCH"
  | "UNSAFE_PATH"
  | "BRANCH_CONFLICT"
  | "EXISTING_UNMANAGED_PATH"
  | "LOCK_CONTENTION"
  | "POINTER_DRIFT"
  | "PROVISIONING_FAILED"
  | "WORKSPACE_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  // #447 repair gates: the requested repair needs operator approval it did not carry; the requested
  // strategy is not applicable to the workspace's reconciled state; a controlled repair mutation
  // errored after it was authorized.
  | "OPERATOR_APPROVAL_REQUIRED"
  | "REPAIR_NOT_APPLICABLE"
  | "REPAIR_FAILED"
  // #448 cleanup gates: the workspace lifecycle is not a cleanup-eligible state; a governed physical
  // removal errored after the safety gate authorized it. (A safety REFUSAL is NOT an error — it is a
  // successful `cleanup-refused` result the service returns, never throws.)
  | "CLEANUP_NOT_ELIGIBLE"
  | "CLEANUP_FAILED";

import type { WorkspaceFailureClass } from "@oscharko-dev/keiko-contracts";

// The content-free outcome recorded in lifecycle evidence. `blocked` = a precondition/safety/conflict
// gate rejected the request before or instead of mutating; `failed` = a mutation was attempted and
// errored; `retry-required` = a transient contention/partial state the caller may safely retry.
export type WorkspaceFailureOutcome = "blocked" | "failed" | "retry-required";

interface TaskWorkspaceErrorSpec {
  readonly status: number;
  readonly outcome: WorkspaceFailureOutcome;
}

const ERROR_SPECS: Readonly<Record<TaskWorkspaceErrorCode, TaskWorkspaceErrorSpec>> = {
  INVALID_REQUEST: { status: 400, outcome: "blocked" },
  MISSING_REPOSITORY: { status: 400, outcome: "blocked" },
  INVALID_BASE_BRANCH: { status: 400, outcome: "blocked" },
  UNSAFE_PATH: { status: 400, outcome: "blocked" },
  BRANCH_CONFLICT: { status: 409, outcome: "blocked" },
  EXISTING_UNMANAGED_PATH: { status: 409, outcome: "blocked" },
  LOCK_CONTENTION: { status: 409, outcome: "retry-required" },
  POINTER_DRIFT: { status: 409, outcome: "retry-required" },
  PROVISIONING_FAILED: { status: 500, outcome: "failed" },
  WORKSPACE_NOT_FOUND: { status: 404, outcome: "blocked" },
  ILLEGAL_TRANSITION: { status: 409, outcome: "blocked" },
  OPERATOR_APPROVAL_REQUIRED: { status: 403, outcome: "blocked" },
  REPAIR_NOT_APPLICABLE: { status: 409, outcome: "blocked" },
  REPAIR_FAILED: { status: 500, outcome: "failed" },
  CLEANUP_NOT_ELIGIBLE: { status: 409, outcome: "blocked" },
  CLEANUP_FAILED: { status: 500, outcome: "failed" },
};

// The caller-facing failure classification (Issue #449, ADR-0093 D3). This is a DISTINCT axis from the
// evidence `outcome` above: the outcome records what the ledger saw (`blocked`/`failed`/`retry-required`),
// this class tells a BFF/UI caller what to DO next (retry as-is, route to repair, fix inputs, seek
// approval, or give up). The map is total by construction — `Record<TaskWorkspaceErrorCode, ...>` requires
// an entry for every code, so adding a future code without classifying it is a compile-time error and the
// taxonomy can never silently fall out of date.
//
//   retryable     — LOCK_CONTENTION: a live advisory lock held by another actor is TTL-bounded; retry.
//   repairable    — POINTER_DRIFT: a stale/missing pointer re-fails a bare retry; route to #447 repair.
//   blocked       — a precondition/validation/conflict/applicability gate: change inputs or state.
//   policy-denied — OPERATOR_APPROVAL_REQUIRED: needs governance approval, not a retry.
//   terminal      — a mutation errored after the safety gate authorized it: needs intervention.
const WORKSPACE_FAILURE_CLASS_BY_CODE: Readonly<
  Record<TaskWorkspaceErrorCode, WorkspaceFailureClass>
> = {
  INVALID_REQUEST: "blocked",
  MISSING_REPOSITORY: "blocked",
  INVALID_BASE_BRANCH: "blocked",
  UNSAFE_PATH: "blocked",
  BRANCH_CONFLICT: "blocked",
  EXISTING_UNMANAGED_PATH: "blocked",
  LOCK_CONTENTION: "retryable",
  POINTER_DRIFT: "repairable",
  PROVISIONING_FAILED: "terminal",
  WORKSPACE_NOT_FOUND: "blocked",
  ILLEGAL_TRANSITION: "blocked",
  OPERATOR_APPROVAL_REQUIRED: "policy-denied",
  REPAIR_NOT_APPLICABLE: "blocked",
  REPAIR_FAILED: "terminal",
  CLEANUP_NOT_ELIGIBLE: "blocked",
  CLEANUP_FAILED: "terminal",
};

export function classifyTaskWorkspaceError(code: TaskWorkspaceErrorCode): WorkspaceFailureClass {
  return WORKSPACE_FAILURE_CLASS_BY_CODE[code];
}

export class TaskWorkspaceError extends Error {
  public readonly code: TaskWorkspaceErrorCode;
  public readonly status: number;
  public readonly outcome: WorkspaceFailureOutcome;
  public readonly reasons: readonly string[];

  public constructor(
    code: TaskWorkspaceErrorCode,
    message: string,
    reasons: readonly string[] = [],
  ) {
    super(message);
    this.name = "TaskWorkspaceError";
    this.code = code;
    this.status = ERROR_SPECS[code].status;
    this.outcome = ERROR_SPECS[code].outcome;
    this.reasons = reasons;
  }

  // The caller-facing failure class, derived (never stored) from the code so it can never drift from the
  // taxonomy. Route mappers surface it in the error body so the BFF/UI can branch on a stable signal.
  public get failureClass(): WorkspaceFailureClass {
    return classifyTaskWorkspaceError(this.code);
  }
}

export function taskWorkspaceErrorOutcome(code: TaskWorkspaceErrorCode): WorkspaceFailureOutcome {
  return ERROR_SPECS[code].outcome;
}
