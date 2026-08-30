// Body-free server-activity-log evidence for the task-workspace lifecycle (Issue #445-#448, Epic
// #443, AGENTS.md §8).
//
// Every provision/activate/pause/resume/handoff/reconcile/repair/cleanup outcome already writes ONE
// content-free document to the EvidenceStore (evidence.ts's `appendWorkspaceLifecycleEvidence`) — but
// that ledger is a SEPARATE audit surface, keyed by event id and read back through the evidence store,
// never through `<stateDir>/logs/server.log`. Before this module, no task-workspace service emitted a
// `ServerLogEvent` at all, so the machine-reconstruction contract ADR-0173 requires of the activity log
// could not answer "did this request's workspace provision, resume, drift, fail, get repaired,
// reconciled, or cleaned up" — only the evidence ledger could, and an operator/agent reconstructing a
// defect from `server.log` alone (the documented Rule-2 path, AGENTS.md §8) has no entry point into it.
//
// This is the ONE shared adapter every one of the five services' own central `emit`-style helper calls
// alongside its EvidenceStore write, at the exact point it already builds the matching record — so the
// two never drift out of step and always carry the SAME correlationId.
//
// SHAPE, FOLLOWING THE ESTABLISHED CONVENTION
//
// `ServerLogCategory` (observability/server-log.ts) is a closed union with no task-workspace member.
// gitDelivery already answered the same question for its own domain lifecycle lines
// (`logGitDeliveryMutation`/`logGitDeliveryPreconditionFailure`, gitDelivery/execution.ts;
// `logCommandTermination`, process-log-sink.ts): bucket under `"diagnostic"` and carry the domain in a
// namespaced `op`, rather than widening the routing union for every new domain. This module follows
// the same rule.
//
// ONE literal op, `"task-workspace.lifecycle"`, covers every one of the eight operations — mirroring
// `logGitDeliveryMutation`'s single `"git.delivery.mutation.completed"` op for every evaluated outcome
// of every git-delivery action kind, with the differentiator riding in `extra`/`errorKind` rather than
// in a combinatorial explosion of op literals (`task-workspace.provision.completed`,
// `task-workspace.provision.failed`, `task-workspace.activate.completed`, ... — sixteen-plus literals
// for eight operations × outcome-class, none of them reachable as a single static string at the one
// `.write()` call site the op-catalog generator can resolve; see AGENTS.md's op-catalog rule). An agent
// reconstructing a run filters this one op by `extra.operation` (`provision`/`activate`/.../`cleanup`)
// and `extra.outcome`, exactly as it already filters `git.delivery.mutation.completed` by
// `extra.actionKind`/`extra.status`.
//
// `errorKind` on a failure-classified outcome. `WorkspaceLifecycleOutcome` and (for reconciliation)
// `WorkspaceReconciliationStatus` are both closed TS unions of short, hyphenated, lowercase
// identifiers — the exact shape `ERROR_KIND_PATTERN` (keiko-contracts/observability.ts, ADR-0173 D11)
// already gates every `errorKind` in this codebase against: an identifier/taxonomy code, never a
// sentence. No second vocabulary needed inventing; the caller's own outcome enum already conforms.

import { UNKNOWN_CORRELATION_ID, isValidCorrelationId } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { WorkspaceLifecycleOperation, WorkspaceLifecycleOutcome } from "./evidence.js";

// The one literal this module's single `.write()` call site carries — see the module comment for why
// it is one op rather than one per operation. Declared as a top-level UPPER_SNAKE const so the
// op-catalog generator resolves it as a literal (`generate-op-catalog.mjs`'s `collectConstStrings`)
// even though the `.write()` call itself references the constant rather than restating the string.
const TASK_WORKSPACE_LIFECYCLE_OP = "task-workspace.lifecycle";

// Every #445-#448 service deps bundle carries this OPTIONAL seam, mirroring
// `GitDeliveryTerminationLogSeam` (gitDelivery/execution.ts): production falls back to the process-wide
// sink below, and a test may inject a buffered one to assert on the emitted line without adding a
// mandatory field to every existing fixture.
export interface WorkspaceActivityLogSeam {
  readonly activityLog?: ServerLogSink | undefined;
}

// Outcomes that mark this line as something other than a clean success. Everything else
// (provisioned/activated/resumed/paused/handoff-prepared/reconciled/repaired) logs at `info` with no
// `errorKind`.
const FAILURE_OUTCOMES: ReadonlySet<WorkspaceLifecycleOutcome> = new Set([
  "blocked",
  "failed",
  "retry-required",
  "operator-required",
  "cleanup-refused",
]);

export interface WorkspaceLifecycleLogInput {
  readonly operation: WorkspaceLifecycleOperation;
  readonly outcome: WorkspaceLifecycleOutcome;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly correlationId: string | undefined;
  readonly attempt: number;
  readonly durationMs: number;
  readonly worktreeCount: number;
  // A finer-grained closed-vocabulary classification than `outcome` alone, when the caller already has
  // one in scope — a `TaskWorkspaceError.code` (e.g. `"LOCK_CONTENTION"`, `"POINTER_DRIFT"`) or
  // reconciliation's own `WorkspaceReconciliationStatus` (e.g. `"stale-pointer"`, `"unmanaged-path"`).
  // An explicit value here ALWAYS wins, even when `outcome` itself is success-classified: reconcile's
  // evidence `outcome` is a fixed "reconciled" regardless of what the live pass found, so its own
  // classification has to travel through this field or it is lost entirely. Omitted, it falls back to
  // `outcome` itself, but only when `outcome` is failure-classified — a plain success never invents an
  // `errorKind` out of nothing.
  readonly errorCode?: string | undefined;
}

function resolvedErrorKind(input: WorkspaceLifecycleLogInput): string | undefined {
  if (input.errorCode !== undefined) return input.errorCode;
  return FAILURE_OUTCOMES.has(input.outcome) ? input.outcome : undefined;
}

// A caller-supplied correlationId that does not fit `isValidCorrelationId`'s shape (hostile, malformed,
// or the empty string a `??` fallback would miss — see correlation.ts) is treated the same as one
// genuinely absent: UNKNOWN_CORRELATION_ID, never written through unshaped. This mirrors
// `applyEnvelopeFields`'s existing `parentCorrelationId` guard (observability/server-log.ts) rather than
// leaving the primary `correlationId` as the one envelope field that trusts its input unchecked.
function safeCorrelationId(correlationId: string | undefined): string {
  return correlationId !== undefined && isValidCorrelationId(correlationId)
    ? correlationId
    : UNKNOWN_CORRELATION_ID;
}

// The ONE place a #445-#448 lifecycle outcome becomes a `server.log` line. Called from each service's
// own central `emit`-style helper, at the exact point it already builds the matching EvidenceStore
// record (evidence.ts), so the two can never drift out of step.
export function logWorkspaceLifecycle(
  seam: WorkspaceActivityLogSeam,
  input: WorkspaceLifecycleLogInput,
): void {
  const sink = seam.activityLog ?? processServerLogSink();
  const errorKind = resolvedErrorKind(input);
  sink.write({
    level: errorKind === undefined ? "info" : "warn",
    category: "diagnostic",
    op: TASK_WORKSPACE_LIFECYCLE_OP,
    correlationId: safeCorrelationId(input.correlationId),
    durationMs: input.durationMs,
    ...(errorKind === undefined ? {} : { errorKind }),
    extra: {
      operation: input.operation,
      outcome: input.outcome,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      attempt: input.attempt,
      worktreeCount: input.worktreeCount,
    },
  });
}
