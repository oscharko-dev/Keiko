"use client";

// Issue #1387 — CommandsWidget: controlled test/build/run command executor surface. The user picks
// a task from the server-discovered catalog (package.json scripts) and runs it. The synchronous
// POST returns the redacted, byte-capped result (exit code, duration, truncation, failure reason);
// SSE delivers live run status across tabs so an in-flight run can be cancelled. No free-form argv,
// no shell, no WebSocket — the browser only ever names a discovered task id.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ApiError } from "../../../../../lib/api";
import {
  cancelCommandRun,
  commandEventsUrl,
  createCommandRun,
  fetchCommandCatalog,
} from "../../../../../lib/commands-api";
import type {
  CommandRunnerEvent,
  CommandTask,
  CommandTaskRunResult,
} from "../../../../../lib/types";
import KeikoSelect from "../../KeikoSelect";
import { subscribeSharedEventSource } from "./sharedEventSource";
import styles from "./TerminalWidget.module.css";

interface CommandsWidgetProps {
  readonly projectPath?: string;
}

interface ErrorState {
  readonly code: string;
  readonly message: string;
}

const MAX_EVENT_LOG = 30;
const COMMAND_EVENT_SOURCE_TYPES = [
  "command:run-started",
  "command:run-completed",
  "command:run-failed",
  "command:run-cancelled",
] as const;

function errorFromUnknown(value: unknown): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: "Unexpected error." };
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function taskLabel(task: CommandTask): string {
  const trust = task.trustState === "trusted" ? "" : " · approval required";
  return `${task.kind} · ${task.label}${trust}`;
}

function eventLabel(kind: CommandRunnerEvent["kind"]): string {
  switch (kind) {
    case "run-started":
      return "started";
    case "run-completed":
      return "completed";
    case "run-failed":
      return "failed";
    case "run-cancelled":
      return "cancelled";
  }
}

function eventDetail(event: CommandRunnerEvent): string {
  const p = event.payload;
  if (event.kind === "run-completed" || event.kind === "run-failed") {
    const reason = typeof p.failureReason === "string" ? p.failureReason : "";
    const dur = typeof p.durationMs === "number" ? `${String(p.durationMs)}ms` : "";
    return [reason, dur].filter(Boolean).join(" · ");
  }
  return "";
}

function isOwnEvent(event: CommandRunnerEvent, requestId: string | null): boolean {
  return (
    requestId !== null &&
    typeof event.payload.requestId === "string" &&
    event.payload.requestId === requestId
  );
}

function resultSummary(result: CommandTaskRunResult): string {
  const parts = [`exit ${String(result.exitCode)}`, `${String(result.durationMs)} ms`];
  if (result.truncated) parts.push("output truncated");
  if (result.timedOut) parts.push("timed out");
  parts.push(result.failureReason);
  parts.push(`run ${result.runId}`, `task ${result.taskId}`);
  return `Run finished: ${parts.join(", ")}`;
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the persistent sr-only live
// region must render regardless of `result`, so this stays a plain string helper rather than a
// conditional render component.
function resultAnnouncement(result: CommandTaskRunResult | null): string {
  return result === null ? "" : resultSummary(result);
}

// Extracted from the CommandsWidget body (SonarCloud S3776) — named predicate mirroring the
// original `selectedTask !== undefined && selectedTask.trustState === "trusted"` check.
function isTaskRunnable(task: CommandTask | undefined): boolean {
  return task !== undefined && task.trustState === "trusted";
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the "no runnable tasks"
// notice condition, mirroring the original inline `&&` chain.
function hasNoDiscoverableTasks(
  tasks: readonly CommandTask[],
  projectInput: string,
  error: ErrorState | null,
): boolean {
  return tasks.length === 0 && projectInput.length > 0 && error === null;
}

// Extracted from the CommandsWidget effect (SonarCloud S3776) — loads the discovered task
// catalog for a project path and wires up the tasks/taskId/error state. Returns the effect
// cleanup (or undefined for the empty-path early exit, matching the original bare `return;`).
function loadCommandCatalog(
  projectInput: string,
  setTasks: Dispatch<SetStateAction<readonly CommandTask[]>>,
  setTaskId: Dispatch<SetStateAction<string>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): (() => void) | undefined {
  if (projectInput.length === 0) {
    setTasks([]);
    return undefined;
  }
  let cancelled = false;
  void fetchCommandCatalog(projectInput)
    .then((catalog) => {
      if (cancelled) return;
      setTasks(catalog.tasks);
      setTaskId((current) => (current.length > 0 ? current : (catalog.tasks[0]?.id ?? "")));
    })
    .catch((err: unknown) => {
      if (!cancelled) {
        setTasks([]);
        setError(errorFromUnknown(err));
      }
    });
  return (): void => {
    cancelled = true;
  };
}

// Extracted from the CommandsWidget SSE handler (SonarCloud S3776) — safely parse an incoming
// event frame, mirroring the original try/catch-and-drop-on-failure behavior.
function parseCommandRunnerEvent(raw: string): CommandRunnerEvent | null {
  try {
    return JSON.parse(raw) as CommandRunnerEvent;
  } catch {
    return null;
  }
}

// Extracted from the CommandsWidget SSE handler (SonarCloud S3776) — applies one parsed event
// to the in-flight-run and event-log state. Cancel is only armed for the run that echoes the
// current requestId, so a foreign run-started on the shared channel can never hijack ownership.
function applyCommandEvent(
  event: CommandRunnerEvent,
  runningNow: boolean,
  requestId: string | null,
  setInFlightRunId: Dispatch<SetStateAction<string | null>>,
  setEvents: Dispatch<SetStateAction<readonly CommandRunnerEvent[]>>,
): void {
  if (event.kind === "run-started" && runningNow && isOwnEvent(event, requestId)) {
    setInFlightRunId((current) => current ?? event.runId);
  }
  if (event.kind !== "run-started" && isOwnEvent(event, requestId)) {
    setInFlightRunId((current) => (current === event.runId ? null : current));
  }
  setEvents((current) => [event, ...current].slice(0, MAX_EVENT_LOG));
}

// Extracted from the CommandsWidget focus-return effect (SonarCloud S3776) — named predicate
// mirroring the original inline `&&` chain.
function shouldRestoreRunFocus(wasRunning: boolean, isRunning: boolean): boolean {
  return wasRunning && !isRunning && document.activeElement === document.body;
}

// Extracted from CommandsWidget's onSubmit (SonarCloud S3776) — the try/catch/finally around
// the run POST, taking explicit refs/setters instead of closing over the whole component.
async function executeCommandRun(
  input: Parameters<typeof createCommandRun>[0],
  runningRef: MutableRefObject<boolean>,
  pendingRequestIdRef: MutableRefObject<string | null>,
  setResult: Dispatch<SetStateAction<CommandTaskRunResult | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
  setRunning: Dispatch<SetStateAction<boolean>>,
  setInFlightRunId: Dispatch<SetStateAction<string | null>>,
): Promise<void> {
  try {
    const next = await createCommandRun(input);
    setResult(next);
  } catch (err: unknown) {
    setError(errorFromUnknown(err));
  } finally {
    runningRef.current = false;
    setRunning(false);
    pendingRequestIdRef.current = null;
    setInFlightRunId(null);
  }
}

// Extracted from CommandsWidget's onAbort (SonarCloud S3776) — the try/catch around the cancel
// POST.
async function cancelInFlightRun(
  runId: string,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  try {
    await cancelCommandRun(runId);
  } catch (err: unknown) {
    setError(errorFromUnknown(err));
  }
}

interface CommandsActionsProps {
  readonly running: boolean;
  readonly runnableTaskSelected: boolean;
  readonly runDisabled: boolean;
  readonly inFlightRunId: string | null;
  readonly runBtnRef: MutableRefObject<HTMLButtonElement | null>;
  readonly onAbort: () => void;
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the Run/Cancel action row.
function CommandsActions({
  running,
  runnableTaskSelected,
  runDisabled,
  inFlightRunId,
  runBtnRef,
  onAbort,
}: CommandsActionsProps): ReactNode {
  return (
    <div className="tm-actions">
      {/* GEN-UI-FOCUS-014: aria-disabled instead of HTML disabled while running —
          disabling the focused submit button throws keyboard focus to <body>.
          onSubmit already guards re-entry; the no-selection condition stays
          hard-disabled (pre-interaction state), mirroring TerminalWidget. */}
      <button
        type="submit"
        className="tm-action"
        data-primary="true"
        ref={runBtnRef}
        disabled={!runnableTaskSelected}
        aria-disabled={runDisabled}
      >
        {running ? "Running…" : "Run task"}
      </button>
      {running ? (
        <button
          type="button"
          className="tm-action"
          disabled={inFlightRunId === null}
          aria-disabled={inFlightRunId === null}
          onClick={onAbort}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

interface CommandsFormHintsProps {
  readonly showNoTasksHint: boolean;
  readonly selectedTaskRequiresApproval: boolean;
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the no-tasks / approval-required
// status hints beneath the task selector.
function CommandsFormHints({
  showNoTasksHint,
  selectedTaskRequiresApproval,
}: CommandsFormHintsProps): ReactNode {
  return (
    <>
      {showNoTasksHint ? (
        <p className="tm-limits" role="status">
          No runnable test, build, or run tasks were discovered for this project.
        </p>
      ) : null}
      {selectedTaskRequiresApproval ? (
        <p className="tm-limits" role="status">
          Server-side workspace trust is required before this repository-authored script can run.
        </p>
      ) : null}
    </>
  );
}

interface CommandsErrorBannerProps {
  readonly error: ErrorState | null;
  readonly onDismiss: () => void;
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the dismissible error banner.
function CommandsErrorBanner({ error, onDismiss }: CommandsErrorBannerProps): ReactNode {
  if (error === null) return null;
  return (
    <div className="tm-error" role="alert">
      <span className="tm-error-text">
        {error.message} <span className="err-code mono">({error.code})</span>
      </span>
      <button
        type="button"
        className="tm-error-dismiss"
        aria-label="Dismiss error"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the exit-code badge plus the
// truncated/timed-out warning badges for a finished run.
function CommandsResultBadges({ result }: { readonly result: CommandTaskRunResult }): ReactNode {
  return (
    <div className="tm-badges">
      <span className={result.exitCode === 0 ? "tm-badge tm-badge-ok" : "tm-badge tm-badge-fail"}>
        exit {String(result.exitCode)}
      </span>
      <span className="tm-badge">{result.durationMs} ms</span>
      <span className="tm-badge">{result.failureReason}</span>
      <span className="tm-badge">run {result.runId}</span>
      <span className="tm-badge">task {result.taskId}</span>
      {result.truncated ? <span className="tm-badge tm-badge-warn">truncated</span> : null}
      {result.timedOut ? <span className="tm-badge tm-badge-warn">timed out</span> : null}
    </div>
  );
}

interface CommandsOutputStreamProps {
  readonly label: string;
  readonly className: string;
  readonly content: string;
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — a focusable named scroll region
// for stdout/stderr (WCAG 2.1.1, GEN-UI-KEYBOARD-005), shared by both streams.
function CommandsOutputStream({ label, className, content }: CommandsOutputStreamProps): ReactNode {
  if (content.length === 0) return null;
  return (
    <pre
      className={className}
      role="region"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
      tabIndex={0}
    >
      {content}
    </pre>
  );
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the finished-run result panel.
function CommandsResultPanel({
  result,
}: {
  readonly result: CommandTaskRunResult | null;
}): ReactNode {
  if (result === null) return null;
  return (
    <div className="tm-result">
      <CommandsResultBadges result={result} />
      {/* GEN-UI-KEYBOARD-005 — overflow:auto scroll containers exposed as focusable
          named regions so keyboard-only users can scroll them (WCAG 2.1.1). */}
      <CommandsOutputStream label="Task stdout" className="tm-stdout" content={result.stdout} />
      <CommandsOutputStream label="Task stderr" className="tm-stderr" content={result.stderr} />
    </div>
  );
}

// Extracted from the CommandsWidget render (SonarCloud S3776) — the recent run-events log.
function CommandsEventLog({
  events,
}: {
  readonly events: readonly CommandRunnerEvent[];
}): ReactNode {
  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label="Recent command run events"
    >
      <ul className="tm-events">
        {events.map((event, idx) => (
          <li key={`${event.runId}-${String(idx)}-${event.kind}`} className="tm-event">
            <span className="tm-event-kind">{eventLabel(event.kind)}</span>
            <span className="tm-event-detail">{eventDetail(event)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommandsWidget(props: CommandsWidgetProps): ReactNode {
  const [projectInput, setProjectInput] = useState<string>(props.projectPath ?? "");
  useEffect(() => {
    setProjectInput(props.projectPath ?? "");
  }, [props.projectPath]);

  const [tasks, setTasks] = useState<readonly CommandTask[]>([]);
  const [taskId, setTaskId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [inFlightRunId, setInFlightRunId] = useState<string | null>(null);
  const [result, setResult] = useState<CommandTaskRunResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [events, setEvents] = useState<readonly CommandRunnerEvent[]>([]);
  const runningRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const runBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevRunningRef = useRef(false);
  const selectedTask = tasks.find((task) => task.id === taskId);
  const runnableTaskSelected = isTaskRunnable(selectedTask);
  const selectedTaskRequiresApproval = selectedTask?.trustState === "approval-required";
  const runDisabled = running || !runnableTaskSelected;

  // Load the discovered task catalog whenever the project path changes. A failure surfaces as an
  // error; an empty catalog is a valid "no runnable scripts" state.
  useEffect(() => loadCommandCatalog(projectInput, setTasks, setTaskId, setError), [projectInput]);

  // Subscribe to the global command event channel. Cancel is only armed for the run that echoes the
  // current requestId, so a foreign run-started on the shared channel can never hijack ownership.
  useEffect(() => {
    if (!running) return;
    const onMessage = (ev: MessageEvent<string>): void => {
      const parsed = parseCommandRunnerEvent(ev.data);
      if (parsed === null) return;
      applyCommandEvent(
        parsed,
        runningRef.current,
        pendingRequestIdRef.current,
        setInFlightRunId,
        setEvents,
      );
    };
    return subscribeSharedEventSource(commandEventsUrl(), COMMAND_EVENT_SOURCE_TYPES, onMessage);
  }, [running]);

  // Return focus to Run when the Cancel button unmounts at run end so keyboard users keep their place.
  useEffect(() => {
    if (shouldRestoreRunFocus(prevRunningRef.current, running)) {
      runBtnRef.current?.focus();
    }
    prevRunningRef.current = running;
  }, [running]);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (running || runningRef.current || !runnableTaskSelected) return;
      setError(null);
      setResult(null);
      setInFlightRunId(null);
      const requestId = createRequestId();
      pendingRequestIdRef.current = requestId;
      runningRef.current = true;
      setRunning(true);
      await executeCommandRun(
        { projectId: projectInput, taskId, requestId },
        runningRef,
        pendingRequestIdRef,
        setResult,
        setError,
        setRunning,
        setInFlightRunId,
      );
    },
    [projectInput, runnableTaskSelected, running, taskId],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    if (inFlightRunId === null) return;
    await cancelInFlightRun(inFlightRunId, setError);
  }, [inFlightRunId]);

  return (
    <div className={`terminal commands ${styles.lazyWidgetScope}`}>
      <form className="tm-form" onSubmit={(e) => void onSubmit(e)}>
        <label className="tm-field">
          <span>Project path</span>
          <input
            type="text"
            value={projectInput}
            onChange={(e) => setProjectInput(e.target.value)}
            placeholder="/absolute/path/to/project"
            required
          />
        </label>
        <div className="tm-field">
          <span>Task</span>
          <KeikoSelect
            value={taskId}
            ariaLabel="Task"
            disabled={tasks.length === 0}
            menuTitle="Discovered tasks"
            mono
            sections={[
              {
                options: tasks.map((task) => ({ value: task.id, label: taskLabel(task) })),
              },
            ]}
            onValueChange={setTaskId}
          />
        </div>
        <CommandsActions
          running={running}
          runnableTaskSelected={runnableTaskSelected}
          runDisabled={runDisabled}
          inFlightRunId={inFlightRunId}
          runBtnRef={runBtnRef}
          onAbort={() => void onAbort()}
        />
        <CommandsFormHints
          showNoTasksHint={hasNoDiscoverableTasks(tasks, projectInput, error)}
          selectedTaskRequiresApproval={selectedTaskRequiresApproval}
        />
      </form>

      <CommandsErrorBanner error={error} onDismiss={() => setError(null)} />

      <p className="sr-only" role="status" aria-live="polite">
        {resultAnnouncement(result)}
      </p>

      <CommandsResultPanel result={result} />

      <CommandsEventLog events={events} />
    </div>
  );
}
