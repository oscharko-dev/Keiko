"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CodingHistoryTask,
  CodingTaskExportFormat,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import {
  CODING_HISTORY_CHANGED,
  exportCodingTask,
  fetchCodingHistory,
  importCodingTask,
  saveCodingTaskExport,
  updateCodingTask,
} from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { repositoryName } from "./CodingWorkbenchRepositorySelector";
import styles from "./CodingHistory.module.css";
import type { WindowRenderContext } from "../../windows/WindowsRegistry";

function historyError(error: unknown): void {
  reportClientDiagnostic(`[keiko] coding history request failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}

function exportError(error: unknown): void {
  reportClientDiagnostic(`[keiko] coding task export failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}

function importError(error: unknown): void {
  reportClientDiagnostic(`[keiko] coding task import failed: ${clientErrorSummary(error)}`, {
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
  // #3628: only the latest read may set the list. An older read that answers after a newer one
  // (a slow mount read overtaken by a change notification's read) would otherwise overwrite it.
  const latestRead = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const read = ++latestRead.current;
    setLoading(true);
    setError(false);
    try {
      const next = await fetchCodingHistory();
      if (read === latestRead.current) setTasks(next);
    } catch (cause) {
      historyError(cause);
      if (read === latestRead.current) setError(true);
    } finally {
      if (read === latestRead.current) setLoading(false);
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
      <HistoryHeader onOpen={onOpen} onNew={onNew} />
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

type ImportState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "partial"; readonly count: number }
  | { readonly kind: "failed"; readonly message: CodingWorkbenchMessageKey };

const IMPORT_FAILURES: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  CODING_HISTORY_IMPORT_INVALID: "codingWorkbench.history.importInvalid",
  CODING_HISTORY_IMPORT_UNSUPPORTED_VERSION: "codingWorkbench.history.importUnsupported",
  CODING_HISTORY_IMPORT_TOO_LARGE: "codingWorkbench.history.importTooLarge",
  CODING_HISTORY_IMPORT_EMPTY: "codingWorkbench.history.importEmpty",
  CODING_HISTORY_IMPORT_NO_WORKSPACE: "codingWorkbench.history.importNoWorkspace",
};

function importFailure(error: unknown): CodingWorkbenchMessageKey {
  const known = error instanceof ApiError ? IMPORT_FAILURES[error.code] : undefined;
  return known ?? "codingWorkbench.history.importError";
}

// The person picks a saved task on their device; the local server stores it as a new task of the
// active workspace, which then opens. Nothing is uploaded anywhere else (#3904 AC4).
function useTaskImport(
  onOpen: (task: CodingHistoryTask) => void,
): readonly [ImportState, (file: File) => Promise<void>] {
  const [state, setState] = useState<ImportState>({ kind: "idle" });
  const run = useCallback(
    async (file: File): Promise<void> => {
      setState({ kind: "busy" });
      try {
        const result = await importCodingTask(file);
        setState(
          result.omittedMessageCount > 0
            ? { kind: "partial", count: result.messageCount }
            : { kind: "idle" },
        );
        onOpen(result.task);
      } catch (cause) {
        importError(cause);
        setState({ kind: "failed", message: importFailure(cause) });
      }
    },
    [onOpen],
  );
  return [state, run];
}

function HistoryHeader({
  onOpen,
  onNew,
}: {
  readonly onOpen: (task: CodingHistoryTask) => void;
  readonly onNew: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const picker = useRef<HTMLInputElement>(null);
  const [state, run] = useTaskImport(onOpen);
  return (
    <>
      <header className={styles.cmpHeader}>
        <h2>{t("codingWorkbench.history.title")}</h2>
        <div className={styles.cmpHeaderActions}>
          <button
            className={styles.cmpSecondary}
            type="button"
            title={t("codingWorkbench.history.importHint")}
            disabled={state.kind === "busy"}
            onClick={() => picker.current?.click()}
          >
            {t("codingWorkbench.history.import")}
          </button>
          <button className={styles.cmpPrimary} type="button" onClick={onNew}>
            {t("codingWorkbench.history.new")}
          </button>
        </div>
        <input
          ref={picker}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label={t("codingWorkbench.history.importFile")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void run(file);
          }}
        />
      </header>
      <ImportStatus state={state} />
    </>
  );
}

function ImportStatus({ state }: { readonly state: ImportState }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (state.kind === "busy") return <output>{t("codingWorkbench.history.importing")}</output>;
  if (state.kind === "partial")
    return <output>{t("codingWorkbench.history.importPartial", { count: state.count })}</output>;
  if (state.kind === "failed") return <p role="alert">{t(state.message)}</p>;
  return null;
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
        className={`${styles.cmpSecondary} ${styles.cmpRefresh}`}
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
          {repositoryName(task.projectPath)} · {task.branch}
        </span>
        <time dateTime={new Date(task.updatedAt).toISOString()}>
          {new Date(task.updatedAt).toLocaleString()}
        </time>
      </button>
      <div className={styles.cmpItemActions}>
        <RenameTask task={task} />
        <ExportTask task={task} />
      </div>
    </li>
  );
}

const EXPORT_FORMATS = [
  { format: "json", label: "codingWorkbench.history.exportJson" },
  { format: "markdown", label: "codingWorkbench.history.exportMarkdown" },
] as const;

// The human asks for the file; it is built by the local server, redacted, and saved through the
// browser's own download path. Nothing is uploaded (#3904).
function ExportTask({ task }: { readonly task: CodingHistoryTask }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const run = async (format: CodingTaskExportFormat): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      saveCodingTaskExport(await exportCodingTask(task.id, format));
    } catch (cause) {
      exportError(cause);
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={styles.cmpExport}>
        {EXPORT_FORMATS.map(({ format, label }) => (
          <button
            key={format}
            className={styles.cmpSecondary}
            type="button"
            title={t("codingWorkbench.history.exportHint")}
            disabled={busy}
            onClick={() => void run(format)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {busy ? <output>{t("codingWorkbench.history.exporting")}</output> : null}
      {error ? <p role="alert">{t("codingWorkbench.history.exportError")}</p> : null}
    </>
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
        <RenameForm
          title={title}
          onChange={setTitle}
          onSave={() => void save()}
          onCancel={() => {
            setEditing(false);
            setError(false);
          }}
        />
      ) : (
        <button
          className={styles.cmpSecondary}
          type="button"
          onClick={() => {
            // #3626: each edit starts from the task's current title, never a discarded draft.
            setTitle(task.title);
            setEditing(true);
          }}
        >
          {t("codingWorkbench.history.rename")}
        </button>
      )}
      {error ? <p role="alert">{t("codingWorkbench.history.error")}</p> : null}
    </>
  );
}

function RenameForm({
  title,
  onChange,
  onSave,
  onCancel,
}: {
  readonly title: string;
  readonly onChange: (title: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      className={styles.cmpRename}
    >
      <input
        className={styles.cmpInput}
        aria-label={t("codingWorkbench.history.taskTitle")}
        value={title}
        maxLength={100}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" disabled={title.trim().length === 0}>
        {t("codingWorkbench.history.save")}
      </button>
      <button type="button" onClick={onCancel}>
        {t("codingWorkbench.history.cancel")}
      </button>
    </form>
  );
}
