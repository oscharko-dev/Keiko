"use client";

// ADR-0017 D11 — BrowserWidget: opens a BYO-Chrome CDP session via the BFF, navigates to a
// loopback URL, captures screenshots (dry-run by default), and streams SSE events. URL/session
// state is driven by the BFF; the displayed `url` prop is a display hint only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import styles from "./BrowserWidget.module.css";
import { ApiError } from "../../../../../lib/api";
import {
  browserApplyScreenshot,
  browserContent,
  browserEventsUrl,
  browserNavigate,
  browserScreenshot,
  createBrowserSession,
  deleteBrowserSession,
  fetchBrowserStatus,
} from "../../../../../lib/browser-api";
import { createSameOriginApiEventSource } from "../../../../../lib/safe-event-source";
import type {
  BrowserEventEnvelope,
  BrowserScreenshotResult,
  BrowserSessionMeta,
  CdpReachability,
} from "../../../../../lib/types";

interface BrowserWidgetProps {
  /** Display hint for the URL input default; not authoritative session state. */
  readonly url?: string;
  /** Display hint for the CDP port input default. */
  readonly cdpPort?: number;
}

interface ErrorState {
  readonly code: string;
  readonly message: string;
}

interface PendingShot {
  readonly seq: number;
  readonly dataBase64: string;
}

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_URL = "http://localhost:5173";
const MAX_EVENT_LOG = 50;

const BROWSER_EVENT_KINDS: readonly BrowserEventEnvelope["kind"][] = [
  "session-opened",
  "navigated",
  "screenshot-captured",
  "page-content-captured",
  "session-closed",
  "trust-warning",
  "error",
];

function errorFromUnknown(value: unknown): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: "Unexpected error." };
}

function eventLabel(kind: BrowserEventEnvelope["kind"]): string {
  switch (kind) {
    case "session-opened":
      return "session opened";
    case "navigated":
      return "navigated";
    case "screenshot-captured":
      return "screenshot captured";
    case "page-content-captured":
      return "content captured";
    case "session-closed":
      return "session closed";
    case "trust-warning":
      return "trust warning";
    case "error":
      return "error";
  }
}

function navigatedEventDetail(payload: BrowserEventEnvelope["payload"]): string {
  const origin = typeof payload.originOnly === "string" ? payload.originOnly : "";
  const status = typeof payload.httpStatus === "number" ? ` (${String(payload.httpStatus)})` : "";
  return `${origin}${status}`;
}

function screenshotCapturedEventDetail(payload: BrowserEventEnvelope["payload"]): string {
  return payload.persisted === true ? "persisted" : "dry-run";
}

function pageContentCapturedEventDetail(payload: BrowserEventEnvelope["payload"]): string {
  return typeof payload.byteLength === "number" ? `${String(payload.byteLength)} bytes` : "";
}

function messageOrWarningEventDetail(payload: BrowserEventEnvelope["payload"]): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.warning === "string") return payload.warning;
  return "";
}

function eventDetail(event: BrowserEventEnvelope): string {
  switch (event.kind) {
    case "navigated":
      return navigatedEventDetail(event.payload);
    case "screenshot-captured":
      return screenshotCapturedEventDetail(event.payload);
    case "page-content-captured":
      return pageContentCapturedEventDetail(event.payload);
    case "error":
    case "trust-warning":
      return messageOrWarningEventDetail(event.payload);
    default:
      return "";
  }
}

function applyBrowserEvent(
  event: BrowserEventEnvelope,
  setEvents: Dispatch<SetStateAction<readonly BrowserEventEnvelope[]>>,
  setLastOrigin: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): void {
  setEvents((prev) => {
    const next = [...prev, event];
    return next.length > MAX_EVENT_LOG ? next.slice(next.length - MAX_EVENT_LOG) : next;
  });
  if (event.kind === "navigated" && typeof event.payload.originOnly === "string") {
    setLastOrigin(event.payload.originOnly);
  }
  if (event.kind === "error") {
    const code = typeof event.payload.code === "string" ? event.payload.code : "INTERNAL";
    const message = typeof event.payload.message === "string" ? event.payload.message : "Error.";
    setError({ code, message });
  }
}

function attachBrowserEventListener(
  source: EventSource,
  kind: BrowserEventEnvelope["kind"],
  pushEvent: (event: BrowserEventEnvelope) => void,
): void {
  source.addEventListener(`browser:${kind}`, (ev: MessageEvent<string>) => {
    try {
      const envelope = JSON.parse(ev.data) as BrowserEventEnvelope;
      pushEvent(envelope);
    } catch {
      // ignore malformed frame
    }
  });
}

function attachBrowserEventErrorHandler(
  source: EventSource,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): void {
  // GEN-RES-BROWSER-001 — EventSource auto-reconnects on transient network errors, but
  // a FATAL failure (readyState CLOSED — e.g. the BFF restarted and no longer knows
  // this session, answering non-200) previously died silently: the event log just
  // stopped with no signal. Surface it through the widget's existing error state so
  // the user knows the live feed is gone; reopening the session restores it.
  source.onerror = (): void => {
    if (source.readyState !== EventSource.CLOSED) return;
    setError({
      code: "EVENT_STREAM_CLOSED",
      message: "Live browser events disconnected. Reopen the session to resume the feed.",
    });
  };
}

function openBrowserEventSource(
  sessionId: string,
  pushEvent: (event: BrowserEventEnvelope) => void,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): EventSource | null {
  const source = createSameOriginApiEventSource(browserEventsUrl(sessionId));
  if (source === null) return null;
  for (const kind of BROWSER_EVENT_KINDS) {
    attachBrowserEventListener(source, kind, pushEvent);
  }
  attachBrowserEventErrorHandler(source, setError);
  return source;
}

function manageBrowserEventSourceEffect(
  session: BrowserSessionMeta | null,
  eventSourceRef: MutableRefObject<EventSource | null>,
  pushEvent: (event: BrowserEventEnvelope) => void,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): (() => void) | undefined {
  if (session === null) {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    return undefined;
  }
  const source = openBrowserEventSource(session.sessionId, pushEvent, setError);
  if (source === null) return undefined;
  eventSourceRef.current = source;
  return (): void => {
    source.close();
    eventSourceRef.current = null;
  };
}

async function runCheckStatus(
  portInput: string,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setReachability: Dispatch<SetStateAction<CdpReachability | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  clearError();
  setWorking(true);
  try {
    const port = Number.parseInt(portInput, 10);
    const status = await fetchBrowserStatus(port);
    setReachability(status);
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

async function runOpenSession(
  portInput: string,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setSession: Dispatch<SetStateAction<BrowserSessionMeta | null>>,
  setEvents: Dispatch<SetStateAction<readonly BrowserEventEnvelope[]>>,
  setPersistedPath: Dispatch<SetStateAction<string | null>>,
  setLastOrigin: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  clearError();
  setWorking(true);
  try {
    const port = Number.parseInt(portInput, 10);
    const meta = await createBrowserSession(port);
    setSession(meta);
    setEvents([]);
    setPersistedPath(null);
    setLastOrigin(null);
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

async function runCloseSession(
  session: BrowserSessionMeta | null,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setSession: Dispatch<SetStateAction<BrowserSessionMeta | null>>,
  setPendingShot: Dispatch<SetStateAction<PendingShot | null>>,
  setPersistedPath: Dispatch<SetStateAction<string | null>>,
  setLastOrigin: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  if (session === null) return;
  clearError();
  setWorking(true);
  try {
    await deleteBrowserSession(session.sessionId);
    setSession(null);
    setPendingShot(null);
    setPersistedPath(null);
    setLastOrigin(null);
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

async function runNavigate(
  session: BrowserSessionMeta | null,
  urlInput: string,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setLastOrigin: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  if (session === null) return;
  clearError();
  setWorking(true);
  try {
    const result = await browserNavigate(session.sessionId, urlInput);
    setLastOrigin(result.originOnly);
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

async function runScreenshot(
  session: BrowserSessionMeta | null,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setPendingShot: Dispatch<SetStateAction<PendingShot | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  if (session === null) return;
  clearError();
  setWorking(true);
  try {
    const result: BrowserScreenshotResult = await browserScreenshot(session.sessionId);
    if (!result.persisted) {
      setPendingShot({ seq: result.seq, dataBase64: result.dataBase64 });
    }
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

async function runApplyScreenshot(
  session: BrowserSessionMeta | null,
  pendingShot: PendingShot | null,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setPersistedPath: Dispatch<SetStateAction<string | null>>,
  setPendingShot: Dispatch<SetStateAction<PendingShot | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  if (session === null || pendingShot === null) return;
  clearError();
  setWorking(true);
  try {
    const result = await browserApplyScreenshot(session.sessionId, pendingShot.seq);
    if (result.persisted) setPersistedPath(result.path);
    setPendingShot(null);
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

async function runCaptureContent(
  session: BrowserSessionMeta | null,
  clearError: () => void,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): Promise<void> {
  if (session === null) return;
  clearError();
  setWorking(true);
  try {
    await browserContent(session.sessionId);
  } catch (err) {
    setError(errorFromUnknown(err));
  } finally {
    setWorking(false);
  }
}

function guardedAction(
  disabled: boolean,
  label: string,
  setBusyLabel: Dispatch<SetStateAction<string | null>>,
  action: () => Promise<void>,
): () => void {
  return (): void => {
    if (disabled) return;
    setBusyLabel(label);
    void action();
  };
}

function isOpenDisabled(working: boolean, session: BrowserSessionMeta | null): boolean {
  return working || session !== null;
}

function isSessionRequiredDisabled(working: boolean, session: BrowserSessionMeta | null): boolean {
  return working || session === null;
}

function computePendingShotSrc(pendingShot: PendingShot | null): string | null {
  return pendingShot === null ? null : `data:image/png;base64,${pendingShot.dataBase64}`;
}

// uiux-fix F018 C124: the busiest status wins the announcement; the persistent
// sr-only live region below must exist BEFORE the text changes, otherwise
// NVDA/VoiceOver frequently miss the first (and only) announcement.
function computeStatusAnnouncement(
  working: boolean,
  busyLabel: string | null,
  pendingShot: PendingShot | null,
  persistedPath: string | null,
  lastOrigin: string | null,
  reachability: CdpReachability | null,
  session: BrowserSessionMeta | null,
): string {
  if (working && busyLabel !== null) return busyLabel;
  if (pendingShot !== null) return "Screenshot ready (dry-run) — press Apply to persist.";
  if (persistedPath !== null) return `Persisted as ${persistedPath}.`;
  if (lastOrigin !== null) return `Current origin: ${lastOrigin}`;
  if (reachability !== null && session === null) {
    return `Reachable: ${reachability.reachable ? "yes" : "no"}`;
  }
  return "";
}

function renderBusyStatus(working: boolean, busyLabel: string | null): ReactNode {
  if (!working || busyLabel === null) return null;
  return <p className="bw-status">{busyLabel}</p>;
}

function renderReachabilityStatus(
  reachability: CdpReachability | null,
  session: BrowserSessionMeta | null,
): ReactNode {
  if (reachability === null || session !== null) return null;
  return (
    <p className="bw-status">
      Reachable: {reachability.reachable ? "yes" : "no"}
      {reachability.browserVersion === null ? "" : ` — ${reachability.browserVersion}`}
    </p>
  );
}

function renderLastOriginStatus(lastOrigin: string | null): ReactNode {
  if (lastOrigin === null) return null;
  return (
    <p className="bw-status">
      Current origin: <span className="mono">{lastOrigin}</span>
    </p>
  );
}

function renderPendingShotStatus(pendingShot: PendingShot | null): ReactNode {
  if (pendingShot === null) return null;
  return <p className="bw-status">Screenshot ready (dry-run) — press Apply to persist.</p>;
}

function renderPersistedPathStatus(persistedPath: string | null): ReactNode {
  if (persistedPath === null) return null;
  return (
    <p className="bw-status">
      Persisted as <span className="mono">{persistedPath}</span>.
    </p>
  );
}

// uiux-fix F018 C124: human message first; the machine code is a small mono
// detail instead of a bold prefix ("INTERNAL: Unexpected error.").
function renderErrorAlert(error: ErrorState | null): ReactNode {
  if (error === null) return null;
  return (
    <div className="bw-error" role="alert">
      {error.message} <span className="err-code mono">({error.code})</span>
    </div>
  );
}

function renderBrowserPreview(
  pendingShot: PendingShot | null,
  pendingShotSrc: string | null,
  session: BrowserSessionMeta | null,
): ReactNode {
  if (pendingShot !== null) {
    return (
      // next/image cannot optimize an in-memory data: URL screenshot blob; the BFF already
      // capped this at 10 MB and there is no remote source to optimize through.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="bw-screenshot"
        src={pendingShotSrc ?? undefined}
        alt="Pending screenshot preview"
      />
    );
  }
  return (
    <>
      <div className="ph-stripes" aria-hidden="true" />
      {/* C261 — no live stream exists; screenshots are captured manually,
          so the copy must direct the user instead of promising a preview. */}
      <div className="bw-overlay mono">
        {session === null
          ? "No session — choose a port and press Open session"
          : "Session open — use Screenshot to capture a preview"}
      </div>
    </>
  );
}

export function BrowserWidget(props: BrowserWidgetProps): ReactNode {
  const initialPort = props.cdpPort ?? DEFAULT_CDP_PORT;
  const initialUrl = props.url ?? DEFAULT_URL;
  const [portInput, setPortInput] = useState<string>(String(initialPort));
  const [urlInput, setUrlInput] = useState<string>(initialUrl);
  const [session, setSession] = useState<BrowserSessionMeta | null>(null);
  const [reachability, setReachability] = useState<CdpReachability | null>(null);
  const [working, setWorking] = useState(false);
  // C260 — name the in-flight CDP operation so the user gets visible + announced
  // feedback ("Navigating…") instead of only silently disabled buttons.
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [events, setEvents] = useState<readonly BrowserEventEnvelope[]>([]);
  const [pendingShot, setPendingShot] = useState<PendingShot | null>(null);
  const [persistedPath, setPersistedPath] = useState<string | null>(null);
  const [lastOrigin, setLastOrigin] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  const pushEvent = useCallback(
    (event: BrowserEventEnvelope): void =>
      applyBrowserEvent(event, setEvents, setLastOrigin, setError),
    [],
  );

  useEffect(
    () => manageBrowserEventSourceEffect(session, eventSourceRef, pushEvent, setError),
    [session, pushEvent],
  );

  const handleCheckStatus = useCallback(
    (): Promise<void> =>
      runCheckStatus(portInput, clearError, setWorking, setReachability, setError),
    [portInput, clearError],
  );

  const handleOpen = useCallback(
    (): Promise<void> =>
      runOpenSession(
        portInput,
        clearError,
        setWorking,
        setSession,
        setEvents,
        setPersistedPath,
        setLastOrigin,
        setError,
      ),
    [portInput, clearError],
  );

  const handleClose = useCallback(
    (): Promise<void> =>
      runCloseSession(
        session,
        clearError,
        setWorking,
        setSession,
        setPendingShot,
        setPersistedPath,
        setLastOrigin,
        setError,
      ),
    [session, clearError],
  );

  const handleNavigate = useCallback(
    (): Promise<void> =>
      runNavigate(session, urlInput, clearError, setWorking, setLastOrigin, setError),
    [session, urlInput, clearError],
  );

  const handleScreenshot = useCallback(
    (): Promise<void> => runScreenshot(session, clearError, setWorking, setPendingShot, setError),
    [session, clearError],
  );

  const handleApply = useCallback(
    (): Promise<void> =>
      runApplyScreenshot(
        session,
        pendingShot,
        clearError,
        setWorking,
        setPersistedPath,
        setPendingShot,
        setError,
      ),
    [session, pendingShot, clearError],
  );

  const handleContent = useCallback(
    (): Promise<void> => runCaptureContent(session, clearError, setWorking, setError),
    [session, clearError],
  );

  // GEN-PERF-WIDGET-007 — the screenshot base64 can be ~13 MB; building the data: URL
  // inline in JSX reallocated the whole string on every unrelated re-render (SSE event,
  // busyLabel, error). Memoize on the pending shot so unrelated renders reuse it.
  const pendingShotSrc = useMemo(() => computePendingShotSrc(pendingShot), [pendingShot]);

  const openDisabled = useMemo(() => isOpenDisabled(working, session), [working, session]);
  const sessionRequiredDisabled = useMemo(
    () => isSessionRequiredDisabled(working, session),
    [working, session],
  );
  const checkDisabled = working || session !== null;
  const applyDisabled = working || pendingShot === null;

  const statusAnnouncement = computeStatusAnnouncement(
    working,
    busyLabel,
    pendingShot,
    persistedPath,
    lastOrigin,
    reachability,
    session,
  );

  return (
    <div className={`browser ${styles.lazyWidgetScope}`}>
      <div className="bw-bar">
        <span
          className="bw-dot"
          style={{ background: session === null ? "var(--line-strong)" : "var(--ok)" }}
          aria-hidden="true"
        />
        <label className="bw-field">
          <span className="bw-field-label">Port</span>
          <input
            type="text"
            inputMode="numeric"
            className="bw-input"
            value={portInput}
            onChange={(e): void => setPortInput(e.target.value)}
            disabled={session !== null || working}
          />
        </label>
        <label className="bw-field bw-field-url">
          <span className="bw-field-label">URL</span>
          <input
            type="url"
            className="bw-input bw-input-url"
            value={urlInput}
            onChange={(e): void => setUrlInput(e.target.value)}
            disabled={working}
          />
        </label>
      </div>

      {/* role="group" (not "toolbar"): the toolbar pattern promises arrow-key roving
          tabindex which these independent buttons do not implement (C254).
          uiux-fix F018 C124: aria-disabled + click guards instead of HTML disabled —
          disabling the just-clicked (focused) button throws keyboard focus to <body>. */}
      <div className="bw-actions" role="group" aria-label="Browser actions">
        <button
          type="button"
          className="bw-btn"
          onClick={guardedAction(
            checkDisabled,
            "Checking Chrome…",
            setBusyLabel,
            handleCheckStatus,
          )}
          aria-disabled={checkDisabled}
        >
          Check
        </button>
        <button
          type="button"
          className="bw-btn bw-btn-primary"
          onClick={guardedAction(openDisabled, "Opening session…", setBusyLabel, handleOpen)}
          aria-disabled={openDisabled}
        >
          Open session
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={guardedAction(
            sessionRequiredDisabled,
            "Navigating…",
            setBusyLabel,
            handleNavigate,
          )}
          aria-disabled={sessionRequiredDisabled}
        >
          Navigate
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={guardedAction(
            sessionRequiredDisabled,
            "Capturing screenshot…",
            setBusyLabel,
            handleScreenshot,
          )}
          aria-disabled={sessionRequiredDisabled}
        >
          Screenshot
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={guardedAction(applyDisabled, "Applying screenshot…", setBusyLabel, handleApply)}
          aria-disabled={applyDisabled}
        >
          Apply
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={guardedAction(
            sessionRequiredDisabled,
            "Capturing HTML…",
            setBusyLabel,
            handleContent,
          )}
          aria-disabled={sessionRequiredDisabled}
        >
          Capture HTML
        </button>
        <button
          type="button"
          className="bw-btn bw-btn-danger"
          onClick={guardedAction(
            sessionRequiredDisabled,
            "Closing session…",
            setBusyLabel,
            handleClose,
          )}
          aria-disabled={sessionRequiredDisabled}
        >
          Close
        </button>
      </div>

      {/* uiux-fix F018 C124: persistent live region (announcement mirror); the visible
          status lines below stay conditional but no longer carry role=status, which
          was unreliable because the regions mounted together with their content. */}
      <p className="sr-only" role="status" aria-live="polite">
        {statusAnnouncement}
      </p>

      {renderBusyStatus(working, busyLabel)}

      {renderReachabilityStatus(reachability, session)}

      {renderLastOriginStatus(lastOrigin)}

      {renderPendingShotStatus(pendingShot)}

      {renderPersistedPathStatus(persistedPath)}

      {renderErrorAlert(error)}

      <div className="bw-view">{renderBrowserPreview(pendingShot, pendingShotSrc, session)}</div>

      {/* role="log" exposes the aria-label and announces appended entries
          (implicit aria-live="polite"); a bare aria-live div has no accessible name. */}
      <div className="bw-log" role="log" aria-label="Browser event log">
        <ul className="bw-log-list">
          {/* uiux-fix F018 C124: newest-first like the Terminal and Agent logs — the
              140px scroll viewport otherwise hides exactly the newest entries. */}
          {events
            .slice(-10)
            .reverse()
            .map((event, idx) => (
              <li key={`${String(event.kind)}-${String(idx)}`} className="bw-log-item">
                <span className="bw-log-kind">{eventLabel(event.kind)}</span>
                <span className="bw-log-detail mono">{eventDetail(event)}</span>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
