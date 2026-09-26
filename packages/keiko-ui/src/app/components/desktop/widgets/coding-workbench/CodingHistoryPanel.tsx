"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CodingHistoryTask } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CODING_HISTORY_CHANGED,
  fetchCodingHistory,
  updateCodingTask,
} from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingHistory.module.css";
import type { WindowRenderContext } from "../../windows/WindowsRegistry";

function historyError(error: unknown): void {
  reportClientDiagnostic(`[keiko] coding history request failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}

function useHistoryList(): {
  tasks: readonly CodingHistoryTask[];
  error: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<readonly CodingHistoryTask[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try {
      setTasks(await fetchCodingHistory());
    } catch (cause) {
      historyError(cause);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const reload = (): void => {
      void refresh();
    };
    window.addEventListener(CODING_HISTORY_CHANGED, reload);
    return (): void => window.removeEventListener(CODING_HISTORY_CHANGED, reload);
  }, [refresh]);
  return { tasks, error, loading, refresh };
}

// Keep task navigation in the history chunk; the desktop shell needs only its window host.
export function CodingHistoryWindowHost({
  context,
}: {
  readonly context: Pick<WindowRenderContext, "openWindow">;
}): ReactNode {
  return (
    <CodingHistoryPanel
      onOpen={(task) =>
        context.openWindow("coding", {
          repositoryPath: task.projectPath,
          historySelection: task.id,
        })
      }
      onNew={() => context.openWindow("coding", { historySelection: `new:${Date.now()}` })}
    />
  );
}

export function CodingHistoryPanel({
  onOpen,
  onNew,
}: {
  readonly onOpen: (task: CodingHistoryTask) => void;
  readonly onNew: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const history = useHistoryList();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "completed">("active");
  const visible = history.tasks.filter(
    (task) =>
      task.status === status &&
      `${task.title} ${task.projectPath} ${task.branch}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section className={styles.cmpPanel} aria-label={t("codingWorkbench.history.title")}>
      <header className={styles.cmpHeader}>
        <h2>{t("codingWorkbench.history.title")}</h2>
        <button className={styles.cmpPrimary} type="button" onClick={onNew}>
          {t("codingWorkbench.history.new")}
        </button>
      </header>
      <input
        className={styles.cmpInput}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t("codingWorkbench.history.search")}
        placeholder={t("codingWorkbench.history.search")}
      />
      <HistoryFilters
        history={history}
        status={status}
        setStatus={setStatus}
        empty={visible.length === 0}
      />
      <ul className={styles.cmpList}>
        {visible.map((task) => (
          <HistoryItem key={task.id} task={task} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function HistoryFilters({
  history,
  status,
  setStatus,
  empty,
}: {
  readonly history: ReturnType<typeof useHistoryList>;
  readonly status: "active" | "completed";
  readonly setStatus: (status: "active" | "completed") => void;
  readonly empty: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      <div className={styles.cmpTabs} aria-label={t("codingWorkbench.history.filter")}>
        {(["active", "completed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            {t(`codingWorkbench.history.${value}`)}{" "}
            {history.tasks.filter((task) => task.status === value).length}
          </button>
        ))}
      </div>
      {history.error ? <p role="alert">{t("codingWorkbench.history.error")}</p> : null}
      {history.loading ? <output>{t("codingWorkbench.history.loading")}</output> : null}
      <button
        className={styles.cmpSecondary}
        type="button"
        disabled={history.loading}
        onClick={() => void history.refresh()}
      >
        {t("codingWorkbench.history.refresh")}
      </button>
      {!history.error && !history.loading && empty ? (
        <p className={styles.cmpEmpty}>{t("codingWorkbench.history.empty")}</p>
      ) : null}
    </>
  );
}

function HistoryItem({
  task,
  onOpen,
}: {
  readonly task: CodingHistoryTask;
  readonly onOpen: (task: CodingHistoryTask) => void;
}): ReactNode {
  return (
    <li className={styles.cmpItem}>
      <button className={styles.cmpOpen} type="button" onClick={() => onOpen(task)}>
        <strong>{task.title}</strong>
        <span>
          {task.projectPath.split("/").at(-1)} · {task.branch}
        </span>
        <time dateTime={new Date(task.updatedAt).toISOString()}>
          {new Date(task.updatedAt).toLocaleString()}
        </time>
      </button>
      <RenameTask task={task} />
    </li>
  );
}

function RenameTask({ task }: { readonly task: CodingHistoryTask }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState(false);
  const save = async (): Promise<void> => {
    try {
      await updateCodingTask(task.id, { title: title.trim() });
      setEditing(false);
      setError(false);
    } catch (cause) {
      historyError(cause);
      setError(true);
    }
  };
  return (
    <>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className={styles.cmpRename}
        >
          <input
            className={styles.cmpInput}
            aria-label={t("codingWorkbench.history.taskTitle")}
            value={title}
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit" disabled={title.trim().length === 0}>
            {t("codingWorkbench.history.save")}
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            {t("codingWorkbench.history.cancel")}
          </button>
        </form>
      ) : (
        <button className={styles.cmpSecondary} type="button" onClick={() => setEditing(true)}>
          {t("codingWorkbench.history.rename")}
        </button>
      )}
      {error ? <p role="alert">{t("codingWorkbench.history.error")}</p> : null}
    </>
  );
}
