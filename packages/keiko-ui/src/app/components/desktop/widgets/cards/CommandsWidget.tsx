"use client";

// Issue #1387 — CommandsWidget: controlled test/build/run command executor surface. The user picks
// a task from the server-discovered catalog (package.json scripts) and runs it. The synchronous
// POST returns the redacted, byte-capped result (exit code, duration, truncation, failure reason);
// SSE delivers live run status across tabs so an in-flight run can be cancelled. No free-form argv,
// no shell, no WebSocket — the browser only ever names a discovered task id.

import { useCallback, useEffect, useRef, useState, type ReactNode, type SubmitEvent } from "react";
import { ApiError } from "../../../../../lib/api";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "../../../../../lib/optional-widget-i18n";
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
import { secureRandomId } from "../../../../../lib/secure-random";
import KeikoSelect from "../../KeikoSelect";
import { subscribeSharedEventSource } from "./sharedEventSource";
import styles from "./TerminalWidget.module.css";
import { useWorkspaceTrust } from "../../workspace-trust/useWorkspaceTrust";
import { WorkspaceTrustBanner } from "../../workspace-trust/WorkspaceTrustSurfaces";

interface CommandsWidgetProps {
  readonly projectPath?: string;
  readonly onOpenWorkspaceTrust?: (() => void) | undefined;
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

function errorFromUnknown(value: unknown, t: OptionalWidgetTranslate): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: t("commandsWidget.error.unexpected") };
}

function createRequestId(): string {
  return secureRandomId("command");
}

function taskLabel(task: CommandTask, t: OptionalWidgetTranslate): string {
  const trust =
    task.trustState === "trusted" ? "" : t("commandsWidget.task.approvalRequiredSuffix");
  return `${task.kind} · ${task.label}${trust}`;
}

function eventLabel(kind: CommandRunnerEvent["kind"], t: OptionalWidgetTranslate): string {
  switch (kind) {
    case "run-started":
      return t("commandsWidget.event.started");
    case "run-completed":
      return t("commandsWidget.event.completed");
    case "run-failed":
      return t("commandsWidget.event.failed");
    case "run-cancelled":
      return t("commandsWidget.event.cancelled");
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

function resultSummary(result: CommandTaskRunResult, t: OptionalWidgetTranslate): string {
  const parts = [
    t("commandsWidget.result.exit", { code: String(result.exitCode) }),
    t("commandsWidget.result.duration", { duration: result.durationMs }),
  ];
  if (result.truncated) parts.push(t("commandsWidget.result.outputTruncated"));
  if (result.timedOut) parts.push(t("commandsWidget.result.timedOut"));
  parts.push(
    result.failureReason,
    t("commandsWidget.result.run", { id: result.runId }),
    t("commandsWidget.result.task", { id: result.taskId }),
  );
  return t("commandsWidget.result.finished", { details: parts.join(", ") });
}

function CommandResult({
  result,
  t,
}: {
  readonly result: CommandTaskRunResult | null;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {result !== null ? resultSummary(result, t) : ""}
      </p>
      {result !== null ? (
        <div className="tm-result">
          <div className="tm-badges">
            <span
              className={result.exitCode === 0 ? "tm-badge tm-badge-ok" : "tm-badge tm-badge-fail"}
            >
              {t("commandsWidget.result.exit", { code: String(result.exitCode) })}
            </span>
            <span className="tm-badge">{result.durationMs} ms</span>
            <span className="tm-badge">{result.failureReason}</span>
            <span className="tm-badge">{t("commandsWidget.result.run", { id: result.runId })}</span>
            <span className="tm-badge">
              {t("commandsWidget.result.task", { id: result.taskId })}
            </span>
            {result.truncated ? (
              <span className="tm-badge tm-badge-warn">{t("commandsWidget.result.truncated")}</span>
            ) : null}
            {result.timedOut ? (
              <span className="tm-badge tm-badge-warn">{t("commandsWidget.result.timedOut")}</span>
            ) : null}
          </div>
          {result.stdout.length > 0 ? (
            <pre
              className="tm-stdout"
              role="region"
              aria-label={t("commandsWidget.result.stdoutAriaLabel")}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
              tabIndex={0}
            >
              {result.stdout}
            </pre>
          ) : null}
          {result.stderr.length > 0 ? (
            <pre
              className="tm-stderr"
              role="region"
              aria-label={t("commandsWidget.result.stderrAriaLabel")}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
              tabIndex={0}
            >
              {result.stderr}
            </pre>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function CommandsWidget(props: CommandsWidgetProps): ReactNode {
  const t = useOptionalWidgetTranslate();
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
  const trust = useWorkspaceTrust(projectInput.length > 0 ? projectInput : undefined);
  const runningRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const runBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevRunningRef = useRef(false);
  const selectedTask = tasks.find((task) => task.id === taskId);
  const runnableTaskSelected = selectedTask?.trustState === "trusted";
  const selectedTaskRequiresApproval = selectedTask?.trustState === "approval-required";
  const runDisabled = running || !runnableTaskSelected;

  // Load the discovered task catalog whenever the project path changes. A failure surfaces as an
  // error; an empty catalog is a valid "no runnable scripts" state.
  useEffect(() => {
    if (projectInput.length === 0) {
      setTasks([]);
      return;
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
          setError(errorFromUnknown(err, t));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectInput, t, trust.status?.revision, trust.status?.trust]);

  // Subscribe to the global command event channel. Cancel is only armed for the run that echoes the
  // current requestId, so a foreign run-started on the shared channel can never hijack ownership.
  useEffect(() => {
    if (!running) return;
    const onMessage = (ev: MessageEvent<string>): void => {
      let parsed: CommandRunnerEvent;
      try {
        parsed = JSON.parse(ev.data) as CommandRunnerEvent;
      } catch {
        return;
      }
      if (
        parsed.kind === "run-started" &&
        runningRef.current &&
        isOwnEvent(parsed, pendingRequestIdRef.current)
      ) {
        setInFlightRunId((current) => current ?? parsed.runId);
      }
      if (parsed.kind !== "run-started" && isOwnEvent(parsed, pendingRequestIdRef.current)) {
        setInFlightRunId((current) => (current === parsed.runId ? null : current));
      }
      setEvents((current) => [parsed, ...current].slice(0, MAX_EVENT_LOG));
    };
    return subscribeSharedEventSource(commandEventsUrl(), COMMAND_EVENT_SOURCE_TYPES, onMessage);
  }, [running]);

  // Return focus to Run when the Cancel button unmounts at run end so keyboard users keep their place.
  useEffect(() => {
    if (prevRunningRef.current && !running && document.activeElement === document.body) {
      runBtnRef.current?.focus();
    }
    prevRunningRef.current = running;
  }, [running]);

  const onSubmit = useCallback(
    async (e: SubmitEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (running || runningRef.current || !runnableTaskSelected) return;
      setError(null);
      setResult(null);
      setInFlightRunId(null);
      const requestId = createRequestId();
      pendingRequestIdRef.current = requestId;
      runningRef.current = true;
      setRunning(true);
      try {
        const next = await createCommandRun({ projectId: projectInput, taskId, requestId });
        setResult(next);
      } catch (err: unknown) {
        setError(errorFromUnknown(err, t));
      } finally {
        runningRef.current = false;
        setRunning(false);
        pendingRequestIdRef.current = null;
        setInFlightRunId(null);
      }
    },
    [projectInput, runnableTaskSelected, running, taskId, t],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    if (inFlightRunId === null) return;
    try {
      await cancelCommandRun(inFlightRunId);
    } catch (err: unknown) {
      setError(errorFromUnknown(err, t));
    }
  }, [inFlightRunId, t]);

  return (
    <div className={`terminal commands ${styles.lazyWidgetScope}`}>
      {projectInput.length > 0 ? (
        <WorkspaceTrustBanner
          status={trust.status}
          issue={trust.issue}
          surface="commands"
          onManage={props.onOpenWorkspaceTrust}
        />
      ) : null}
      <form className="tm-form" onSubmit={(e) => void onSubmit(e)}>
        <label className="tm-field">
          <span>{t("commandsWidget.field.projectPath")}</span>
          <input
            type="text"
            value={projectInput}
            onChange={(e) => setProjectInput(e.target.value)}
            placeholder={t("commandsWidget.field.projectPathPlaceholder")}
            required
          />
        </label>
        <div className="tm-field">
          <span>{t("commandsWidget.field.task")}</span>
          <KeikoSelect
            value={taskId}
            ariaLabel={t("commandsWidget.field.task")}
            disabled={tasks.length === 0}
            menuTitle={t("commandsWidget.field.discoveredTasks")}
            mono
            sections={[
              {
                options: tasks.map((task) => ({ value: task.id, label: taskLabel(task, t) })),
              },
            ]}
            onValueChange={setTaskId}
          />
        </div>
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
            {running ? t("commandsWidget.action.running") : t("commandsWidget.action.run")}
          </button>
          {running ? (
            <button
              type="button"
              className="tm-action"
              disabled={inFlightRunId === null}
              aria-disabled={inFlightRunId === null}
              onClick={() => void onAbort()}
            >
              {t("commandsWidget.action.cancel")}
            </button>
          ) : null}
        </div>
        {tasks.length === 0 && projectInput.length > 0 && error === null ? (
          <p className="tm-limits" role="status">
            {t("commandsWidget.empty.noRunnableTasks")}
          </p>
        ) : null}
        {selectedTaskRequiresApproval ? (
          <p className="tm-limits" role="status">
            {t("commandsWidget.trust.required")}
          </p>
        ) : null}
      </form>

      {error !== null ? (
        <div className="tm-error" role="alert">
          <span className="tm-error-text">
            {error.message} <span className="err-code mono">({error.code})</span>
          </span>
          <button
            type="button"
            className="tm-error-dismiss"
            aria-label={t("commandsWidget.error.dismiss")}
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      ) : null}

      <CommandResult result={result} t={t} />

      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        aria-label={t("commandsWidget.log.ariaLabel")}
      >
        <ul className="tm-events">
          {events.map((event, idx) => (
            <li key={`${event.runId}-${String(idx)}-${event.kind}`} className="tm-event">
              <span className="tm-event-kind">{eventLabel(event.kind, t)}</span>
              <span className="tm-event-detail">{eventDetail(event)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
