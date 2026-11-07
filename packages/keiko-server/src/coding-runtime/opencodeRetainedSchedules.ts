import type { DatabaseSync } from "node:sqlite";

import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

import type {
  EditEntryResult,
  RetainedSessionManifest,
  RetainedSessionStore,
} from "./opencodeSessionRetention.js";

/**
 * The schedules a retained native session holds (#4271, ADR-0137 D10), read and changed only
 * through the retention store's whole-entry, digest-verified `readEntry` and `editEntry`. The
 * retention audit already admits only rows of the retained session without any `if`/`until`
 * check, so what is read here is what the runtime will fire at a wake.
 *
 * A change is the producer's own: pause makes an active row `paused`, delete removes the row, and
 * resume makes a paused row `active` again with its failures and retry cleared. A resumed one-shot
 * whose time has passed, and a repeating schedule whose next slot has passed, fire once at the next
 * wake; the runtime then moves a repeating schedule to its following slot. A schedule whose end
 * time has passed, or that has no run left, is `done` instead.
 */

export type RetainedScheduleStatus = "active" | "paused" | "done";
export type RetainedScheduleCadence = "in" | "at" | "every" | "cron" | "other";
export type RetainedScheduleAction = "pause" | "resume" | "delete";

export const RETAINED_SCHEDULE_ACTIONS: readonly RetainedScheduleAction[] = [
  "pause",
  "resume",
  "delete",
];

/** The longest cadence text and name shown; the audit bounds the stored values already. */
const CADENCE_MAX_CHARS = 128;
const NAME_MAX_CHARS = 256;

export interface RetainedSchedule {
  readonly id: string;
  readonly name?: string | undefined;
  readonly status: RetainedScheduleStatus;
  readonly cadence: RetainedScheduleCadence;
  /** The cadence as the model wrote it (`30 minutes`, a cron line, a time); absent when unknown. */
  readonly cadenceText?: string | undefined;
  /** When the runtime fires it next: its due time, or its retry time when that is later. */
  readonly dueAtMs?: number | undefined;
  readonly runCount: number;
  readonly failures: number;
  /** The prompt the runtime posts when it fires; server-side only, it never leaves for the UI. */
  readonly prompt?: string | undefined;
  /** The narrowest mode a run that held the schedule was in; a wake never exceeds it. */
  readonly consentMode: CodingWorkbenchMode;
}

export interface RetainedTaskSchedules {
  readonly taskId: string;
  readonly sessionId: string;
  readonly retainedAtMs: number;
  readonly schedules: readonly RetainedSchedule[];
}

interface ScheduleRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly when?: unknown;
  readonly action?: unknown;
  readonly next_due_at?: unknown;
  readonly retry_at?: unknown;
  readonly run_count?: unknown;
  readonly failures?: unknown;
}

function hasScheduleTable(database: DatabaseSync): boolean {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule'")
      .get() !== undefined
  );
}

function integer(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

/** The largest distance from the epoch a JavaScript date can hold, in milliseconds. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** A time column as a date can hold it; any other value is no time at all, never a throw. */
function timeOf(value: unknown): number | undefined {
  const time = integer(value);
  return time !== undefined && Math.abs(time) <= MAX_DATE_MS ? time : undefined;
}

function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const CADENCES = new Set<RetainedScheduleCadence>(["in", "at", "every", "cron"]);

function cadenceOf(when: Record<string, unknown> | undefined): {
  readonly cadence: RetainedScheduleCadence;
  readonly cadenceText?: string;
} {
  const type = when?.type;
  if (typeof type !== "string" || !CADENCES.has(type as RetainedScheduleCadence)) {
    return { cadence: "other" };
  }
  const text = cadenceTextOf(when?.[type]);
  return {
    cadence: type as RetainedScheduleCadence,
    ...(text === undefined ? {} : { cadenceText: text.slice(0, CADENCE_MAX_CHARS) }),
  };
}

/**
 * The cadence as the runtime stored it. A number is a time; one outside the range a date can hold
 * (the column is model and runtime data) has no text rather than throwing `RangeError`, which would
 * otherwise stop every listing and every wake (#4271 audit).
 */
function cadenceTextOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function statusOf(value: unknown): RetainedScheduleStatus | undefined {
  return value === "active" || value === "paused" || value === "done" ? value : undefined;
}

function dueAt(row: ScheduleRow): number | undefined {
  // A due time a date cannot hold never wakes the task: it fails closed instead of throwing.
  const due = timeOf(row.next_due_at);
  if (due === undefined) return undefined;
  const retry = timeOf(row.retry_at);
  return retry !== undefined && retry > due ? retry : due;
}

function nameField(row: ScheduleRow): Pick<RetainedSchedule, "name"> {
  return typeof row.name === "string" && row.name.trim() !== ""
    ? { name: row.name.slice(0, NAME_MAX_CHARS) }
    : {};
}

function promptField(row: ScheduleRow): Pick<RetainedSchedule, "prompt"> {
  const action = parsedObject(row.action);
  const prompt = action?.type === "prompt" ? action.prompt : undefined;
  return typeof prompt === "string" && prompt.trim() !== "" ? { prompt } : {};
}

// A schedule the ledger does not name was never consented to in any mode but the narrowest.
function consentOf(id: string, manifest: RetainedSessionManifest): CodingWorkbenchMode {
  const modes = manifest.scheduleModes;
  return (
    (modes !== undefined && Object.hasOwn(modes, id) ? modes[id] : undefined) ?? "governed-assist"
  );
}

function scheduleOf(
  row: ScheduleRow,
  manifest: RetainedSessionManifest,
): RetainedSchedule | undefined {
  const status = statusOf(row.status);
  if (typeof row.id !== "string" || status === undefined) return undefined;
  const due = dueAt(row);
  return {
    id: row.id,
    ...nameField(row),
    status,
    ...cadenceOf(parsedObject(row.when)),
    ...(status === "active" && due !== undefined ? { dueAtMs: due } : {}),
    runCount: integer(row.run_count) ?? 0,
    failures: integer(row.failures) ?? 0,
    ...promptField(row),
    consentMode: consentOf(row.id, manifest),
  };
}

function readSchedules(
  database: DatabaseSync,
  manifest: RetainedSessionManifest,
): readonly RetainedSchedule[] {
  if (!hasScheduleTable(database)) return [];
  const rows = database
    .prepare(
      'SELECT id, name, status, "when", action, next_due_at, retry_at, run_count, failures FROM schedule WHERE session_id = ? ORDER BY time_created, id',
    )
    .all(manifest.sessionId) as readonly ScheduleRow[];
  const schedules: RetainedSchedule[] = [];
  for (const row of rows) {
    const schedule = scheduleOf(row, manifest);
    if (schedule !== undefined) schedules.push(schedule);
  }
  return schedules;
}

/**
 * The task's retained schedules; `undefined` when the task has no whole entry. An entry whose
 * manifest names no schedule is not opened.
 */
export function listRetainedSchedules(
  store: Pick<RetainedSessionStore, "readEntry">,
  taskId: string,
): RetainedTaskSchedules | undefined {
  return store.readEntry(taskId, (database, manifest) => ({
    taskId,
    sessionId: manifest.sessionId,
    retainedAtMs: manifest.retainedAtMs,
    schedules: manifest.scheduleModes === undefined ? [] : readSchedules(database, manifest),
  }));
}

/** Whether a task's manifest says it holds schedules, without opening its database. */
export function retainedScheduleCount(
  store: Pick<RetainedSessionStore, "readEntry">,
  taskId: string,
): number {
  return (
    store.readEntry(taskId, (_database, manifest) =>
      manifest.scheduleModes === undefined ? 0 : Object.keys(manifest.scheduleModes).length,
    ) ?? 0
  );
}

export type RetainedScheduleControlResult =
  | { readonly ok: true; readonly status: RetainedScheduleStatus | "deleted" }
  | {
      readonly ok: false;
      readonly reason:
        | "not-found"
        | "not-applicable"
        | "no-retained-state"
        | "integrity-failed"
        | "schema-unknown";
    };

type EditOutcome =
  | { readonly kind: "changed"; readonly status: RetainedScheduleStatus | "deleted" }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-applicable" };

interface ControlRow {
  readonly status?: unknown;
  readonly ends_at?: unknown;
  readonly remaining_runs?: unknown;
}

function finished(row: ControlRow, nowMs: number): boolean {
  const endsAt = integer(row.ends_at);
  const remaining = integer(row.remaining_runs);
  return (endsAt !== undefined && endsAt <= nowMs) || remaining === 0;
}

function applyControl(
  database: DatabaseSync,
  sessionId: string,
  scheduleId: string,
  action: RetainedScheduleAction,
  nowMs: number,
): EditOutcome {
  database.exec("PRAGMA busy_timeout = 5000");
  if (!hasScheduleTable(database)) return { kind: "not-found" };
  const row = database
    .prepare("SELECT status, ends_at, remaining_runs FROM schedule WHERE id = ? AND session_id = ?")
    .get(scheduleId, sessionId) as ControlRow | undefined;
  if (row === undefined) return { kind: "not-found" };
  if (action === "delete") {
    database
      .prepare("DELETE FROM schedule WHERE id = ? AND session_id = ?")
      .run(scheduleId, sessionId);
    return { kind: "changed", status: "deleted" };
  }
  if (action === "pause") {
    if (row.status !== "active") return { kind: "not-applicable" };
    database
      .prepare("UPDATE schedule SET status = 'paused', time_updated = ? WHERE id = ?")
      .run(nowMs, scheduleId);
    return { kind: "changed", status: "paused" };
  }
  if (row.status !== "paused") return { kind: "not-applicable" };
  const status: RetainedScheduleStatus = finished(row, nowMs) ? "done" : "active";
  database
    .prepare(
      "UPDATE schedule SET status = ?, failures = 0, retry_at = NULL, time_updated = ? WHERE id = ?",
    )
    .run(status, nowMs, scheduleId);
  return { kind: "changed", status };
}

function controlRefusal(
  status: unknown,
  action: RetainedScheduleAction,
): "not-found" | "not-applicable" | undefined {
  if (status === undefined) return "not-found";
  if (action === "pause" && status !== "active") return "not-applicable";
  if (action === "resume" && status !== "paused") return "not-applicable";
  return undefined;
}

/**
 * Pauses, resumes or deletes one schedule of the task's retained session. A change the row does not
 * admit is refused before the entry is touched; the edit itself checks the row again.
 */
export function controlRetainedSchedule(
  store: Pick<RetainedSessionStore, "readEntry" | "editEntry">,
  taskId: string,
  scheduleId: string,
  action: RetainedScheduleAction,
  nowMs: number,
): RetainedScheduleControlResult {
  const current = store.readEntry(taskId, (database, manifest) => ({
    sessionId: manifest.sessionId,
    status: hasScheduleTable(database)
      ? (
          database
            .prepare("SELECT status FROM schedule WHERE id = ? AND session_id = ?")
            .get(scheduleId, manifest.sessionId) as { readonly status?: unknown } | undefined
        )?.status
      : undefined,
  }));
  if (current === undefined) return { ok: false, reason: "no-retained-state" };
  const refusal = controlRefusal(current.status, action);
  if (refusal !== undefined) return { ok: false, reason: refusal };
  const edited: EditEntryResult<EditOutcome> = store.editEntry(taskId, (database) =>
    applyControl(database, current.sessionId, scheduleId, action, nowMs),
  );
  if (!edited.ok) return edited;
  const outcome = edited.value;
  if (outcome.kind === "changed") return { ok: true, status: outcome.status };
  return { ok: false, reason: outcome.kind };
}
