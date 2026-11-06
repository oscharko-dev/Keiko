import { createHash } from "node:crypto";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { compareCodingWorkbenchModeAuthority } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchSchedule,
  CodingWorkbenchScheduleAction,
  CodingWorkbenchScheduleStatus,
  CodingWorkbenchScheduleWait,
} from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  controlRetainedSchedule,
  listRetainedSchedules,
  type RetainedSchedule,
  type RetainedScheduleControlResult,
} from "./opencodeRetainedSchedules.js";
import { errorFields } from "./opencodeScheduledWakeTurn.js";
import { retainedSessionKey, type RetainedSessionStore } from "./opencodeSessionRetention.js";

/**
 * Scheduled continuations of Coding History tasks (#4271, ADR-0137 D10, owner decision
 * 2026-11-06 "Keiko weckt die Aufgabe").
 *
 * A native run's model may schedule a prompt that wakes its own session later. The schedule stays
 * with the task's retained session (`opencodeSessionRetention.ts`), and the runtime never fires it
 * inside a run a human started (`opencodeScheduleLease.ts`). This service looks at the retained
 * schedules while Keiko runs and, when one is due, continues its task as a scheduled wake run: the
 * task's retained session resumed, in the narrower of the mode the schedule was consented to and
 * the mode of the task's latest run, clamped to the deployment ceiling by the ordinary start.
 *
 * A due wake waits while any run holds the runtime slot (live, held for undo, or to be recovered),
 * while the task's workspace is not the active one, and for at least `MIN_WAKE_INTERVAL_MS` after
 * the task's previous wake. A wake whose schedule did not fire is a miss: the next attempt backs
 * off, and after `MAX_MISSES` misses in a row the schedule is paused, which the Workbench shows.
 * Nothing wakes after a process restart until the next look finds the slot free; a run left to
 * recover keeps the slot until a human acknowledges it.
 */

export const SCHEDULED_WAKE_TICK_MS = 15_000;
export const MIN_WAKE_INTERVAL_MS = 60_000;
export const MAX_MISSES = 3;
const MISS_BACKOFF_MS = 60_000;
const MISS_BACKOFF_MAX_MS = 3_600_000;
/** How long a settled wake run may take to leave its retained entry before it counts as lost. */
const RETAIN_WAIT_MS = 600_000;

export type ScheduledWakeBlock = "run-active" | "undo-window" | "shutting-down";

/** What a wake start needs to know about the schedule that is due. */
export interface ScheduledWakePlan {
  readonly taskId: string;
  readonly scheduleId: string;
  /** The schedule's prompt, or its name: the wake run's task intent in Coding History. */
  readonly intent: string;
  readonly consentMode: CodingWorkbenchMode;
}

export type ScheduledWakeStart =
  | { readonly ok: true; readonly runId: string; readonly mode: CodingWorkbenchMode }
  | { readonly ok: false; readonly refusal: ScheduledWakeRefusal; readonly runId?: string };

export type ScheduledWakeRefusal =
  "active-run-conflict" | "authority-resolution-failed" | "invalid-intent" | "start-failed";

/** The orchestrator side the service needs; `codingRuntimeOrchestrator.ts` implements it. */
export interface ScheduledWakeHost {
  readonly blocked: () => ScheduledWakeBlock | undefined;
  /** Whether the task is this operator's, in the active workspace, with a run to continue. */
  readonly taskAdmitted: (taskId: string) => boolean;
  /** Whether the task is this operator's (any workspace). */
  readonly taskOwned: (taskId: string) => boolean;
  /** The task whose run is live or held for undo, if any: its retained entry is not edited. */
  readonly liveTaskId: () => string | undefined;
  readonly start: (plan: ScheduledWakePlan) => Promise<ScheduledWakeStart>;
  /** Runs `work` in the orchestrator's serial lane, so no start checks the entry out meanwhile. */
  readonly serial: <T>(work: () => T) => Promise<T>;
}

export interface CodingScheduledWakesOptions {
  readonly store: () => RetainedSessionStore | undefined;
  readonly host: ScheduledWakeHost;
  readonly activityLog?: ServerLogSink | undefined;
  readonly now?: (() => number) | undefined;
  readonly tickMs?: number | undefined;
}

type WakeOutcome =
  | "started"
  | "refused"
  | "waiting"
  | "fired"
  | "missed"
  | "auto-paused"
  | "removed"
  | "retain-lost"
  | "failed";

const SCHEDULE_WAKE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.schedule.wake",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingScheduledWakes.recordScheduleWake",
  diagnosticWhen: [
    { field: "outcome", values: ["missed", "auto-paused", "retain-lost", "failed"] },
  ],
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "started",
        "refused",
        "waiting",
        "fired",
        "missed",
        "auto-paused",
        "removed",
        "retain-lost",
        "failed",
      ],
    },
    taskDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    scheduleDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    runId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    mode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
    wait: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["run-active", "workspace-inactive", "retrying"],
    },
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "active-run-conflict",
        "authority-resolution-failed",
        "invalid-intent",
        "start-failed",
      ],
    },
    missCount: { type: "integer", dataClass: "count", required: false },
    firedCount: { type: "integer", dataClass: "count", required: false },
    dueLagMs: { type: "integer", dataClass: "duration", required: false },
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
  proofIds: ["coding-runtime.schedule.wake.emitted-line"],
  releaseImpact: "minor",
});

const SCHEDULE_CONTROL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.schedule.control",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingScheduledWakes.recordScheduleControl",
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pause", "resume", "delete", "list"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["changed", "listed", "refused", "failed"],
    },
    initiator: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["human", "missed-wakes"],
    },
    status: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["active", "paused", "done", "deleted"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "not-found",
        "not-applicable",
        "no-retained-state",
        "integrity-failed",
        "schema-unknown",
        "run-active",
        "unavailable",
      ],
    },
    taskDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    scheduleDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    scheduleCount: { type: "integer", dataClass: "count", required: false },
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
  proofIds: ["coding-runtime.schedule.control.emitted-line"],
  releaseImpact: "minor",
});

/** A schedule id is the runtime's: it is only ever logged as a digest. */
export function scheduleDigest(scheduleId: string): string {
  return createHash("sha256").update(`keiko.schedule.v1\0${scheduleId}`).digest("hex");
}

/** The correlation of a schedule's lines that belong to no run: derived from its digest. */
export function scheduleCorrelationId(scheduleId: string): string {
  return `schedule-${scheduleDigest(scheduleId).slice(0, 32)}`;
}

export interface ScheduleWakeRecord {
  readonly correlationId: string;
  readonly outcome: WakeOutcome;
  readonly taskId: string;
  readonly scheduleId?: string | undefined;
  readonly runId?: string | undefined;
  readonly mode?: CodingWorkbenchMode | undefined;
  readonly wait?: CodingWorkbenchScheduleWait | undefined;
  readonly refusal?: ScheduledWakeRefusal | undefined;
  readonly missCount?: number | undefined;
  readonly firedCount?: number | undefined;
  readonly dueLagMs?: number | undefined;
  readonly error?: unknown;
}

const WARNED_WAKES = new Set<WakeOutcome>(["missed", "auto-paused", "retain-lost", "failed"]);

export function recordScheduleWake(
  activityLog: ServerLogSink | undefined,
  record: ScheduleWakeRecord,
): void {
  const { outcome } = record;
  const warned = WARNED_WAKES.has(outcome);
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      SCHEDULE_WAKE_OPERATION,
      {
        correlationId: correlationIdOrUnknown(record.correlationId),
        ...(warned
          ? { level: "warn", errorKind: outcome === "failed" ? "internal" : "validation-failed" }
          : {}),
      } as const,
      {
        outcome,
        taskDigest: retainedSessionKey(record.taskId),
        ...wakeIdentityFields(record),
        ...wakeCountFields(record),
        ...errorFields(record.error),
      },
    ),
  );
}

function wakeIdentityFields(record: ScheduleWakeRecord): {
  readonly scheduleDigest?: string;
  readonly runId?: string;
  readonly mode?: CodingWorkbenchMode;
  readonly wait?: CodingWorkbenchScheduleWait;
  readonly refusal?: ScheduledWakeRefusal;
} {
  return {
    ...(record.scheduleId === undefined
      ? {}
      : { scheduleDigest: scheduleDigest(record.scheduleId) }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.mode === undefined ? {} : { mode: record.mode }),
    ...(record.wait === undefined ? {} : { wait: record.wait }),
    ...(record.refusal === undefined ? {} : { refusal: record.refusal }),
  };
}

function wakeCountFields(record: ScheduleWakeRecord): {
  readonly missCount?: number;
  readonly firedCount?: number;
  readonly dueLagMs?: number;
} {
  return {
    ...(record.missCount === undefined ? {} : { missCount: record.missCount }),
    ...(record.firedCount === undefined ? {} : { firedCount: record.firedCount }),
    ...(record.dueLagMs === undefined ? {} : { dueLagMs: Math.max(0, record.dueLagMs) }),
  };
}

export type ScheduleControlReason =
  | Extract<RetainedScheduleControlResult, { readonly ok: false }>["reason"]
  | "run-active"
  | "unavailable";

export interface ScheduleControlRecord {
  readonly correlationId: string;
  readonly action: CodingWorkbenchScheduleAction | "list";
  readonly outcome: "changed" | "listed" | "refused" | "failed";
  readonly initiator: "human" | "missed-wakes";
  readonly taskId: string;
  readonly scheduleId?: string | undefined;
  readonly status?: CodingWorkbenchScheduleStatus | "deleted" | undefined;
  readonly reason?: ScheduleControlReason | undefined;
  readonly scheduleCount?: number | undefined;
  readonly error?: unknown;
}

export function recordScheduleControl(
  activityLog: ServerLogSink | undefined,
  record: ScheduleControlRecord,
): void {
  const { error, outcome } = record;
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      SCHEDULE_CONTROL_OPERATION,
      {
        correlationId: correlationIdOrUnknown(record.correlationId),
        ...(outcome === "failed" ? { level: "warn", errorKind: "internal" } : {}),
      } as const,
      {
        action: record.action,
        outcome,
        initiator: record.initiator,
        taskDigest: retainedSessionKey(record.taskId),
        ...(record.scheduleId === undefined
          ? {}
          : { scheduleDigest: scheduleDigest(record.scheduleId) }),
        ...(record.status === undefined ? {} : { status: record.status }),
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        ...(record.scheduleCount === undefined ? {} : { scheduleCount: record.scheduleCount }),
        ...errorFields(error),
      },
    ),
  );
}

/** The wake that ran last, until the look after its run's retention says whether it fired. */
interface PendingWake {
  readonly taskId: string;
  readonly scheduleId: string;
  readonly runId: string;
  readonly runCountBefore: number;
  readonly startedAtMs: number;
}

interface MissState {
  readonly misses: number;
  readonly retryAtMs: number;
}

interface DueSchedule {
  readonly taskId: string;
  readonly schedule: RetainedSchedule & { readonly dueAtMs: number };
}

export type ScheduleListResult =
  | { readonly ok: true; readonly schedules: readonly CodingWorkbenchSchedule[] }
  | { readonly ok: false; readonly reason: "not-found" | "unavailable" };

export type ScheduleControlOutcome =
  | { readonly ok: true; readonly status: CodingWorkbenchScheduleStatus | "deleted" }
  | { readonly ok: false; readonly reason: ScheduleControlReason };

/** The narrower of two modes. */
export function narrowerMode(
  left: CodingWorkbenchMode,
  right: CodingWorkbenchMode,
): CodingWorkbenchMode {
  return compareCodingWorkbenchModeAuthority(left, right) <= 0 ? left : right;
}

export class CodingScheduledWakes {
  private readonly now: () => number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private pending: PendingWake | undefined;
  private readonly misses = new Map<string, MissState>();
  private readonly lastWakeAt = new Map<string, number>();
  /** The wait last recorded per schedule, so a wait is one line, not one per look. */
  private readonly waits = new Map<string, CodingWorkbenchScheduleWait>();

  public constructor(private readonly options: CodingScheduledWakesOptions) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? SCHEDULED_WAKE_TICK_MS;
  }

  public start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look: settles the previous wake, then starts the earliest due one when nothing waits. */
  public async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.look();
    } catch (error) {
      // A look that fails (an unreadable entry, a store fault) is one line; the next look retries.
      recordScheduleWake(this.options.activityLog, {
        correlationId: this.pending?.runId ?? "",
        outcome: "failed",
        taskId: this.pending?.taskId ?? "",
        error,
      });
    } finally {
      this.ticking = false;
    }
  }

  private async look(): Promise<void> {
    const store = this.options.store();
    if (store === undefined) return;
    const block = this.options.host.blocked();
    if (block !== undefined) {
      if (block !== "shutting-down") this.noteWaits(store, "run-active");
      return;
    }
    if (this.pending !== undefined && !this.settlePending(store, this.pending)) return;
    const due = this.earliestDue(store);
    if (due !== undefined) await this.wake(due);
  }

  private dueSchedules(store: RetainedSessionStore): readonly DueSchedule[] {
    const nowMs = this.now();
    const due: DueSchedule[] = [];
    for (const taskId of store.listTaskIds()) {
      const listed = listRetainedSchedules(store, taskId);
      for (const schedule of listed?.schedules ?? []) {
        if (
          schedule.status === "active" &&
          schedule.dueAtMs !== undefined &&
          schedule.dueAtMs <= nowMs
        )
          due.push({ taskId, schedule: { ...schedule, dueAtMs: schedule.dueAtMs } });
      }
    }
    return due.sort((left, right) => left.schedule.dueAtMs - right.schedule.dueAtMs);
  }

  private earliestDue(store: RetainedSessionStore): DueSchedule | undefined {
    for (const candidate of this.dueSchedules(store)) {
      const wait = this.waitOf(candidate);
      if (wait === undefined) return candidate;
      this.noteWait(candidate, wait);
    }
    return undefined;
  }

  private waitOf(candidate: DueSchedule): CodingWorkbenchScheduleWait | undefined {
    const nowMs = this.now();
    const miss = this.misses.get(candidate.schedule.id);
    if (miss !== undefined && miss.retryAtMs > nowMs) return "retrying";
    const last = this.lastWakeAt.get(candidate.taskId);
    if (last !== undefined && nowMs - last < MIN_WAKE_INTERVAL_MS) return "retrying";
    return this.options.host.taskAdmitted(candidate.taskId) ? undefined : "workspace-inactive";
  }

  private noteWaits(store: RetainedSessionStore, wait: CodingWorkbenchScheduleWait): void {
    for (const candidate of this.dueSchedules(store)) this.noteWait(candidate, wait);
  }

  private noteWait(candidate: DueSchedule, wait: CodingWorkbenchScheduleWait): void {
    if (this.waits.get(candidate.schedule.id) === wait) return;
    this.waits.set(candidate.schedule.id, wait);
    recordScheduleWake(this.options.activityLog, {
      correlationId: scheduleCorrelationId(candidate.schedule.id),
      outcome: "waiting",
      taskId: candidate.taskId,
      scheduleId: candidate.schedule.id,
      wait,
      dueLagMs: this.now() - candidate.schedule.dueAtMs,
    });
  }

  private async wake(due: DueSchedule): Promise<void> {
    const { taskId, schedule } = due;
    this.waits.delete(schedule.id);
    const startedAtMs = this.now();
    this.lastWakeAt.set(taskId, startedAtMs);
    const started = await this.options.host.start({
      taskId,
      scheduleId: schedule.id,
      intent: schedule.prompt ?? schedule.name ?? "Scheduled continuation",
      consentMode: schedule.consentMode,
    });
    if (!started.ok) {
      recordScheduleWake(this.options.activityLog, {
        correlationId: started.runId ?? scheduleCorrelationId(schedule.id),
        outcome: "refused",
        taskId,
        scheduleId: schedule.id,
        refusal: started.refusal,
        ...(started.runId === undefined ? {} : { runId: started.runId }),
      });
      // A run that took the slot first is no miss: the wake waits for it. Any other refusal is.
      if (started.refusal !== "active-run-conflict")
        this.recordMiss(taskId, schedule.id, started.runId);
      return;
    }
    this.pending = {
      taskId,
      scheduleId: schedule.id,
      runId: started.runId,
      runCountBefore: schedule.runCount,
      startedAtMs,
    };
    recordScheduleWake(this.options.activityLog, {
      correlationId: started.runId,
      outcome: "started",
      taskId,
      scheduleId: schedule.id,
      runId: started.runId,
      mode: started.mode,
      dueLagMs: startedAtMs - schedule.dueAtMs,
    });
  }

  /** `true` once the previous wake is settled; `false` while its run has not left its entry yet. */
  private settlePending(store: RetainedSessionStore, pending: PendingWake): boolean {
    const listed = listRetainedSchedules(store, pending.taskId);
    const elapsed = this.now() - pending.startedAtMs;
    // An entry retained no later than the wake started is the one the wake run checked out.
    if (listed === undefined || listed.retainedAtMs <= pending.startedAtMs) {
      if (listed !== undefined && elapsed < RETAIN_WAIT_MS) return false;
      this.pending = undefined;
      this.recordSettled(pending, "retain-lost");
      return true;
    }
    this.pending = undefined;
    const schedule = listed.schedules.find((candidate) => candidate.id === pending.scheduleId);
    if (schedule === undefined) {
      this.misses.delete(pending.scheduleId);
      this.recordSettled(pending, "removed");
      return true;
    }
    const fired = schedule.runCount - pending.runCountBefore;
    if (fired > 0) {
      this.misses.delete(pending.scheduleId);
      this.recordSettled(pending, "fired", { firedCount: fired });
      return true;
    }
    this.recordMiss(pending.taskId, pending.scheduleId, pending.runId);
    return true;
  }

  private recordSettled(
    pending: PendingWake,
    outcome: WakeOutcome,
    extra: Pick<ScheduleWakeRecord, "firedCount"> = {},
  ): void {
    recordScheduleWake(this.options.activityLog, {
      correlationId: pending.runId,
      outcome,
      taskId: pending.taskId,
      scheduleId: pending.scheduleId,
      runId: pending.runId,
      ...extra,
    });
  }

  private recordMiss(taskId: string, scheduleId: string, runId: string | undefined): void {
    const misses = (this.misses.get(scheduleId)?.misses ?? 0) + 1;
    const correlationId = runId ?? scheduleCorrelationId(scheduleId);
    if (misses >= MAX_MISSES) {
      this.misses.delete(scheduleId);
      this.autoPause(taskId, scheduleId, correlationId, misses);
      return;
    }
    const backoff = Math.min(MISS_BACKOFF_MS * 2 ** (misses - 1), MISS_BACKOFF_MAX_MS);
    this.misses.set(scheduleId, { misses, retryAtMs: this.now() + backoff });
    recordScheduleWake(this.options.activityLog, {
      correlationId,
      outcome: "missed",
      taskId,
      scheduleId,
      missCount: misses,
      ...(runId === undefined ? {} : { runId }),
    });
  }

  private autoPause(
    taskId: string,
    scheduleId: string,
    correlationId: string,
    misses: number,
  ): void {
    const store = this.options.store();
    const result: RetainedScheduleControlResult =
      store === undefined
        ? { ok: false, reason: "no-retained-state" }
        : controlRetainedSchedule(store, taskId, scheduleId, "pause", this.now());
    recordScheduleControl(this.options.activityLog, {
      correlationId,
      action: "pause",
      outcome: result.ok ? "changed" : "refused",
      initiator: "missed-wakes",
      taskId,
      scheduleId,
      ...(result.ok ? { status: result.status } : { reason: result.reason }),
    });
    recordScheduleWake(this.options.activityLog, {
      correlationId,
      outcome: "auto-paused",
      taskId,
      scheduleId,
      missCount: misses,
    });
  }

  /** The task's schedules as the Workbench shows them; the prompt never leaves the server. */
  public list(taskId: string, correlationId: string): ScheduleListResult {
    const store = this.options.store();
    if (store === undefined) return { ok: false, reason: "unavailable" };
    if (!this.options.host.taskOwned(taskId)) return { ok: false, reason: "not-found" };
    const listed = listRetainedSchedules(store, taskId);
    const schedules = (listed?.schedules ?? []).map((schedule) => this.view(taskId, schedule));
    recordScheduleControl(this.options.activityLog, {
      correlationId,
      action: "list",
      outcome: "listed",
      initiator: "human",
      taskId,
      scheduleCount: schedules.length,
    });
    return { ok: true, schedules };
  }

  private view(taskId: string, schedule: RetainedSchedule): CodingWorkbenchSchedule {
    const wait = this.viewWait(taskId, schedule);
    return {
      id: schedule.id,
      ...(schedule.name === undefined ? {} : { name: schedule.name }),
      status: schedule.status,
      cadence: schedule.cadence,
      ...(schedule.cadenceText === undefined ? {} : { cadenceText: schedule.cadenceText }),
      ...(schedule.dueAtMs === undefined
        ? {}
        : { dueAt: new Date(schedule.dueAtMs).toISOString() }),
      runCount: schedule.runCount,
      ...(wait === undefined ? {} : { wait }),
    };
  }

  private viewWait(
    taskId: string,
    schedule: RetainedSchedule,
  ): CodingWorkbenchScheduleWait | undefined {
    if (
      schedule.status !== "active" ||
      schedule.dueAtMs === undefined ||
      schedule.dueAtMs > this.now()
    )
      return undefined;
    if (this.options.host.blocked() !== undefined) return "run-active";
    return this.waitOf({ taskId, schedule: { ...schedule, dueAtMs: schedule.dueAtMs } });
  }

  /** A human's pause, resume or delete of one schedule, never while the task's run holds it. */
  public async control(
    taskId: string,
    scheduleId: string,
    action: CodingWorkbenchScheduleAction,
    correlationId: string,
  ): Promise<ScheduleControlOutcome> {
    let outcome: ScheduleControlOutcome;
    try {
      outcome = await this.options.host.serial(() => this.controlNow(taskId, scheduleId, action));
    } catch (error) {
      // The entry could not be read or rewritten: the change did not happen, and the line says why.
      recordScheduleControl(this.options.activityLog, {
        correlationId,
        action,
        outcome: "failed",
        initiator: "human",
        taskId,
        scheduleId,
        reason: "unavailable",
        error,
      });
      return { ok: false, reason: "unavailable" };
    }
    recordScheduleControl(this.options.activityLog, {
      correlationId,
      action,
      outcome: outcome.ok ? "changed" : "refused",
      initiator: "human",
      taskId,
      scheduleId,
      ...(outcome.ok ? { status: outcome.status } : { reason: outcome.reason }),
    });
    if (outcome.ok) {
      this.misses.delete(scheduleId);
      this.waits.delete(scheduleId);
    }
    return outcome;
  }

  private controlNow(
    taskId: string,
    scheduleId: string,
    action: CodingWorkbenchScheduleAction,
  ): ScheduleControlOutcome {
    const store = this.options.store();
    if (store === undefined) return { ok: false, reason: "unavailable" };
    if (!this.options.host.taskOwned(taskId)) return { ok: false, reason: "not-found" };
    if (this.options.host.liveTaskId() === taskId || this.pending?.taskId === taskId)
      return { ok: false, reason: "run-active" };
    return controlRetainedSchedule(store, taskId, scheduleId, action, this.now());
  }
}
