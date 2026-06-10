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
import { formatBytes, formatMs } from "../../../../../lib/format";
import {
  abortTerminalExecution,
  createTerminalExecution,
  fetchTerminalDirectories,
  fetchTerminalPolicy,
  terminalEventsUrl,
} from "../../../../../lib/terminal-api";
import type {
  TerminalDirectoryEntry,
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

function createRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  // inFlightExecutionId is captured from the SSE execution-started event after submit. It is
  // only armed when the event matches the active submission snapshot. A foreign SSE event is
  // ignored, which keeps Cancel unavailable unless this widget can prove ownership.
  const [inFlightExecutionId, setInFlightExecutionId] = useState<string | null>(null);
  const [result, setResult] = useState<TerminalExecutionResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [events, setEvents] = useState<readonly TerminalEventEnvelope[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const runningRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const [cwdSuggestions, setCwdSuggestions] = useState<readonly TerminalDirectoryEntry[]>([]);

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

  // Populate the cwd datalist suggestions from the BFF directory picker. Refetches whenever
  // the project path or the typed cwd changes. Errors are silently swallowed — suggestions
  // are a UX aid, not a required control.
  useEffect(() => {
    if (projectInput.length === 0) {
      setCwdSuggestions([]);
      return;
    }
    let cancelled = false;
    void fetchTerminalDirectories(projectInput, cwdInput.length > 0 ? cwdInput : undefined)
      .then((listing) => {
        if (!cancelled) setCwdSuggestions(listing.entries);
      })
      .catch(() => {
        if (!cancelled) setCwdSuggestions([]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectInput, cwdInput]);

  useEffect(() => {
    const es = new EventSource(terminalEventsUrl());
    eventSourceRef.current = es;
    const onMessage = (ev: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(ev.data) as TerminalEventEnvelope;
        // Only arm Cancel for the execution that echoes the current requestId.
        // The SSE channel is global, so an unrelated execution-started event must be ignored.
        if (parsed.kind === "execution-started" && runningRef.current) {
          const payload = parsed.payload;
          const requestMatches =
            typeof payload.requestId === "string" &&
            payload.requestId === pendingRequestIdRef.current;
          if (requestMatches) {
            setInFlightExecutionId((current) => (current !== null ? current : parsed.executionId));
          }
        }
        // Clear the captured id when the run ends so the next submit starts clean.
        if (
          parsed.kind === "execution-completed" ||
          parsed.kind === "execution-failed" ||
          parsed.kind === "execution-cancelled"
        ) {
          const payload = parsed.payload;
          const requestMatches =
            typeof payload.requestId === "string" &&
            payload.requestId === pendingRequestIdRef.current;
          if (requestMatches) {
            setInFlightExecutionId((current) => {
              if (current === null || current !== parsed.executionId) return current;
              return null;
            });
          }
        }
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
      setInFlightExecutionId(null);
      const requestId = createRequestId();
      pendingRequestIdRef.current = requestId;
      const parsedArgs = parseArgs(argsInput);
      runningRef.current = true;
      setRunning(true);
      try {
        const executionInput: Parameters<typeof createTerminalExecution>[0] = {
          projectId: projectInput,
          command,
          args: parsedArgs,
          ...(cwdInput.length > 0 ? { cwd: cwdInput } : {}),
          requestId,
        };
        const next = await createTerminalExecution(executionInput);
        setResult(next);
      } catch (err: unknown) {
        setError(errorFromUnknown(err));
      } finally {
        runningRef.current = false;
        setRunning(false);
        pendingRequestIdRef.current = null;
        setInFlightExecutionId(null);
      }
    },
    [argsInput, command, cwdInput, projectInput, running],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    if (inFlightExecutionId === null) return;
    try {
      await abortTerminalExecution(inFlightExecutionId);
    } catch (err: unknown) {
      setError(errorFromUnknown(err));
    }
  }, [inFlightExecutionId]);

  const limits = useMemo(() => policy?.limits ?? null, [policy]);

  // uiux-fix F018 C124: the Cancel button unmounts the moment the run ends; if it
  // held keyboard focus the browser silently drops focus to <body>. Return it to
  // the Run button so keyboard users keep their place.
  const runBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevRunningStateRef = useRef(false);
  useEffect(() => {
    if (prevRunningStateRef.current && !running && document.activeElement === document.body) {
      runBtnRef.current?.focus();
    }
    prevRunningStateRef.current = running;
  }, [running]);

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
            list="tm-cwd-suggestions"
          />
          <datalist id="tm-cwd-suggestions">
            {cwdSuggestions.map((entry) => (
              <option key={entry.path} value={entry.path} />
            ))}
          </datalist>
        </label>
        <div className="tm-actions">
          {/* data-primary — accent primary affordance, mirrors bw-btn-primary/arun-btn
              primary hierarchy in the neighbour widgets (uiux-fix F023 C154) */}
          {/* uiux-fix F018 C124: aria-disabled instead of HTML disabled while running —
              disabling the focused submit button throws keyboard focus to <body>.
              onSubmit already guards re-entry; policy===null stays hard-disabled
              (pre-interaction load state). */}
          <button
            type="submit"
            className="tm-action"
            data-primary="true"
            ref={runBtnRef}
            disabled={policy === null}
            aria-disabled={running || policy === null}
          >
            {running ? "Running…" : "Run"}
          </button>
          {running ? (
            <button
              type="button"
              className="tm-action"
              aria-disabled={inFlightExecutionId === null}
              onClick={() => void onAbort()}
            >
              Cancel
            </button>
          ) : null}
        </div>
        {/* uiux-fix F018 C152: human-readable limits via the shared presenters
            ("256.0 KB · 30.0 s") instead of raw byte/ms integers. */}
        {limits !== null ? (
          <p className="tm-limits">
            Limits: {formatBytes(limits.maxOutputBytes)} output ·{" "}
            {formatMs(limits.defaultTimeoutMs)} timeout
          </p>
        ) : null}
      </form>

      {error !== null ? (
        <div className="tm-error" role="alert">
          {/* uiux-fix F018 C124: human message first; the machine code is a small
              mono detail instead of a bold prefix ("INTERNAL: Unexpected error."). */}
          <span className="tm-error-text">
            {error.message} <span className="err-code mono">({error.code})</span>
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

      {/* uiux-fix F018 C124: the live region must exist BEFORE its content changes —
          a region mounted together with its content is often not announced by
          NVDA/VoiceOver. This persistent sr-only mirror carries the announcement;
          the visible result block below stays conditional. */}
      <p className="sr-only" role="status" aria-live="polite">
        {result !== null
          ? `Command finished: exit ${String(result.exitCode)}, ${String(result.durationMs)} ms${
              result.truncated ? ", output truncated" : ""
            }${result.timedOut ? ", timed out" : ""}`
          : ""}
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
            {result.truncated ? <span className="tm-badge tm-badge-warn">truncated</span> : null}
            {result.timedOut ? <span className="tm-badge tm-badge-warn">timed out</span> : null}
          </div>
          {result.stdout.length > 0 ? <pre className="tm-stdout">{result.stdout}</pre> : null}
          {result.stderr.length > 0 ? <pre className="tm-stderr">{result.stderr}</pre> : null}
        </div>
      ) : null}

      <ul
        className="tm-events"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        aria-label="Recent terminal events"
      >
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
