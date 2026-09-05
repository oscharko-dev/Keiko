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

// KEIKO-0539: `unavailable` was removed as a legal FSM state — no orchestrator code path
// (snapshot(), status(), CodingRuntimeOrchestratorState.idle()) ever produced it, and every
// current consumer already reads host-qualification exclusively through the unrelated
// `codingRuntimeUnavailableReason` field (deps.ts:buildCodingRuntimeControlPlaneDeps), which
// carries richer information than a bare state value ever could. That field remains the sole
// host-qualification signal.
export type CodingWorkbenchRuntimeStateName =
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
  | "recovery-required"
  // KEIKO-0722: distinct code for the per-run replay-dedup bookkeeping cap being exhausted
  // (RuntimeOperationReplayCoordinator.reserve returns undefined at committed.size >= 512).
  // Distinct from "invalid-intent" so callers can distinguish a malformed request from a
  // long-lived run whose replay budget is spent.
  | "replay-cap-exhausted"
  // #3390: a start against a durable issue binding with no fresh pasted reference (a retry/resume
  // after the transient in-memory attachment was lost, e.g. a server restart) re-resolves the
  // attachment through the same authorized reader the preview uses. Distinct from "invalid-intent"
  // so the Workbench can render a specific, actionable message instead of a generic rejection when
  // that re-resolution itself fails (authorization revoked, issue gone, provider failure) — the
  // start never proceeds context-free.
  | "issue-context-unavailable"
  // Owner audit finding F-question-answer-rejected (PR #3394): a free-text answer to a question
  // whose options carry no `custom` flag is refused by the runtime reply itself (not by authority
  // resolution). Distinct from "authority-resolution-failed" so the coordinator can tell a runtime
  // rejection of the answer's shape apart from a real authority failure, and the Workbench can show
  // an actionable "pick one of the listed options" message instead of a generic authority error.
  | "question-answer-rejected";

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
    "replay-cap-exhausted",
    "issue-context-unavailable",
    "question-answer-rejected",
  ] as const);
