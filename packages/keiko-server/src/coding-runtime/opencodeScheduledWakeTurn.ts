import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  holdSchedulerLease,
  readScheduleFireState,
  releaseSchedulerLease,
} from "./opencodeScheduleLease.js";
import { runtimeDatabasePath } from "./opencodeSessionContinuation.js";

/**
 * The wake run's one turn (#4271, ADR-0137 D10): Keiko posts no prompt. The turn is armed, the
 * session's live database is checked once more for schedules Keiko never admits, and Keiko's
 * scheduler lease is released; the runtime then takes the lease at its next look (at most 30
 * seconds) and fires the due schedule into the session, whose message carries the schedule. As
 * soon as a schedule's run count grows, Keiko takes the lease back, so nothing due later fires in
 * this run. A schedule that has not fired within `SCHEDULED_WAKE_FIRE_WAIT_MS` is a missed wake:
 * the lease is held again and the armed turn is cancelled, which fails the run's turn.
 */

export const SCHEDULED_WAKE_FIRE_WAIT_MS = 120_000;
const FIRE_POLL_MS = 500;

/** The part of a ready native run the wake turn uses. */
export interface ScheduledWakeRun {
  readonly runId: string;
  readonly runRoot: string;
  readonly sessionId: string;
  readonly ready: boolean;
  readonly runtimeAdapter: { readonly cancelTurn: () => void };
}

export type ScheduleLeaseAction = "hold" | "release" | "rehold";
export type ScheduleLeaseOutcome =
  "held" | "released" | "absent" | "fired" | "missed" | "refused" | "failed";
export type ScheduleLeaseReason = "unadmitted-rows" | "no-active-schedule" | "run-closed";

const SCHEDULE_LEASE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.schedule.lease",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeScheduledWakeTurn.recordScheduleLease",
  diagnosticWhen: [{ field: "outcome", values: ["missed", "refused", "failed"] }],
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["hold", "release", "rehold"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["held", "released", "absent", "fired", "missed", "refused", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["unadmitted-rows", "no-active-schedule", "run-closed"],
    },
    activeScheduleCount: { type: "integer", dataClass: "count", required: false },
    firedCount: { type: "integer", dataClass: "count", required: false },
    waitMs: { type: "integer", dataClass: "duration", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-scheduled-wake"],
  proofIds: ["coding-runtime.schedule.lease.emitted-line"],
  releaseImpact: "minor",
});

export interface ScheduleLeaseRecord {
  readonly runId: string;
  readonly action: ScheduleLeaseAction;
  readonly outcome: ScheduleLeaseOutcome;
  readonly reason?: ScheduleLeaseReason | undefined;
  readonly activeScheduleCount?: number | undefined;
  readonly firedCount?: number | undefined;
  readonly waitMs?: number | undefined;
  readonly error?: unknown;
}

export function recordScheduleLease(
  activityLog: ServerLogSink | undefined,
  record: ScheduleLeaseRecord,
): void {
  const { runId, error, reason, activeScheduleCount, firedCount, waitMs, action, outcome } = record;
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(SCHEDULE_LEASE_OPERATION, leaseHeader(runId, outcome), {
      runId,
      action,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(activeScheduleCount === undefined ? {} : { activeScheduleCount }),
      ...(firedCount === undefined ? {} : { firedCount }),
      ...(waitMs === undefined ? {} : { waitMs }),
      ...errorFields(error),
    }),
  );
}

function leaseHeader(
  runId: string,
  outcome: ScheduleLeaseOutcome,
):
  | { readonly correlationId: string }
  | {
      readonly correlationId: string;
      readonly level: "warn";
      readonly errorKind: "internal" | "validation-failed";
    } {
  const correlationId = correlationIdOrUnknown(runId);
  if (outcome === "failed") return { correlationId, level: "warn", errorKind: "internal" };
  return outcome === "missed" || outcome === "refused"
    ? { correlationId, level: "warn", errorKind: "validation-failed" }
    : { correlationId };
}

/** The body-free frames and causes of a failure; nothing for a line without one. */
export function errorFields(error: unknown): {
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
} {
  return error === undefined
    ? {}
    : { frames: keikoStackFrames(error), causeChain: causeChain(error) };
}

/**
 * Writes Keiko's hold into the run's live database. A hold that cannot be written throws: a run
 * whose scheduler Keiko cannot hold must not become ready.
 */
export function holdRunScheduler(
  activityLog: ServerLogSink | undefined,
  run: Pick<ScheduledWakeRun, "runId" | "runRoot">,
  action: "hold" | "rehold",
): void {
  try {
    const held = holdSchedulerLease(runtimeDatabasePath(run.runRoot));
    recordScheduleLease(activityLog, {
      runId: run.runId,
      action,
      outcome: held ? "held" : "absent",
    });
  } catch (error) {
    recordScheduleLease(activityLog, { runId: run.runId, action, outcome: "failed", error });
    throw error;
  }
}

export interface ScheduledWakeTurnOptions {
  readonly activityLog: ServerLogSink | undefined;
  readonly fireWaitMs?: number | undefined;
  readonly pollMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Starts the wake run's armed turn. `true` when the lease was released and the runtime may fire;
 * `false` (the turn cancelled) when the live database holds a schedule Keiko never admits or no
 * active schedule at all. The watch that takes the lease back runs on; its outcome is recorded.
 */
export function startScheduledWakeTurn(
  run: ScheduledWakeRun,
  options: ScheduledWakeTurnOptions,
): boolean {
  const database = runtimeDatabasePath(run.runRoot);
  const { activityLog } = options;
  let before: ReturnType<typeof readScheduleFireState>;
  try {
    before = readScheduleFireState(database, run.sessionId);
    const refusal = handoffRefusal(before);
    if (refusal !== undefined) {
      recordScheduleLease(activityLog, {
        runId: run.runId,
        action: "release",
        outcome: "refused",
        reason: refusal,
        activeScheduleCount: before.active,
      });
      run.runtimeAdapter.cancelTurn();
      return false;
    }
    releaseSchedulerLease(database);
  } catch (error) {
    recordScheduleLease(activityLog, {
      runId: run.runId,
      action: "release",
      outcome: "failed",
      error,
    });
    run.runtimeAdapter.cancelTurn();
    return false;
  }
  recordScheduleLease(activityLog, {
    runId: run.runId,
    action: "release",
    outcome: "released",
    activeScheduleCount: before.active,
  });
  void watchScheduledFire(run, database, before.runCount, options);
  return true;
}

function handoffRefusal(
  state: ReturnType<typeof readScheduleFireState>,
): ScheduleLeaseReason | undefined {
  if (state.unadmitted > 0) return "unadmitted-rows";
  return state.active === 0 ? "no-active-schedule" : undefined;
}

async function watchScheduledFire(
  run: ScheduledWakeRun,
  database: string,
  runCountBefore: number,
  options: ScheduledWakeTurnOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const started = now();
  const deadline = started + (options.fireWaitMs ?? SCHEDULED_WAKE_FIRE_WAIT_MS);
  const pollMs = options.pollMs ?? FIRE_POLL_MS;
  for (;;) {
    const verdict = fireVerdict(run, database, runCountBefore, deadline, now);
    if (verdict !== undefined) {
      settleWatch(run, options.activityLog, verdict, now() - started);
      return;
    }
    await sleep(pollMs);
  }
}

type FireVerdict =
  | { readonly kind: "fired"; readonly firedCount: number }
  | { readonly kind: "missed" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly error: unknown };

function fireVerdict(
  run: ScheduledWakeRun,
  database: string,
  runCountBefore: number,
  deadline: number,
  now: () => number,
): FireVerdict | undefined {
  if (!run.ready) return { kind: "closed" };
  try {
    const fired = readScheduleFireState(database, run.sessionId).runCount - runCountBefore;
    if (fired > 0) return { kind: "fired", firedCount: fired };
  } catch (error) {
    return { kind: "failed", error };
  }
  return now() >= deadline ? { kind: "missed" } : undefined;
}

function settleWatch(
  run: ScheduledWakeRun,
  activityLog: ServerLogSink | undefined,
  verdict: FireVerdict,
  waitMs: number,
): void {
  if (verdict.kind === "closed") {
    // The run ended first: its database is retained without the lease row, or removed.
    recordScheduleLease(activityLog, {
      runId: run.runId,
      action: "rehold",
      outcome: "absent",
      reason: "run-closed",
      waitMs,
    });
    return;
  }
  try {
    holdSchedulerLease(runtimeDatabasePath(run.runRoot));
  } catch (error) {
    recordScheduleLease(activityLog, {
      runId: run.runId,
      action: "rehold",
      outcome: "failed",
      error,
    });
    run.runtimeAdapter.cancelTurn();
    return;
  }
  if (verdict.kind === "fired") {
    recordScheduleLease(activityLog, {
      runId: run.runId,
      action: "rehold",
      outcome: "fired",
      firedCount: verdict.firedCount,
      waitMs,
    });
    return;
  }
  recordScheduleLease(activityLog, {
    runId: run.runId,
    action: "rehold",
    outcome: verdict.kind === "missed" ? "missed" : "failed",
    waitMs,
    ...(verdict.kind === "failed" ? { error: verdict.error } : {}),
  });
  run.runtimeAdapter.cancelTurn();
}
