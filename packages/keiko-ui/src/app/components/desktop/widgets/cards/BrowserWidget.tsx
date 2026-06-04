"use client";

// ADR-0017 D11 — BrowserWidget: opens a BYO-Chrome CDP session via the BFF, navigates to a
// loopback URL, captures screenshots (dry-run by default), and streams SSE events. URL/session
// state is driven by the BFF; the displayed `url` prop is a display hint only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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

function eventDetail(event: BrowserEventEnvelope): string {
  const p = event.payload;
  if (event.kind === "navigated") {
    const origin = typeof p.originOnly === "string" ? p.originOnly : "";
    const status = typeof p.httpStatus === "number" ? ` (${String(p.httpStatus)})` : "";
    return `${origin}${status}`;
  }
  if (event.kind === "screenshot-captured") {
    return p.persisted === true ? "persisted" : "dry-run";
  }
  if (event.kind === "page-content-captured") {
    return typeof p.byteLength === "number" ? `${String(p.byteLength)} bytes` : "";
  }
  if (event.kind === "error" || event.kind === "trust-warning") {
    return typeof p.message === "string"
      ? p.message
      : typeof p.warning === "string"
        ? p.warning
        : "";
  }
  return "";
}

export function BrowserWidget(props: BrowserWidgetProps): ReactNode {
  const initialPort = props.cdpPort ?? DEFAULT_CDP_PORT;
  const initialUrl = props.url ?? DEFAULT_URL;
  const [portInput, setPortInput] = useState<string>(String(initialPort));
  const [urlInput, setUrlInput] = useState<string>(initialUrl);
  const [session, setSession] = useState<BrowserSessionMeta | null>(null);
  const [reachability, setReachability] = useState<CdpReachability | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [events, setEvents] = useState<readonly BrowserEventEnvelope[]>([]);
  const [pendingShot, setPendingShot] = useState<PendingShot | null>(null);
  const [persistedPath, setPersistedPath] = useState<string | null>(null);
  const [lastOrigin, setLastOrigin] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  const pushEvent = useCallback((event: BrowserEventEnvelope): void => {
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
  }, []);

  useEffect(() => {
    if (session === null) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      return;
    }
    const source = new EventSource(browserEventsUrl(session.sessionId));
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
      source.addEventListener(`browser:${kind}`, (ev: MessageEvent<string>) => {
        try {
          const envelope = JSON.parse(ev.data) as BrowserEventEnvelope;
          pushEvent(envelope);
        } catch {
          // ignore malformed frame
        }
      });
    }
    eventSourceRef.current = source;
    return (): void => {
      source.close();
      eventSourceRef.current = null;
    };
  }, [session, pushEvent]);

  const handleCheckStatus = useCallback(async (): Promise<void> => {
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
  }, [portInput, clearError]);

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
      setError(errorFromUnknown(err));
    } finally {
      setWorking(false);
    }
  }, [portInput, clearError]);

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
      setError(errorFromUnknown(err));
    } finally {
      setWorking(false);
    }
  }, [session, clearError]);

  const handleNavigate = useCallback(async (): Promise<void> => {
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
  }, [session, urlInput, clearError]);

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
      setError(errorFromUnknown(err));
    } finally {
      setWorking(false);
    }
  }, [session, clearError]);

  const handleApply = useCallback(async (): Promise<void> => {
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
  }, [session, pendingShot, clearError]);

  const handleContent = useCallback(async (): Promise<void> => {
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
  }, [session, clearError]);

  const openDisabled = useMemo(() => working || session !== null, [working, session]);
  const sessionRequiredDisabled = useMemo(() => working || session === null, [working, session]);

  return (
    <div className="browser" aria-label="Browser tool">
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

      <div className="bw-actions" role="toolbar" aria-label="Browser actions">
        <button
          type="button"
          className="bw-btn"
          onClick={(): void => {
            void handleCheckStatus();
          }}
          disabled={working || session !== null}
        >
          Check
        </button>
        <button
          type="button"
          className="bw-btn bw-btn-primary"
          onClick={(): void => {
            void handleOpen();
          }}
          disabled={openDisabled}
        >
          Open session
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={(): void => {
            void handleNavigate();
          }}
          disabled={sessionRequiredDisabled}
        >
          Navigate
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={(): void => {
            void handleScreenshot();
          }}
          disabled={sessionRequiredDisabled}
        >
          Screenshot
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={(): void => {
            void handleApply();
          }}
          disabled={working || pendingShot === null}
        >
          Apply
        </button>
        <button
          type="button"
          className="bw-btn"
          onClick={(): void => {
            void handleContent();
          }}
          disabled={sessionRequiredDisabled}
        >
          Capture HTML
        </button>
        <button
          type="button"
          className="bw-btn bw-btn-danger"
          onClick={(): void => {
            void handleClose();
          }}
          disabled={sessionRequiredDisabled}
        >
          Close
        </button>
      </div>

      {reachability !== null && session === null ? (
        <p className="bw-status" role="status">
          Reachable: {reachability.reachable ? "yes" : "no"}
          {reachability.browserVersion === null ? "" : ` — ${reachability.browserVersion}`}
        </p>
      ) : null}

      {lastOrigin !== null ? (
        <p className="bw-status" role="status" aria-live="polite">
          Current origin: <span className="mono">{lastOrigin}</span>
        </p>
      ) : null}

      {pendingShot !== null ? (
        <p className="bw-status" role="status">
          Screenshot ready (dry-run) — press Apply to persist.
        </p>
      ) : null}

      {persistedPath !== null ? (
        <p className="bw-status" role="status">
          Persisted as <span className="mono">{persistedPath}</span>.
        </p>
      ) : null}

      {error !== null ? (
        <div className="bw-error" role="alert">
          <strong>{error.code}</strong>: {error.message}
        </div>
      ) : null}

      <div className="bw-view">
        {pendingShot !== null ? (
          // next/image cannot optimize an in-memory data: URL screenshot blob; the BFF already
          // capped this at 10 MB and there is no remote source to optimize through.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="bw-screenshot"
            src={`data:image/png;base64,${pendingShot.dataBase64}`}
            alt="Pending screenshot preview"
          />
        ) : (
          <>
            <div className="ph-stripes" aria-hidden="true" />
            <div className="bw-overlay mono">
              {session === null ? "no session" : "live preview"}
            </div>
          </>
        )}
      </div>

      <div className="bw-log" aria-label="Browser event log" aria-live="polite" aria-atomic="false">
        <ul className="bw-log-list">
          {events.slice(-10).map((event, idx) => (
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
