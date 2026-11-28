"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CodingWorkbenchSchedule,
  CodingWorkbenchScheduleAction,
} from "@oscharko-dev/keiko-contracts";
import { controlCodingSchedule, fetchCodingSchedules } from "@/lib/coding-schedules-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingHistory.module.css";

/**
 * A scheduled wake is started by the server, not by this window, so no run of this window changes
 * when it fires (U-57). The list is therefore read again once the next active wake is due, after
 * this grace (longer than the server's 15 s look at its schedules), and again while that wake stays
 * overdue, at most this many times until the list changes.
 */
export const SCHEDULE_REREAD_GRACE_MS = 16_000;
export const SCHEDULE_REREAD_MAX_ATTEMPTS = 20;
export const SCHEDULE_REREAD_MAX_ARM_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The scheduled continuations of the shown task (#4271, ADR-0137 D10): what the task's model
 * scheduled, when Keiko wakes the task next, and Pause, Resume and Delete. Nothing is shown when
 * the task holds no schedule. While the task's run is active its schedules belong to the run, so
 * the actions wait until it settles; the list is read again then.
 */
export function CodingWorkbenchSchedules({
  taskId,
  runActive,
}: {
  readonly taskId: string | undefined;
  readonly runActive: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const { schedules, failed, busy, act } = useTaskSchedules(taskId, runActive);
  if (taskId === undefined || schedules.length === 0) return null;
  return (
    <section className={styles.cmpSchedules} aria-label={t("codingWorkbench.schedules.title")}>
      <strong>{t("codingWorkbench.schedules.title")}</strong>
      <ul>
        {schedules.map((schedule) => (
          <li key={schedule.id}>
            <span>{scheduleSummary(schedule, t)}</span>
            <ScheduleActions
              schedule={schedule}
              disabled={runActive || busy}
              onAct={(action): void => {
                void act(schedule.id, action);
              }}
            />
          </li>
        ))}
      </ul>
      {failed ? <p role="alert">{t("codingWorkbench.schedules.error")}</p> : null}
    </section>
  );
}

function useTaskSchedules(
  taskId: string | undefined,
  runActive: boolean,
): {
  readonly schedules: readonly CodingWorkbenchSchedule[];
  readonly failed: boolean;
  readonly busy: boolean;
  readonly act: (scheduleId: string, action: CodingWorkbenchScheduleAction) => Promise<void>;
} {
  const [schedules, setSchedules] = useState<readonly CodingWorkbenchSchedule[]>([]);
  const [listFailed, setListFailed] = useState(false);
  // The task whose last pause, resume or delete failed: the list read that follows every change
  // must not clear that alert, and another task never shows it.
  const [actionFailedFor, setActionFailedFor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useScheduleList(taskId, `${String(runActive)}:${String(revision)}`, setSchedules, setListFailed);
  const reread = useCallback((): void => {
    setRevision((current) => current + 1);
  }, []);
  useWakeReread(taskId === undefined ? NO_SCHEDULES : schedules, reread);
  const act = useCallback(
    async (scheduleId: string, action: CodingWorkbenchScheduleAction): Promise<void> => {
      if (taskId === undefined) return;
      setBusy(true);
      try {
        await controlCodingSchedule(taskId, scheduleId, action);
        setActionFailedFor(undefined);
      } catch (error) {
        setActionFailedFor(taskId);
        reportScheduleFailure(action, error);
      } finally {
        setBusy(false);
        setRevision((current) => current + 1);
      }
    },
    [taskId],
  );
  const failed = listFailed || (taskId !== undefined && actionFailedFor === taskId);
  return { schedules, failed, busy, act };
}

// Read again for another task, when its run starts or settles, and after every change.
function useScheduleList(
  taskId: string | undefined,
  refresh: string,
  setSchedules: (schedules: readonly CodingWorkbenchSchedule[]) => void,
  setFailed: (failed: boolean) => void,
): void {
  useEffect(() => {
    if (taskId === undefined) {
      setSchedules([]);
      return;
    }
    const abort = new AbortController();
    fetchCodingSchedules(taskId, abort.signal).then(
      (result) => {
        setSchedules(result.schedules);
        setFailed(false);
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setFailed(true);
        reportScheduleFailure("list", error);
      },
    );
    return (): void => {
      abort.abort();
    };
  }, [taskId, refresh, setSchedules, setFailed]);
}

const NO_SCHEDULES: readonly CodingWorkbenchSchedule[] = [];

function nextWakeAt(schedules: readonly CodingWorkbenchSchedule[]): number | undefined {
  const due = schedules.flatMap((schedule) =>
    schedule.status === "active" && schedule.dueAt !== undefined
      ? [Date.parse(schedule.dueAt)]
      : [],
  );
  const finite = due.filter(Number.isFinite);
  return finite.length === 0 ? undefined : Math.min(...finite);
}

// Read the list again when the next wake is due and when the window is shown again: either may be
// the first moment this window can learn that a wake the server started has run.
function useWakeReread(schedules: readonly CodingWorkbenchSchedule[], reread: () => void): void {
  const attempts = useRef(0);
  const seen = useRef("");
  const signature = schedules
    .map((one) => `${one.id}:${one.status}:${String(one.runCount)}:${one.dueAt ?? ""}`)
    .join("|");
  const wakeAt = nextWakeAt(schedules);
  useEffect(() => {
    if (seen.current !== signature) {
      seen.current = signature;
      attempts.current = 0;
    }
    if (wakeAt === undefined || attempts.current >= SCHEDULE_REREAD_MAX_ATTEMPTS) return;
    const untilWake = Math.max(wakeAt - Date.now(), 0);
    // A wake more than a day away arms nothing (the focus and visibility reads remain), and no
    // delay exceeds what a timer holds: a larger one fires at once and would burn every attempt.
    if (untilWake > SCHEDULE_REREAD_MAX_ARM_MS) return;
    const timer = window.setTimeout(
      () => {
        attempts.current += 1;
        reread();
      },
      Math.min(untilWake + SCHEDULE_REREAD_GRACE_MS, MAX_TIMER_DELAY_MS),
    );
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [schedules, signature, wakeAt, reread]);
  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState === "visible") reread();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return (): void => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [reread]);
}

function reportScheduleFailure(operation: string, error: unknown): void {
  reportClientDiagnostic(
    `[keiko] coding task schedules ${operation} failed: ${clientErrorSummary(error)}`,
    { correlationId: correlationIdOf(error) },
  );
}

function ScheduleActions({
  schedule,
  disabled,
  onAct,
}: {
  readonly schedule: CodingWorkbenchSchedule;
  readonly disabled: boolean;
  readonly onAct: (action: CodingWorkbenchScheduleAction) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  // A removed schedule belongs to a session the runtime no longer opens: nothing to change.
  if (schedule.status === "removed") return null;
  const actions: readonly CodingWorkbenchScheduleAction[] = [
    ...(schedule.status === "active" ? (["pause"] as const) : []),
    ...(schedule.status === "paused" ? (["resume"] as const) : []),
    "delete",
  ];
  return (
    <span className={styles.cmpScheduleActions}>
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={styles.cmpMessageFork}
          disabled={disabled}
          onClick={(): void => {
            onAct(action);
          }}
        >
          {t(`codingWorkbench.schedules.${action}`)}
        </button>
      ))}
    </span>
  );
}

function scheduleSummary(schedule: CodingWorkbenchSchedule, t: CodingWorkbenchTranslate): string {
  const label = schedule.name ?? schedule.cadenceText ?? t("codingWorkbench.schedules.unnamed");
  if (schedule.status === "paused") return t("codingWorkbench.schedules.paused", { label });
  if (schedule.status === "done") return t("codingWorkbench.schedules.done", { label });
  if (schedule.status === "removed") return t("codingWorkbench.schedules.removed", { label });
  if (schedule.wait !== undefined)
    return t(`codingWorkbench.schedules.wait.${schedule.wait}`, { label });
  if (schedule.dueAt === undefined) return label;
  return t("codingWorkbench.schedules.next", {
    label,
    time: new Date(schedule.dueAt).toLocaleString(),
  });
}
