"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  CodingWorkbenchSchedule,
  CodingWorkbenchScheduleAction,
} from "@oscharko-dev/keiko-contracts";
import { controlCodingSchedule, fetchCodingSchedules } from "@/lib/coding-schedules-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { useCodingWorkbenchTranslate, type CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingHistory.module.css";

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
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useScheduleList(taskId, `${String(runActive)}:${String(revision)}`, setSchedules, setFailed);
  const act = useCallback(
    async (scheduleId: string, action: CodingWorkbenchScheduleAction): Promise<void> => {
      if (taskId === undefined) return;
      setBusy(true);
      try {
        await controlCodingSchedule(taskId, scheduleId, action);
        setFailed(false);
      } catch (error) {
        setFailed(true);
        reportScheduleFailure(action, error);
      } finally {
        setBusy(false);
        setRevision((current) => current + 1);
      }
    },
    [taskId],
  );
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
  if (schedule.wait !== undefined)
    return t(`codingWorkbench.schedules.wait.${schedule.wait}`, { label });
  if (schedule.dueAt === undefined) return label;
  return t("codingWorkbench.schedules.next", {
    label,
    time: new Date(schedule.dueAt).toLocaleString(),
  });
}
