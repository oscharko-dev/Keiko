// Body-free server-activity-log evidence for the task-workspace lifecycle (Issue #445-#448, Epic
// #443, AGENTS.md §8).
//
// Every provision/activate/pause/resume/handoff/reconcile/repair/cleanup outcome attempts ONE
// content-free document in the EvidenceStore (evidence.ts's `appendWorkspaceLifecycleEvidence`) — but
// that ledger is a SEPARATE audit surface, keyed by event id and read back through the evidence store,
// never through `<stateDir>/logs/server.log`. Before this module, no task-workspace service emitted a
// `ServerLogEvent` at all, so the machine-reconstruction contract ADR-0173 requires of the activity log
// could not answer "did this request's workspace provision, resume, drift, fail, get repaired,
// reconciled, or cleaned up" — only the evidence ledger could, and an operator/agent reconstructing a
// defect from `server.log` alone (the documented Rule-2 path, AGENTS.md §8) has no entry point into it.
//
// `recordWorkspaceLifecycle` is the ONE shared adapter every service's central `emit`-style helper
// calls at the point it builds the matching record. It owns both the EvidenceStore append and the
// activity-log projection; a failed append emits its own correlated diagnostic before the ordinary
// lifecycle line, so a missing ledger record can never look like a fully persisted outcome.
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
// for eight operations × outcome-class). The single write site below uses a top-level literal const,
// so the op-catalog generator resolves the closed op without dynamic string construction. An agent
// reconstructing a run filters this one op by `extra.operation` (`provision`/`activate`/.../`cleanup`),
// then by `extra.outcome` for settled outcomes or `errorKind` for a thrown rejection.
//
// `errorKind` on a failure-classified outcome is always a short identifier/taxonomy code, never a
// sentence. Lowercase hyphenated `WorkspaceLifecycleOutcome`/`WorkspaceReconciliationStatus`
// members and uppercase `TaskWorkspaceError.code` members are both intentionally accepted by the
// shared `ERROR_KIND_PATTERN` (keiko-contracts/observability.ts, ADR-0173 D11). No second vocabulary
// is needed; each caller's existing closed code set already conforms.

import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { correlationIdOrUnknown } from "../correlation.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import type { TaskWorkspaceDriftMarker } from "@oscharko-dev/keiko-contracts";
import type { CreationTimeSupport } from "@oscharko-dev/keiko-workspace/internal/fs";
import { processServerLogSink } from "../process-log-sink.js";
import { TaskWorkspaceError } from "./errors.js";
import {
  appendWorkspaceLifecycleEvidence,
  type WorkspaceLifecycleEvidenceRecord,
  type WorkspaceLifecycleOperation,
  type WorkspaceLifecycleOutcome,
} from "./evidence.js";

// The one literal this module's shared write site carries — see the module comment for why it is one
// op rather than one per operation. Declared as a top-level UPPER_SNAKE const so the op-catalog
// generator resolves it as a literal (`generate-op-catalog.mjs`'s `collectConstStrings`) even though
// the `.write()` call references the constant rather than restating the string.
const TASK_WORKSPACE_LIFECYCLE_OP = "task-workspace.lifecycle";
const EVIDENCE_PERSISTENCE_ERROR_KIND = "EVIDENCE_PERSISTENCE_FAILED";
const WORKSPACE_LOG_IDENTITY_PREFIX = "wsref_";
const RECORDED_FAILURE_LOG_KEYS = new WeakMap<TaskWorkspaceError, Set<string>>();

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
  // Kept on this private adapter input so the formatted-line regression can exercise hostile values
  // at the final projection boundary. It is deliberately NEVER copied into `extra`: taskId is a
  // free-form API value, while workspaceId is the operation's deterministic opaque identity.
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
  // The classified drift marker when the outcome is a drift verdict, so the log can tell a migration
  // (`identity-schema-retired`), a platform limitation (`identity-unsupported`) and a replacement
  // (`pointer-stale`) apart without the evidence store (#3376 review P2).
  readonly driftMarker?: TaskWorkspaceDriftMarker | undefined;
}

export interface WorkspaceLifecycleFailureInput {
  readonly operation: WorkspaceLifecycleOperation;
  readonly workspaceIdentitySeed: string;
  readonly correlationId: string | undefined;
  // Some operations persist and log a classified lifecycle failure before rethrowing the same
  // rejection. Their operation-local tracker suppresses a second, less-specific diagnostic line.
  readonly failureOutcomeAlreadyRecorded?: (() => boolean) | undefined;
}

export interface RecordWorkspaceLifecycleInput {
  readonly evidenceStore: EvidenceStore;
  readonly record: WorkspaceLifecycleEvidenceRecord;
  readonly redactString: (input: string) => string;
  readonly errorCode?: string | undefined;
  readonly driftMarker?: TaskWorkspaceDriftMarker | undefined;
}

interface WorkspaceErrorTrace {
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
}

function resolvedErrorKind(input: WorkspaceLifecycleLogInput): string | undefined {
  if (input.errorCode !== undefined) return input.errorCode;
  return FAILURE_OUTCOMES.has(input.outcome) ? input.outcome : undefined;
}

function writeWorkspaceLog(
  seam: WorkspaceActivityLogSeam,
  event: Omit<ServerLogEvent, "category" | "op">,
): void {
  const sink = seam.activityLog ?? processServerLogSink();
  sink.write({ ...event, category: "diagnostic", op: TASK_WORKSPACE_LIFECYCLE_OP });
}

// The ONE projection for a settled #445-#448 lifecycle outcome. `recordWorkspaceLifecycle` below owns
// the paired EvidenceStore append; direct callers exist only for the projection's focused unit tests.
export function logWorkspaceLifecycle(
  seam: WorkspaceActivityLogSeam,
  input: WorkspaceLifecycleLogInput,
): void {
  const errorKind = resolvedErrorKind(input);
  writeWorkspaceLog(seam, {
    level: errorKind === undefined ? "info" : "warn",
    correlationId: correlationIdOrUnknown(input.correlationId),
    durationMs: input.durationMs,
    ...(errorKind === undefined ? {} : { errorKind }),
    extra: {
      operation: input.operation,
      outcome: input.outcome,
      workspaceId: input.workspaceId,
      attempt: input.attempt,
      worktreeCount: input.worktreeCount,
      ...(input.driftMarker === undefined ? {} : { driftMarker: input.driftMarker }),
    },
  });
}

function errorTrace(error: unknown): WorkspaceErrorTrace {
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  return {
    ...(frames.length === 0 ? {} : { frames }),
    ...(causes.length === 0 ? {} : { causeChain: causes }),
  };
}

function workspaceLogIdentity(workspaceId: string): string {
  const digest = sha256Hex(`task-workspace-log-v1\0${workspaceId}`).slice(0, 24);
  return `${WORKSPACE_LOG_IDENTITY_PREFIX}${digest}`;
}

function logWorkspaceEvidencePersistenceFailure(
  seam: WorkspaceActivityLogSeam,
  record: WorkspaceLifecycleEvidenceRecord,
  error: unknown,
): void {
  writeWorkspaceLog(seam, {
    level: "error",
    correlationId: correlationIdOrUnknown(record.event.correlationId),
    errorKind: EVIDENCE_PERSISTENCE_ERROR_KIND,
    extra: {
      operation: record.operation,
      outcome: record.outcome,
      workspaceId: record.event.workspaceId,
      eventId: record.event.eventId,
      evidencePersistence: "failed",
      ...errorTrace(error),
    },
  });
}

export function recordWorkspaceLifecycle(
  seam: WorkspaceActivityLogSeam,
  input: RecordWorkspaceLifecycleInput,
): void {
  const { record } = input;
  appendWorkspaceLifecycleEvidence(input.evidenceStore, record, input.redactString, (error) => {
    logWorkspaceEvidencePersistenceFailure(seam, record, error);
  });
  logWorkspaceLifecycle(seam, {
    operation: record.operation,
    outcome: record.outcome,
    workspaceId: record.event.workspaceId,
    taskId: record.event.taskId,
    correlationId: record.event.correlationId,
    attempt: record.attempt,
    durationMs: record.durationMs,
    worktreeCount: record.worktreeCount,
    errorCode: input.errorCode,
    driftMarker: input.driftMarker,
  });
}

function logWorkspaceLifecycleFailure(
  seam: WorkspaceActivityLogSeam,
  input: WorkspaceLifecycleFailureInput,
  error: TaskWorkspaceError,
): void {
  writeWorkspaceLog(seam, {
    level: error.outcome === "failed" ? "error" : "warn",
    correlationId: correlationIdOrUnknown(input.correlationId),
    errorKind: error.code,
    extra: {
      operation: input.operation,
      workspaceIdentity: workspaceLogIdentity(input.workspaceIdentitySeed),
      ...errorTrace(error),
    },
  });
}

function failureLogKey(input: WorkspaceLifecycleFailureInput): string {
  // Nested service boundaries can derive different fallback identity seeds for the same invalid
  // request (for example lifecycle sees an empty workspaceId while provisioning uses
  // "invalid-activation"). The thrown error object's identity already scopes this propagation; the
  // operation + correlation pair prevents a genuinely different nested operation from disappearing.
  return `${input.operation}\0${correlationIdOrUnknown(input.correlationId)}`;
}

function failureLogWasRecorded(
  input: WorkspaceLifecycleFailureInput,
  error: TaskWorkspaceError,
): boolean {
  return (
    RECORDED_FAILURE_LOG_KEYS.get(error)?.has(failureLogKey(input)) === true ||
    input.failureOutcomeAlreadyRecorded?.() === true
  );
}

function markFailureLogRecorded(
  input: WorkspaceLifecycleFailureInput,
  error: TaskWorkspaceError,
): void {
  const key = failureLogKey(input);
  const recorded = RECORDED_FAILURE_LOG_KEYS.get(error);
  if (recorded === undefined) RECORDED_FAILURE_LOG_KEYS.set(error, new Set([key]));
  else recorded.add(key);
}

export async function runWithWorkspaceLifecycleFailureLogging<T>(
  seam: WorkspaceActivityLogSeam,
  input: WorkspaceLifecycleFailureInput,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TaskWorkspaceError) {
      if (!failureLogWasRecorded(input, error)) logWorkspaceLifecycleFailure(seam, input, error);
      markFailureLogRecorded(input, error);
    }
    throw error;
  }
}

// The managed-identity mint probes the managed root's creation-time support once per provision.
// Its verdict is evidence of its own: a later `identity-unsupported` or a spurious `pointer-stale`
// on an aliasing volume is reconstructed from this line, not guessed (#3376 review P2).
export function logWorkspaceIdentityProbe(
  seam: WorkspaceActivityLogSeam,
  input: {
    readonly correlationId: string | undefined;
    readonly support: CreationTimeSupport;
  },
): void {
  const sink = seam.activityLog ?? processServerLogSink();
  sink.write({
    category: "diagnostic",
    op: "task-workspace.identity.creation-time-probe",
    level: input.support === "durable" ? "info" : "warn",
    correlationId: correlationIdOrUnknown(input.correlationId),
    extra: { volume: "managed-root", support: input.support },
  });
}
