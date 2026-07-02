"use client";

// Issue #1387 — CommandsWidget: controlled test/build/run command executor surface. The user picks
// a task from the server-discovered catalog (package.json scripts) and runs it. The synchronous
// POST returns the redacted, byte-capped result (exit code, duration, truncation, failure reason);
// SSE delivers live run status across tabs so an in-flight run can be cancelled. No free-form argv,
// no shell, no WebSocket — the browser only ever names a discovered task id.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import "./TerminalWidget.module.css";

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
  return `${task.kind} · ${task.label}`;
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
          setError(errorFromUnknown(err));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectInput]);

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
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (running || runningRef.current || taskId.length === 0) return;
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
        setError(errorFromUnknown(err));
      } finally {
        runningRef.current = false;
        setRunning(false);
        pendingRequestIdRef.current = null;
        setInFlightRunId(null);
      }
    },
    [projectInput, running, taskId],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    if (inFlightRunId === null) return;
    try {
      await cancelCommandRun(inFlightRunId);
    } catch (err: unknown) {
      setError(errorFromUnknown(err));
    }
  }, [inFlightRunId]);

  return (
    <div className="terminal commands">
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
        <div className="tm-actions">
          <button
            type="submit"
            className="tm-action"
            data-primary="true"
            ref={runBtnRef}
            disabled={running || tasks.length === 0 || taskId.length === 0}
            aria-disabled={running || tasks.length === 0 || taskId.length === 0}
          >
            {running ? "Running…" : "Run task"}
          </button>
          {running ? (
            <button
              type="button"
              className="tm-action"
              disabled={inFlightRunId === null}
              aria-disabled={inFlightRunId === null}
              onClick={() => void onAbort()}
            >
              Cancel
            </button>
          ) : null}
        </div>
        {tasks.length === 0 && projectInput.length > 0 && error === null ? (
          <p className="tm-limits" role="status">
            No runnable test, build, or run tasks were discovered for this project.
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
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {result !== null ? resultSummary(result) : ""}
      </p>

      {result !== null ? (
        <div className="tm-result">
          <div className="tm-badges">
            <span
              className={result.exitCode === 0 ? "tm-badge tm-badge-ok" : "tm-badge tm-badge-fail"}
            >
              exit {String(result.exitCode)}
            </span>
            <span className="tm-badge">{result.durationMs} ms</span>
            <span className="tm-badge">{result.failureReason}</span>
            <span className="tm-badge">run {result.runId}</span>
            <span className="tm-badge">task {result.taskId}</span>
            {result.truncated ? <span className="tm-badge tm-badge-warn">truncated</span> : null}
            {result.timedOut ? <span className="tm-badge tm-badge-warn">timed out</span> : null}
          </div>
          {result.stdout.length > 0 ? <pre className="tm-stdout">{result.stdout}</pre> : null}
          {result.stderr.length > 0 ? <pre className="tm-stderr">{result.stderr}</pre> : null}
        </div>
      ) : null}

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
    </div>
  );
}
