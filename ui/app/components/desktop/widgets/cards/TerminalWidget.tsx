"use client";

// ADR-0018 D11 — TerminalWidget: bounded permitted-command execution surface. The user picks a
// command from the policy allowlist, supplies args, picks a cwd inside the project, and runs.
// The synchronous POST returns redacted stdout/stderr; SSE delivers live status of in-flight
// executions across other tabs. No xterm, no WebSocket, no shell.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError } from "../../../../../lib/api";
import {
  abortTerminalExecution,
  createTerminalExecution,
  fetchTerminalPolicy,
  terminalEventsUrl,
} from "../../../../../lib/terminal-api";
import type {
  TerminalEventEnvelope,
  TerminalExecutionResult,
  TerminalPolicySummary,
} from "../../../../../lib/types";

interface TerminalWidgetProps {
  readonly projectPath?: string;
  readonly cwd?: string;
}

interface ErrorState {
  readonly code: string;
  readonly message: string;
}

const MAX_EVENT_LOG = 30;

function errorFromUnknown(value: unknown): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: "Unexpected error." };
}

function parseArgs(input: string): readonly string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  // Single-pass split: whitespace-separated tokens. We intentionally do NOT parse quotes; the
  // BFF re-validates against the allowlist regardless of how the args are split, and the
  // permitted commands here all accept the bare-token convention.
  return trimmed.split(/\s+/);
}

function eventLabel(kind: TerminalEventEnvelope["kind"]): string {
  switch (kind) {
    case "execution-started":
      return "started";
    case "execution-completed":
      return "completed";
    case "execution-failed":
      return "failed";
    case "execution-cancelled":
      return "cancelled";
  }
}

function eventDetail(event: TerminalEventEnvelope): string {
  const p = event.payload;
  if (event.kind === "execution-completed") {
    const exit =
      typeof p.exitCode === "number" || p.exitCode === null ? `exit ${String(p.exitCode)}` : "";
    const dur = typeof p.durationMs === "number" ? `${String(p.durationMs)}ms` : "";
    return [exit, dur].filter(Boolean).join(" · ");
  }
  if (event.kind === "execution-failed") {
    return typeof p.code === "string" ? p.code : "";
  }
  if (event.kind === "execution-started") {
    return typeof p.command === "string" ? p.command : "";
  }
  return "";
}

export function TerminalWidget(props: TerminalWidgetProps): ReactNode {
  const [policy, setPolicy] = useState<TerminalPolicySummary | null>(null);
  const [command, setCommand] = useState<string>("");
  const [argsInput, setArgsInput] = useState<string>("");
  const [cwdInput, setCwdInput] = useState<string>(props.cwd ?? "");
  const [projectInput, setProjectInput] = useState<string>(props.projectPath ?? "");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TerminalExecutionResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [events, setEvents] = useState<readonly TerminalEventEnvelope[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchTerminalPolicy()
      .then((p) => {
        if (cancelled) return;
        setPolicy(p);
        setCommand((current) => (current.length > 0 ? current : (p.commands[0] ?? "")));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorFromUnknown(err));
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const es = new EventSource(terminalEventsUrl());
    eventSourceRef.current = es;
    const onMessage = (ev: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(ev.data) as TerminalEventEnvelope;
        setEvents((current) => {
          const next = [parsed, ...current];
          return next.length > MAX_EVENT_LOG ? next.slice(0, MAX_EVENT_LOG) : next;
        });
      } catch {
        // Ignore unparsable frames; the BFF never emits malformed JSON.
      }
    };
    for (const kind of [
      "execution-started",
      "execution-completed",
      "execution-failed",
      "execution-cancelled",
    ] as const) {
      es.addEventListener(`terminal:${kind}`, onMessage as EventListener);
    }
    return (): void => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (running) return;
      setError(null);
      setResult(null);
      setRunning(true);
      try {
        const next = await createTerminalExecution({
          projectId: projectInput,
          command,
          args: parseArgs(argsInput),
          ...(cwdInput.length > 0 ? { cwd: cwdInput } : {}),
        });
        setResult(next);
      } catch (err: unknown) {
        setError(errorFromUnknown(err));
      } finally {
        setRunning(false);
      }
    },
    [argsInput, command, cwdInput, projectInput, running],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    const id = result?.executionId;
    if (id === undefined) return;
    try {
      await abortTerminalExecution(id);
    } catch (err: unknown) {
      setError(errorFromUnknown(err));
    }
  }, [result]);

  const limits = useMemo(() => policy?.limits ?? null, [policy]);

  return (
    <div className="terminal">
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
        <label className="tm-field">
          <span>Command</span>
          <select
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            disabled={policy === null}
            required
          >
            {policy?.commands.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="tm-field">
          <span>Args (space-separated)</span>
          <input
            type="text"
            value={argsInput}
            onChange={(e) => setArgsInput(e.target.value)}
            placeholder="e.g. -la src"
          />
        </label>
        <label className="tm-field">
          <span>Working directory (optional)</span>
          <input
            type="text"
            value={cwdInput}
            onChange={(e) => setCwdInput(e.target.value)}
            placeholder="(project root)"
          />
        </label>
        <div className="tm-actions">
          <button type="submit" className="tm-action" disabled={running || policy === null}>
            {running ? "Running…" : "Run"}
          </button>
          {result !== null && running ? (
            <button type="button" className="tm-action" onClick={() => void onAbort()}>
              Cancel
            </button>
          ) : null}
        </div>
        {limits !== null ? (
          <p className="tm-limits">
            Limits: {limits.maxOutputBytes} bytes output, {limits.defaultTimeoutMs} ms timeout
          </p>
        ) : null}
      </form>

      {error !== null ? (
        <div className="tm-error" role="alert">
          <span className="tm-error-text">
            <strong>{error.code}</strong>: {error.message}
          </span>
          {/* B3 — dismissible so keyboard users can clear the error without resubmitting */}
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

      {result !== null ? (
        /* B2 — role="status" + aria-live="polite" satisfies WCAG 4.1.3 */
        <div className="tm-result" role="status" aria-live="polite">
          <div className="tm-badges">
            <span className={result.exitCode === 0 ? "tm-badge tm-badge-ok" : "tm-badge tm-badge-fail"}>
              exit {String(result.exitCode)}
            </span>
            <span className="tm-badge">{result.durationMs} ms</span>
            {result.truncated ? <span className="tm-badge tm-badge-warn">truncated</span> : null}
            {result.timedOut ? <span className="tm-badge tm-badge-warn">timed out</span> : null}
          </div>
          {result.stdout.length > 0 ? (
            <pre className="tm-stdout">{result.stdout}</pre>
          ) : null}
          {result.stderr.length > 0 ? (
            <pre className="tm-stderr">{result.stderr}</pre>
          ) : null}
        </div>
      ) : null}

      <ul className="tm-events" aria-label="Recent terminal events">
        {events.map((event, idx) => (
          <li key={`${event.executionId}-${String(idx)}-${event.kind}`} className="tm-event">
            <span className="tm-event-kind">{eventLabel(event.kind)}</span>
            <span className="tm-event-detail">{eventDetail(event)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
