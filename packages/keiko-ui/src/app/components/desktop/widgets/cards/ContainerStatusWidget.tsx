"use client";

// Issue #1388 (ADR-0070) — ContainerStatusWidget: the container engine status surface + governed
// diagnostic run control. This is an OPTIONAL progressive enhancement: on a host with no container
// engine the panel ALWAYS renders the structured unavailable state (the localized engine-state label
// + the server's static remediation hint) as a polite role="status" live region. It is NEVER an
// error boundary and NEVER blocks the rest of Keiko (AC1). Run controls are absent unless an engine
// is available AND the server-frozen catalog is non-empty (AC2). The browser only ever names a
// catalog task id — no free-form image, argv, or docker flags ever leave the UI.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../../../../../lib/api";
import {
  cancelContainerRun,
  containerEventsUrl,
  createContainerRun,
  fetchContainerCapability,
  fetchContainerCatalog,
} from "../../../../../lib/container-api";
import type {
  ContainerCapabilityResponse,
  ContainerEngineState,
  ContainerEngineStatus,
  ContainerRunnerEvent,
  ContainerRunResult,
  ContainerTask,
} from "../../../../../lib/types";
import KeikoSelect from "../../KeikoSelect";
import { subscribeSharedEventSource } from "./sharedEventSource";
import styles from "./TerminalWidget.module.css";

interface ContainerStatusWidgetProps {
  readonly projectPath?: string;
}

interface ErrorState {
  readonly code: string;
  readonly message: string;
}

const MAX_EVENT_LOG = 30;
const CONTAINER_EVENT_SOURCE_TYPES = [
  "container:run-started",
  "container:run-completed",
  "container:run-failed",
  "container:run-cancelled",
] as const;

// Localized, human-readable label per ContainerEngineState. Exhaustive over the (aliased)
// RuntimeCapabilityState union so adding a member is a compile error, not a silent fallthrough.
function engineStateLabel(state: ContainerEngineState): string {
  switch (state) {
    case "available":
      return "Available";
    case "missing":
      return "Not installed";
    case "unsupported":
      return "Unsupported version";
    case "permission-denied":
      return "Permission denied";
    case "not-running":
      return "Engine not running";
    case "policy-blocked":
      return "Blocked by policy";
  }
}

// Maps an engine state to a CSS status tone variable (--ok / --warn / --danger / --fg-faint).
function engineStateTone(state: ContainerEngineState): "ok" | "warn" | "danger" | "faint" {
  switch (state) {
    case "available":
      return "ok";
    case "not-running":
    case "permission-denied":
      return "warn";
    case "missing":
    case "unsupported":
      return "faint";
    case "policy-blocked":
      return "danger";
  }
}

function errorFromUnknown(value: unknown): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: "Unexpected error." };
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `container-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function taskLabel(task: ContainerTask): string {
  return `${task.kind} · ${task.label}`;
}

function eventLabel(kind: ContainerRunnerEvent["kind"]): string {
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

function eventDetail(event: ContainerRunnerEvent): string {
  const p = event.payload;
  if (event.kind === "run-completed" || event.kind === "run-failed") {
    const reason = typeof p.failureReason === "string" ? p.failureReason : "";
    const dur = typeof p.durationMs === "number" ? `${String(p.durationMs)}ms` : "";
    return [reason, dur].filter(Boolean).join(" · ");
  }
  return "";
}

function isOwnEvent(event: ContainerRunnerEvent, requestId: string | null): boolean {
  return (
    requestId !== null &&
    typeof event.payload.requestId === "string" &&
    event.payload.requestId === requestId
  );
}

function resultSummary(result: ContainerRunResult): string {
  const parts = [
    result.engine,
    `exit ${result.exitCode === null ? "n/a" : String(result.exitCode)}`,
    `${String(result.durationMs)} ms`,
  ];
  if (result.truncated) parts.push("output truncated");
  if (result.timedOut) parts.push("timed out");
  parts.push(result.failureReason);
  parts.push(`run ${result.runId}`, `task ${result.taskId}`);
  return `Run finished: ${parts.join(", ")}`;
}

// The structured unavailable / status panel. ALWAYS rendered for every engine in the capability
// response (graceful degradation): each engine shows its localized state label and, when present,
// the server's single static remediation hint line. No raw error text is ever shown here.
function EngineStatusList({
  engines,
}: {
  readonly engines: readonly ContainerEngineStatus[];
}): ReactNode {
  return (
    <ul className="tm-events" aria-label="Container engines">
      {engines.map((engine) => {
        const tone = engineStateTone(engine.state);
        const toneVar =
          tone === "ok"
            ? "var(--ok)"
            : tone === "warn"
              ? "var(--warn)"
              : tone === "danger"
                ? "var(--danger)"
                : "var(--fg-faint)";
        return (
          <li key={engine.engine} className="tm-event">
            <span className="tm-event-kind">
              <span
                className="dot"
                style={{ background: toneVar, marginInlineEnd: 6 }}
                aria-hidden="true"
              />
              {engine.engine}
            </span>
            <span className="tm-event-detail">
              {engineStateLabel(engine.state)}
              {engine.version !== undefined && engine.version.length > 0
                ? ` · ${engine.version}`
                : ""}
            </span>
            {engine.remediationHint !== undefined && engine.remediationHint.length > 0 ? (
              <span className="tm-limits" style={{ color: "var(--fg-faint)" }}>
                {engine.remediationHint}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ContainerStatusWidget(props: ContainerStatusWidgetProps): ReactNode {
  const projectInput = props.projectPath ?? "";
  const [capability, setCapability] = useState<ContainerCapabilityResponse | null>(null);
  const [tasks, setTasks] = useState<readonly ContainerTask[]>([]);
  const [taskId, setTaskId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [inFlightRunId, setInFlightRunId] = useState<string | null>(null);
  const [result, setResult] = useState<ContainerRunResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [events, setEvents] = useState<readonly ContainerRunnerEvent[]>([]);
  const runningRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const runBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevRunningRef = useRef(false);

  const anyAvailable = capability?.anyAvailable === true;
  const hasRunControl = anyAvailable && tasks.length > 0;

  // Probe the container capability on mount / when the project changes. The probe is opt-in and
  // never throws on the host side; a failed fetch surfaces as a muted error and the panel still
  // renders. `root` is optional for the capability route (capability is host-level), so we always
  // probe even with no project path.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void fetchContainerCapability(projectInput)
      .then((cap) => {
        if (cancelled) return;
        setCapability(cap);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCapability(null);
          setError(errorFromUnknown(err));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectInput]);

  // Load the allowlisted catalog only when an engine is available AND a project is bound. With no
  // engine the catalog route 503s by contract, so we never call it — the unavailable panel stands
  // on its own (graceful degradation).
  useEffect(() => {
    if (!anyAvailable || projectInput.length === 0) {
      setTasks([]);
      setTaskId("");
      return;
    }
    let cancelled = false;
    void fetchContainerCatalog(projectInput)
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
  }, [anyAvailable, projectInput]);

  // Subscribe to the shared container run event channel. Ownership is gated on the echoed requestId
  // so a foreign run-started can never arm this card's Cancel.
  useEffect(() => {
    if (!running) return;
    const onMessage = (ev: MessageEvent<string>): void => {
      let parsed: ContainerRunnerEvent;
      try {
        parsed = JSON.parse(ev.data) as ContainerRunnerEvent;
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
    return subscribeSharedEventSource(
      containerEventsUrl(),
      CONTAINER_EVENT_SOURCE_TYPES,
      onMessage,
    );
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
      if (running || runningRef.current || !hasRunControl || taskId.length === 0) return;
      setError(null);
      setResult(null);
      setInFlightRunId(null);
      const requestId = createRequestId();
      pendingRequestIdRef.current = requestId;
      runningRef.current = true;
      setRunning(true);
      try {
        const next = await createContainerRun({ projectId: projectInput, taskId, requestId });
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
    [hasRunControl, projectInput, running, taskId],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    if (inFlightRunId === null) return;
    try {
      await cancelContainerRun(inFlightRunId);
    } catch (err: unknown) {
      setError(errorFromUnknown(err));
    }
  }, [inFlightRunId]);

  return (
    <div className={`terminal commands ${styles.lazyWidgetScope}`}>
      {/* Graceful-degradation status panel — ALWAYS rendered (never an error boundary, never
          blocks). polite live region carrying the structured engine state + remediation hint. */}
      <section role="status" aria-live="polite" aria-label="Container engine status">
        {capability === null ? (
          <p className="tm-limits" style={{ color: "var(--fg-faint)" }}>
            Checking for a container engine…
          </p>
        ) : capability.engines.length === 0 ? (
          <p className="tm-limits" style={{ color: "var(--fg-faint)" }}>
            No container engine was detected. Container diagnostics are unavailable; the rest of
            Keiko is unaffected.
          </p>
        ) : (
          <EngineStatusList engines={capability.engines} />
        )}
      </section>

      {/* Run control — present ONLY when an engine is available AND the catalog is non-empty (AC2).
          With no engine the user sees the status panel above and nothing else. */}
      {hasRunControl ? (
        <form className="tm-form" onSubmit={(e) => void onSubmit(e)}>
          <div className="tm-field">
            <span>Diagnostic task</span>
            <KeikoSelect
              value={taskId}
              ariaLabel="Diagnostic task"
              disabled={tasks.length === 0}
              menuTitle="Allowlisted tasks"
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
            {/* GEN-UI-FOCUS-014: aria-disabled instead of HTML disabled while running —
                disabling the focused submit button throws keyboard focus to <body>.
                onSubmit already guards re-entry; the no-selection condition stays
                hard-disabled (pre-interaction state), mirroring TerminalWidget. */}
            <button
              type="submit"
              className="tm-action"
              data-primary="true"
              ref={runBtnRef}
              disabled={tasks.length === 0 || taskId.length === 0}
              aria-disabled={running || tasks.length === 0 || taskId.length === 0}
            >
              {running ? "Running…" : "Run diagnostic"}
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
        </form>
      ) : null}

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
            <span className="tm-badge">{result.engine}</span>
            <span
              className={result.exitCode === 0 ? "tm-badge tm-badge-ok" : "tm-badge tm-badge-fail"}
            >
              exit {result.exitCode === null ? "n/a" : String(result.exitCode)}
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

      {hasRunControl ? (
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-atomic="false"
          aria-label="Recent container run events"
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
      ) : null}
    </div>
  );
}
