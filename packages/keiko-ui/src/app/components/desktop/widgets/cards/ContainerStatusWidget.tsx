"use client";

// Issue #1388 (ADR-0070) — ContainerStatusWidget: the container engine status surface + governed
// diagnostic run control. This is an OPTIONAL progressive enhancement: on a host with no container
// engine the panel ALWAYS renders the structured unavailable state (the localized engine-state label
// + the server's static remediation hint) as a polite role="status" live region. It is NEVER an
// error boundary and NEVER blocks the rest of Keiko (AC1). Run controls are absent unless an engine
// is available AND the server-frozen catalog is non-empty (AC2). The browser only ever names a
// catalog task id — no free-form image, argv, or docker flags ever leave the UI.

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

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the persistent sr-only
// live region must render regardless of `result`, so this stays a plain string helper rather
// than a conditional render component.
function resultAnnouncement(result: ContainerRunResult | null): string {
  return result === null ? "" : resultSummary(result);
}

// Extracted from the ContainerStatusWidget capability-probe effect (SonarCloud S3776) — probes
// the container capability for a project path and wires up the capability/error state. Returns
// the effect cleanup. `root` is optional for the capability route (capability is host-level), so
// this always probes even with no project path.
function loadContainerCapability(
  projectInput: string,
  setCapability: Dispatch<SetStateAction<ContainerCapabilityResponse | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): () => void {
  let cancelled = false;
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
}

// Extracted from the ContainerStatusWidget catalog effect (SonarCloud S3776) — loads the
// allowlisted diagnostic task catalog once an engine is available and a project is bound. With no
// engine the catalog route 503s by contract, so this never calls it. Returns the effect cleanup,
// or undefined for the early-exit branch (matching the original bare `return;`).
function loadContainerCatalog(
  anyAvailable: boolean,
  projectInput: string,
  setTasks: Dispatch<SetStateAction<readonly ContainerTask[]>>,
  setTaskId: Dispatch<SetStateAction<string>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): (() => void) | undefined {
  if (!anyAvailable || projectInput.length === 0) {
    setTasks([]);
    setTaskId("");
    return undefined;
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
}

// Extracted from the ContainerStatusWidget SSE handler (SonarCloud S3776) — safely parse an
// incoming event frame, mirroring the original try/catch-and-drop-on-failure behavior.
function parseContainerRunnerEvent(raw: string): ContainerRunnerEvent | null {
  try {
    return JSON.parse(raw) as ContainerRunnerEvent;
  } catch {
    return null;
  }
}

// Extracted from the ContainerStatusWidget SSE handler (SonarCloud S3776) — applies one parsed
// event to the in-flight-run and event-log state. Cancel is only armed for the run that echoes
// the current requestId, so a foreign run-started on the shared channel can never hijack
// ownership.
function applyContainerEvent(
  event: ContainerRunnerEvent,
  runningNow: boolean,
  requestId: string | null,
  setInFlightRunId: Dispatch<SetStateAction<string | null>>,
  setEvents: Dispatch<SetStateAction<readonly ContainerRunnerEvent[]>>,
): void {
  if (event.kind === "run-started" && runningNow && isOwnEvent(event, requestId)) {
    setInFlightRunId((current) => current ?? event.runId);
  }
  if (event.kind !== "run-started" && isOwnEvent(event, requestId)) {
    setInFlightRunId((current) => (current === event.runId ? null : current));
  }
  setEvents((current) => [event, ...current].slice(0, MAX_EVENT_LOG));
}

// Extracted from the ContainerStatusWidget focus-return effect (SonarCloud S3776) — named
// predicate mirroring the original inline `&&` chain.
function shouldRestoreRunFocus(wasRunning: boolean, isRunning: boolean): boolean {
  return wasRunning && !isRunning && document.activeElement === document.body;
}

// Extracted from ContainerStatusWidget's onSubmit (SonarCloud S3776) — the try/catch/finally
// around the run POST, taking explicit refs/setters instead of closing over the whole component.
async function executeContainerRun(
  input: Parameters<typeof createContainerRun>[0],
  runningRef: MutableRefObject<boolean>,
  pendingRequestIdRef: MutableRefObject<string | null>,
  setResult: Dispatch<SetStateAction<ContainerRunResult | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
  setRunning: Dispatch<SetStateAction<boolean>>,
  setInFlightRunId: Dispatch<SetStateAction<string | null>>,
): Promise<void> {
  try {
    const next = await createContainerRun(input);
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

// Extracted from ContainerStatusWidget's onAbort (SonarCloud S3776) — the try/catch around the
// cancel POST.
async function cancelInFlightRun(
  runId: string,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  try {
    await cancelContainerRun(runId);
  } catch (err: unknown) {
    setError(errorFromUnknown(err));
  }
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

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the engine status
// content: checking / no-engine-detected / per-engine list. ALWAYS rendered (graceful
// degradation, never an error boundary).
function EngineStatusPanel({
  capability,
}: {
  readonly capability: ContainerCapabilityResponse | null;
}): ReactNode {
  if (capability === null) {
    return (
      <p className="tm-limits" style={{ color: "var(--fg-faint)" }}>
        Checking for a container engine…
      </p>
    );
  }
  if (capability.engines.length === 0) {
    return (
      <p className="tm-limits" style={{ color: "var(--fg-faint)" }}>
        No container engine was detected. Container diagnostics are unavailable; the rest of Keiko
        is unaffected.
      </p>
    );
  }
  return <EngineStatusList engines={capability.engines} />;
}

interface ContainerRunFormProps {
  readonly tasks: readonly ContainerTask[];
  readonly taskId: string;
  readonly setTaskId: (next: string) => void;
  readonly running: boolean;
  readonly inFlightRunId: string | null;
  readonly runBtnRef: MutableRefObject<HTMLButtonElement | null>;
  readonly onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  readonly onAbort: () => void;
}

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the diagnostic task
// select plus Run/Cancel action row, present only when an engine is available and the catalog is
// non-empty (AC2).
function ContainerRunForm({
  tasks,
  taskId,
  setTaskId,
  running,
  inFlightRunId,
  runBtnRef,
  onSubmit,
  onAbort,
}: ContainerRunFormProps): ReactNode {
  return (
    <form className="tm-form" onSubmit={onSubmit}>
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
            onClick={onAbort}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

interface ContainerErrorBannerProps {
  readonly error: ErrorState | null;
  readonly onDismiss: () => void;
}

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the dismissible error
// banner.
function ContainerErrorBanner({ error, onDismiss }: ContainerErrorBannerProps): ReactNode {
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

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the exit-code/engine
// badges plus the truncated/timed-out warning badges for a finished run.
function ContainerResultBadges({ result }: { readonly result: ContainerRunResult }): ReactNode {
  return (
    <div className="tm-badges">
      <span className="tm-badge">{result.engine}</span>
      <span className={result.exitCode === 0 ? "tm-badge tm-badge-ok" : "tm-badge tm-badge-fail"}>
        exit {result.exitCode === null ? "n/a" : String(result.exitCode)}
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

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the finished-run result
// panel.
function ContainerResultPanel({
  result,
}: {
  readonly result: ContainerRunResult | null;
}): ReactNode {
  if (result === null) return null;
  return (
    <div className="tm-result">
      <ContainerResultBadges result={result} />
      {result.stdout.length > 0 ? <pre className="tm-stdout">{result.stdout}</pre> : null}
      {result.stderr.length > 0 ? <pre className="tm-stderr">{result.stderr}</pre> : null}
    </div>
  );
}

// Extracted from the ContainerStatusWidget render (SonarCloud S3776) — the recent run-events log.
function ContainerRunEventLog({
  events,
}: {
  readonly events: readonly ContainerRunnerEvent[];
}): ReactNode {
  return (
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
    setError(null);
    return loadContainerCapability(projectInput, setCapability, setError);
  }, [projectInput]);

  // Load the allowlisted catalog only when an engine is available AND a project is bound. With no
  // engine the catalog route 503s by contract, so we never call it — the unavailable panel stands
  // on its own (graceful degradation).
  useEffect(
    () => loadContainerCatalog(anyAvailable, projectInput, setTasks, setTaskId, setError),
    [anyAvailable, projectInput],
  );

  // Subscribe to the shared container run event channel. Ownership is gated on the echoed requestId
  // so a foreign run-started can never arm this card's Cancel.
  useEffect(() => {
    if (!running) return;
    const onMessage = (ev: MessageEvent<string>): void => {
      const parsed = parseContainerRunnerEvent(ev.data);
      if (parsed === null) return;
      applyContainerEvent(
        parsed,
        runningRef.current,
        pendingRequestIdRef.current,
        setInFlightRunId,
        setEvents,
      );
    };
    return subscribeSharedEventSource(
      containerEventsUrl(),
      CONTAINER_EVENT_SOURCE_TYPES,
      onMessage,
    );
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
      if (running || runningRef.current || !hasRunControl || taskId.length === 0) return;
      setError(null);
      setResult(null);
      setInFlightRunId(null);
      const requestId = createRequestId();
      pendingRequestIdRef.current = requestId;
      runningRef.current = true;
      setRunning(true);
      await executeContainerRun(
        { projectId: projectInput, taskId, requestId },
        runningRef,
        pendingRequestIdRef,
        setResult,
        setError,
        setRunning,
        setInFlightRunId,
      );
    },
    [hasRunControl, projectInput, running, taskId],
  );

  const onAbort = useCallback(async (): Promise<void> => {
    if (inFlightRunId === null) return;
    await cancelInFlightRun(inFlightRunId, setError);
  }, [inFlightRunId]);

  return (
    <div className={`terminal commands ${styles.lazyWidgetScope}`}>
      {/* Graceful-degradation status panel — ALWAYS rendered (never an error boundary, never
          blocks). polite live region carrying the structured engine state + remediation hint. */}
      <section role="status" aria-live="polite" aria-label="Container engine status">
        <EngineStatusPanel capability={capability} />
      </section>

      {/* Run control — present ONLY when an engine is available AND the catalog is non-empty (AC2).
          With no engine the user sees the status panel above and nothing else. */}
      {hasRunControl ? (
        <ContainerRunForm
          tasks={tasks}
          taskId={taskId}
          setTaskId={setTaskId}
          running={running}
          inFlightRunId={inFlightRunId}
          runBtnRef={runBtnRef}
          onSubmit={(e) => void onSubmit(e)}
          onAbort={() => void onAbort()}
        />
      ) : null}

      <ContainerErrorBanner error={error} onDismiss={() => setError(null)} />

      <p className="sr-only" role="status" aria-live="polite">
        {resultAnnouncement(result)}
      </p>

      <ContainerResultPanel result={result} />

      {hasRunControl ? <ContainerRunEventLog events={events} /> : null}
    </div>
  );
}
