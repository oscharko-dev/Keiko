/**
 * The Coding Workbench's view of a task's scheduled continuations (#4271, ADR-0137 D10).
 *
 * A native run's model can schedule a prompt that wakes its own session later. Keiko keeps the
 * schedule with the task's retained session and, at its due time, continues the task as a
 * scheduled wake run. The browser lists a task's schedules and can pause, resume or delete one;
 * it never sees the scheduled prompt, and it never names a session.
 */

export const CODING_WORKBENCH_SCHEDULE_STATUSES = ["active", "paused", "done"] as const;
export type CodingWorkbenchScheduleStatus = (typeof CODING_WORKBENCH_SCHEDULE_STATUSES)[number];

export const CODING_WORKBENCH_SCHEDULE_CADENCES = ["in", "at", "every", "cron", "other"] as const;
export type CodingWorkbenchScheduleCadence = (typeof CODING_WORKBENCH_SCHEDULE_CADENCES)[number];

export const CODING_WORKBENCH_SCHEDULE_ACTIONS = ["pause", "resume", "delete"] as const;
export type CodingWorkbenchScheduleAction = (typeof CODING_WORKBENCH_SCHEDULE_ACTIONS)[number];

/** Why a due wake has not started yet; absent when it is not due or about to start. */
export const CODING_WORKBENCH_SCHEDULE_WAITS = [
  "run-active",
  "workspace-inactive",
  "retrying",
] as const;
export type CodingWorkbenchScheduleWait = (typeof CODING_WORKBENCH_SCHEDULE_WAITS)[number];

const SCHEDULE_ACTIONS: ReadonlySet<string> = new Set(CODING_WORKBENCH_SCHEDULE_ACTIONS);
const SCHEDULE_ID = /^sch_[0-9A-Za-z]{1,64}$/u;
/** A Coding History task id, as a start request's `conversationId` admits it. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface CodingWorkbenchSchedule {
  readonly id: string;
  readonly name?: string | undefined;
  readonly status: CodingWorkbenchScheduleStatus;
  readonly cadence: CodingWorkbenchScheduleCadence;
  /** The cadence as the model wrote it (`30 minutes`, a cron line, a time). */
  readonly cadenceText?: string | undefined;
  /** ISO time of the next wake; absent when it is not active. */
  readonly dueAt?: string | undefined;
  readonly runCount: number;
  readonly wait?: CodingWorkbenchScheduleWait | undefined;
}

export interface CodingWorkbenchSchedulesResponse {
  readonly taskId: string;
  readonly schedules: readonly CodingWorkbenchSchedule[];
}

export interface CodingWorkbenchScheduleControlRequest {
  readonly taskId: string;
}

export interface CodingWorkbenchScheduleControlResponse {
  readonly status: CodingWorkbenchScheduleStatus | "deleted";
}

export function isCodingWorkbenchScheduleId(value: unknown): value is string {
  return typeof value === "string" && SCHEDULE_ID.test(value);
}

export function isCodingWorkbenchScheduleAction(
  value: unknown,
): value is CodingWorkbenchScheduleAction {
  return typeof value === "string" && SCHEDULE_ACTIONS.has(value);
}

function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID.test(value);
}

export function parseCodingWorkbenchScheduleControlRequest(
  value: unknown,
): CodingWorkbenchScheduleControlRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const taskId = (value as { readonly taskId?: unknown }).taskId;
  return keys.length === 1 && keys[0] === "taskId" && isTaskId(taskId) ? { taskId } : undefined;
}

export function isCodingWorkbenchTaskIdForSchedules(value: unknown): value is string {
  return isTaskId(value);
}
