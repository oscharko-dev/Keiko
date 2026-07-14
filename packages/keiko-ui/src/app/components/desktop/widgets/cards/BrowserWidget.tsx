"use client";

// ADR-0017 D11 — BrowserWidget: opens a BYO-Chrome CDP session via the BFF, navigates to a
// loopback URL, captures screenshots (dry-run by default), and streams SSE events. URL/session
// state is driven by the BFF; the displayed `url` prop is a display hint only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import styles from "./BrowserWidget.module.css";
import { ApiError } from "../../../../../lib/api";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "../../../../../lib/optional-widget-i18n";
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

function errorFromUnknown(value: unknown, t: OptionalWidgetTranslate): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: t("browserWidget.error.unexpected") };
}

function eventLabel(kind: BrowserEventEnvelope["kind"], t: OptionalWidgetTranslate): string {
  switch (kind) {
    case "session-opened":
      return t("browserWidget.event.sessionOpened");
    case "navigated":
      return t("browserWidget.event.navigated");
    case "screenshot-captured":
      return t("browserWidget.event.screenshotCaptured");
    case "page-content-captured":
      return t("browserWidget.event.contentCaptured");
    case "session-closed":
      return t("browserWidget.event.sessionClosed");
    case "trust-warning":
      return t("browserWidget.event.trustWarning");
    case "error":
      return t("browserWidget.event.error");
  }
}

function navigatedEventDetail(payload: BrowserEventEnvelope["payload"]): string {
  const origin = typeof payload.originOnly === "string" ? payload.originOnly : "";
  const status = typeof payload.httpStatus === "number" ? ` (${String(payload.httpStatus)})` : "";
  return `${origin}${status}`;
}

function errorEventDetail(payload: BrowserEventEnvelope["payload"]): string {
  if (typeof payload.message === "string") return payload.message;
  return typeof payload.warning === "string" ? payload.warning : "";
}

function eventDetail(event: BrowserEventEnvelope, t: OptionalWidgetTranslate): string {
  switch (event.kind) {
    case "navigated":
      return navigatedEventDetail(event.payload);
    case "screenshot-captured":
      return event.payload.persisted === true
        ? t("browserWidget.event.persisted")
        : t("browserWidget.event.dryRun");
    case "page-content-captured":
      return typeof event.payload.byteLength === "number"
        ? t("browserWidget.event.bytes", { count: event.payload.byteLength })
        : "";
    case "error":
    case "trust-warning":
      return errorEventDetail(event.payload);
    default:
      return "";
  }
}

interface BrowserStatusAnnouncementInput {
  readonly working: boolean;
  readonly busyLabel: string | null;
  readonly pendingShot: PendingShot | null;
  readonly persistedPath: string | null;
  readonly lastOrigin: string | null;
  readonly reachability: CdpReachability | null;
  readonly session: BrowserSessionMeta | null;
}

function browserStatusAnnouncement(
  input: BrowserStatusAnnouncementInput,
  t: OptionalWidgetTranslate,
): string {
  if (input.working && input.busyLabel !== null) return input.busyLabel;
  if (input.pendingShot !== null) return t("browserWidget.status.screenshotReady");
  if (input.persistedPath !== null) {
    return t("browserWidget.status.persistedAs", { path: input.persistedPath });
  }
  if (input.lastOrigin !== null) {
    return t("browserWidget.status.currentOrigin", { origin: input.lastOrigin });
  }
  if (input.reachability !== null && input.session === null) {
    return t("browserWidget.status.reachable", {
      state: input.reachability.reachable
        ? t("browserWidget.common.yes")
        : t("browserWidget.common.no"),
    });
  }
  return "";
}

function pendingScreenshotSource(pendingShot: PendingShot | null): string | null {
  return pendingShot === null ? null : `data:image/png;base64,${pendingShot.dataBase64}`;
}

function browserActionAvailability(
  working: boolean,
  session: BrowserSessionMeta | null,
  pendingShot: PendingShot | null,
): {
  readonly openDisabled: boolean;
  readonly sessionRequiredDisabled: boolean;
  readonly checkDisabled: boolean;
  readonly applyDisabled: boolean;
} {
  return {
    openDisabled: working || session !== null,
    sessionRequiredDisabled: working || session === null,
    checkDisabled: working || session !== null,
    applyDisabled: working || pendingShot === null,
  };
}

interface BrowserActionInput {
  readonly disabled: boolean;
  readonly busyLabel: string;
  readonly onBusy: (label: string) => void;
  readonly run: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

function browserActionHandler(input: BrowserActionInput): () => void {
  return (): void => {
    if (input.disabled) return;
    input.onBusy(input.busyLabel);
    input.run().catch(input.onError);
  };
}

function attachBrowserEventListeners(
  source: EventSource,
  pushEvent: (event: BrowserEventEnvelope) => void,
): void {
  const kinds: BrowserEventEnvelope["kind"][] = [
    "session-opened",
    "navigated",
    "screenshot-captured",
    "page-content-captured",
    "session-closed",
    "trust-warning",
    "error",
  ];
  for (const kind of kinds) {
    source.addEventListener(`browser:${kind}`, (event: MessageEvent<string>) => {
      try {
        pushEvent(JSON.parse(event.data) as BrowserEventEnvelope);
      } catch {
        // Ignore malformed frames from a stale or incompatible event stream.
      }
    });
  }
}

function attachBrowserStreamErrorHandler(
  source: EventSource,
  setError: (error: ErrorState) => void,
  t: OptionalWidgetTranslate,
): void {
  source.onerror = (): void => {
    if (source.readyState !== EventSource.CLOSED) return;
    setError({
      code: "EVENT_STREAM_CLOSED",
      message: t("browserWidget.error.streamDisconnected"),
    });
  };
}

function useBrowserEventStream(
  session: BrowserSessionMeta | null,
  pushEvent: (event: BrowserEventEnvelope) => void,
  setError: (error: ErrorState) => void,
  eventSourceRef: RefObject<EventSource | null>,
  t: OptionalWidgetTranslate,
): void {
  useEffect(() => {
    if (session === null) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      return;
    }
    const source = createSameOriginApiEventSource(browserEventsUrl(session.sessionId));
    if (source === null) return;
    attachBrowserEventListeners(source, pushEvent);
    attachBrowserStreamErrorHandler(source, setError, t);
    eventSourceRef.current = source;
    return (): void => {
      source.close();
      eventSourceRef.current = null;
    };
  }, [session, pushEvent, setError, eventSourceRef, t]);
}

function browserEventError(event: BrowserEventEnvelope): ErrorState | null {
  if (event.kind !== "error") return null;
  return {
    code: typeof event.payload.code === "string" ? event.payload.code : "INTERNAL",
    message: typeof event.payload.message === "string" ? event.payload.message : "Error.",
  };
}

function useBrowserEventHandler(
  setEvents: Dispatch<SetStateAction<readonly BrowserEventEnvelope[]>>,
  setLastOrigin: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<ErrorState | null>>,
): (event: BrowserEventEnvelope) => void {
  return useCallback(
    (event: BrowserEventEnvelope): void => {
      setEvents((prev) => {
        const next = [...prev, event];
        return next.length > MAX_EVENT_LOG ? next.slice(next.length - MAX_EVENT_LOG) : next;
      });
      if (event.kind === "navigated" && typeof event.payload.originOnly === "string") {
        setLastOrigin(event.payload.originOnly);
      }
      const eventError = browserEventError(event);
      if (eventError !== null) setError(eventError);
    },
    [setError, setEvents, setLastOrigin],
  );
}

interface BrowserStatusLinesProps {
  readonly working: boolean;
  readonly busyLabel: string | null;
  readonly reachability: CdpReachability | null;
  readonly session: BrowserSessionMeta | null;
  readonly lastOrigin: string | null;
  readonly pendingShot: PendingShot | null;
  readonly persistedPath: string | null;
  readonly error: ErrorState | null;
  readonly t: OptionalWidgetTranslate;
}

function BrowserStatusLines(props: BrowserStatusLinesProps): ReactNode {
  return (
    <>
      {props.working && props.busyLabel !== null ? (
        <p className="bw-status">{props.busyLabel}</p>
      ) : null}
      {props.reachability !== null && props.session === null ? (
        <p className="bw-status">
          {props.t("browserWidget.status.reachable", {
            state: props.reachability.reachable
              ? props.t("browserWidget.common.yes")
              : props.t("browserWidget.common.no"),
          })}
          {props.reachability.browserVersion === null
            ? ""
            : ` — ${props.reachability.browserVersion}`}
        </p>
      ) : null}
      {props.lastOrigin !== null ? (
        <p className="bw-status">
          {props.t("browserWidget.status.currentOriginPrefix")}{" "}
          <span className="mono">{props.lastOrigin}</span>
        </p>
      ) : null}
      {props.pendingShot !== null ? (
        <p className="bw-status">{props.t("browserWidget.status.screenshotReady")}</p>
      ) : null}
      {props.persistedPath !== null ? (
        <p className="bw-status">
          {props.t("browserWidget.status.persistedAsPrefix")}{" "}
          <span className="mono">{props.persistedPath}</span>.
        </p>
      ) : null}
      {props.error !== null ? (
        <div className="bw-error" role="alert">
          {props.error.message} <span className="err-code mono">({props.error.code})</span>
        </div>
      ) : null}
    </>
  );
}

interface BrowserPreviewProps {
  readonly pendingShot: PendingShot | null;
  readonly pendingShotSrc: string | null;
  readonly session: BrowserSessionMeta | null;
  readonly t: OptionalWidgetTranslate;
}

function BrowserPreview({
  pendingShot,
  pendingShotSrc,
  session,
  t,
}: BrowserPreviewProps): ReactNode {
  if (pendingShot !== null) {
    return (
      // next/image cannot optimize an in-memory data: URL screenshot blob; the BFF already
      // capped this at 10 MB and there is no remote source to optimize through.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="bw-screenshot"
        src={pendingShotSrc ?? undefined}
        alt={t("browserWidget.preview.alt")}
      />
    );
  }
  return (
    <>
      <div className="ph-stripes" aria-hidden="true" />
      <div className="bw-overlay mono">
        {session === null
          ? t("browserWidget.preview.noSession")
          : t("browserWidget.preview.sessionOpen")}
      </div>
    </>
  );
}

export function BrowserWidget(props: BrowserWidgetProps): ReactNode {
  const t = useOptionalWidgetTranslate();
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

  const handleUnhandledError = useCallback(
    (caught: unknown): void => {
      setError(errorFromUnknown(caught, t));
    },
    [t],
  );

  const pushEvent = useBrowserEventHandler(setEvents, setLastOrigin, setError);

  useBrowserEventStream(session, pushEvent, setError, eventSourceRef, t);

  const handleCheckStatus = useCallback(async (): Promise<void> => {
    clearError();
    setWorking(true);
    try {
      const port = Number.parseInt(portInput, 10);
      const status = await fetchBrowserStatus(port);
      setReachability(status);
    } catch (err) {
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [portInput, clearError, t]);

  const handleOpen = useCallback(async (): Promise<void> => {
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
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [portInput, clearError, t]);

  const handleClose = useCallback(async (): Promise<void> => {
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
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [session, clearError, t]);

  const handleNavigate = useCallback(async (): Promise<void> => {
    if (session === null) return;
    clearError();
    setWorking(true);
    try {
      const result = await browserNavigate(session.sessionId, urlInput);
      setLastOrigin(result.originOnly);
    } catch (err) {
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [session, urlInput, clearError, t]);

  const handleScreenshot = useCallback(async (): Promise<void> => {
    if (session === null) return;
    clearError();
    setWorking(true);
    try {
      const result: BrowserScreenshotResult = await browserScreenshot(session.sessionId);
      if (!result.persisted) {
        setPendingShot({ seq: result.seq, dataBase64: result.dataBase64 });
      }
    } catch (err) {
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [session, clearError, t]);

  const handleApply = useCallback(async (): Promise<void> => {
    if (session === null || pendingShot === null) return;
    clearError();
    setWorking(true);
    try {
      const result = await browserApplyScreenshot(session.sessionId, pendingShot.seq);
      if (result.persisted) setPersistedPath(result.path);
      setPendingShot(null);
    } catch (err) {
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [session, pendingShot, clearError, t]);

  const handleContent = useCallback(async (): Promise<void> => {
    if (session === null) return;
    clearError();
    setWorking(true);
    try {
      await browserContent(session.sessionId);
    } catch (err) {
      setError(errorFromUnknown(err, t));
    } finally {
      setWorking(false);
    }
  }, [session, clearError, t]);

  // GEN-PERF-WIDGET-007 — the screenshot base64 can be ~13 MB; building the data: URL
  // inline in JSX reallocated the whole string on every unrelated re-render (SSE event,
  // busyLabel, error). Memoize on the pending shot so unrelated renders reuse it.
  const pendingShotSrc = useMemo(() => pendingScreenshotSource(pendingShot), [pendingShot]);

  const { openDisabled, sessionRequiredDisabled, checkDisabled, applyDisabled } =
    browserActionAvailability(working, session, pendingShot);

  // uiux-fix F018 C124: the busiest status wins the announcement; the persistent
  // sr-only live region below must exist BEFORE the text changes, otherwise
  // NVDA/VoiceOver frequently miss the first (and only) announcement.
  const statusAnnouncement = browserStatusAnnouncement(
    { working, busyLabel, pendingShot, persistedPath, lastOrigin, reachability, session },
    t,
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
          <span className="bw-field-label">{t("browserWidget.field.port")}</span>
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
          <span className="bw-field-label">{t("browserWidget.field.url")}</span>
          <input
            type="url"
            className="bw-input bw-input-url"
            value={urlInput}
            onChange={(e): void => setUrlInput(e.target.value)}
            disabled={working}
          />
        </label>
      </div>

      {/* A fieldset groups the independent controls without promising the toolbar pattern's roving
          tabindex, which these buttons do not implement (C254).
          uiux-fix F018 C124: aria-disabled + click guards instead of HTML disabled —
          disabling the just-clicked (focused) button throws keyboard focus to <body>. */}
      <fieldset className="bw-actions" aria-label={t("browserWidget.actions.group")}>
        <button
          type="button"
          className="bw-btn"
          onClick={browserActionHandler({
            disabled: checkDisabled,
            busyLabel: t("browserWidget.busy.check"),
            onBusy: setBusyLabel,
            run: handleCheckStatus,
            onError: handleUnhandledError,
          })}
          aria-disabled={checkDisabled}
        >
          {t("browserWidget.action.check")}
        </button>
        <button
          type="button"
          className="bw-btn bw-btn-primary"
          onClick={browserActionHandler({
            disabled: openDisabled,
            busyLabel: t("browserWidget.busy.open"),
            onBusy: setBusyLabel,
            run: handleOpen,
            onError: handleUnhandledError,
          })}
          aria-disabled={openDisabled}
        >
          {t("browserWidget.action.open")}
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={browserActionHandler({
            disabled: sessionRequiredDisabled,
            busyLabel: t("browserWidget.busy.navigate"),
            onBusy: setBusyLabel,
            run: handleNavigate,
            onError: handleUnhandledError,
          })}
          aria-disabled={sessionRequiredDisabled}
        >
          {t("browserWidget.action.navigate")}
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={browserActionHandler({
            disabled: sessionRequiredDisabled,
            busyLabel: t("browserWidget.busy.screenshot"),
            onBusy: setBusyLabel,
            run: handleScreenshot,
            onError: handleUnhandledError,
          })}
          aria-disabled={sessionRequiredDisabled}
        >
          {t("browserWidget.action.screenshot")}
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={browserActionHandler({
            disabled: applyDisabled,
            busyLabel: t("browserWidget.busy.apply"),
            onBusy: setBusyLabel,
            run: handleApply,
            onError: handleUnhandledError,
          })}
          aria-disabled={applyDisabled}
        >
          {t("browserWidget.action.apply")}
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={browserActionHandler({
            disabled: sessionRequiredDisabled,
            busyLabel: t("browserWidget.busy.captureHtml"),
            onBusy: setBusyLabel,
            run: handleContent,
            onError: handleUnhandledError,
          })}
          aria-disabled={sessionRequiredDisabled}
        >
          {t("browserWidget.action.captureHtml")}
        </button>
        <button
          type="button"
          className="bw-btn bw-btn-danger"
          onClick={browserActionHandler({
            disabled: sessionRequiredDisabled,
            busyLabel: t("browserWidget.busy.close"),
            onBusy: setBusyLabel,
            run: handleClose,
            onError: handleUnhandledError,
          })}
          aria-disabled={sessionRequiredDisabled}
        >
          {t("browserWidget.action.close")}
        </button>
      </fieldset>

      {/* uiux-fix F018 C124: persistent live region (announcement mirror); the visible
          status lines below stay conditional but no longer carry role=status, which
          was unreliable because the regions mounted together with their content. */}
      <p className="sr-only" role="status" aria-live="polite">
        {statusAnnouncement}
      </p>

      <BrowserStatusLines
        working={working}
        busyLabel={busyLabel}
        reachability={reachability}
        session={session}
        lastOrigin={lastOrigin}
        pendingShot={pendingShot}
        persistedPath={persistedPath}
        error={error}
        t={t}
      />

      <div className="bw-view">
        <BrowserPreview
          pendingShot={pendingShot}
          pendingShotSrc={pendingShotSrc}
          session={session}
          t={t}
        />
      </div>

      {/* role="log" exposes the aria-label and announces appended entries
          (implicit aria-live="polite"); a bare aria-live div has no accessible name. */}
      <div className="bw-log" role="log" aria-label={t("browserWidget.log.ariaLabel")}>
        <ul className="bw-log-list">
          {/* uiux-fix F018 C124: newest-first like the Terminal and Agent logs — the
              140px scroll viewport otherwise hides exactly the newest entries. */}
          {events
            .slice(-10)
            .reverse()
            .map((event, idx) => (
              <li key={`${String(event.kind)}-${String(idx)}`} className="bw-log-item">
                <span className="bw-log-kind">{eventLabel(event.kind, t)}</span>
                <span className="bw-log-detail mono">{eventDetail(event, t)}</span>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
