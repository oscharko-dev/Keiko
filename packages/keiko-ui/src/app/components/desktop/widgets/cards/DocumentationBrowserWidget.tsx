"use client";

// Epic #1851 (ADR-0113) — DocumentationBrowserWidget: the first user-visible, governed surface for
// inspecting local and intranet HTML manuals inside Keiko. It sends a target to the BFF
// /api/docs-browser/navigate route, which classifies it and returns a redacted navigation outcome.
//
// This milestone is browser-only: the widget navigates and reports a precise governed state. It does
// NOT crawl, index, capture, persist, or attach any manual to chat, and no copy implies otherwise.
// Inline rendering of remote pages is intentionally deferred — Keiko's own CSP (frame-ancestors
// 'none') blocks embedding and is not widened here.

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import styles from "./DocumentationBrowserWidget.module.css";
import { ApiError } from "../../../../../lib/api";
import { navigateDocumentation } from "../../../../../lib/docs-browser-api";
import type {
  DocumentationNavigationReason,
  DocumentationNavigationResult,
  DocumentationReasonSeverity,
} from "../../../../../lib/types";

interface DocumentationBrowserWidgetProps {
  /** Display hint for the location input default; not authoritative navigation state. */
  readonly target?: string;
}

interface ErrorState {
  readonly code: string;
  readonly message: string;
}

interface ReasonCopy {
  readonly title: string;
  readonly detail: string;
  readonly action: string | null;
}

// UI-owned copy for every governed reason. The contract owns the machine reason + severity; the
// human wording lives here. Copy is precise and short, never exposes a raw URL/exception, and never
// suggests bypassing an embedding, proxy, or firewall policy (child issue #1863).
const REASON_COPY: Readonly<Record<DocumentationNavigationReason, ReasonCopy>> = {
  "preview-available": {
    title: "Local documentation reachable",
    detail: "This loopback documentation server responded. A live preview can be opened next.",
    action: null,
  },
  "rendering-deferred": {
    title: "Opened for inspection",
    detail:
      "Keiko can navigate to this manual. Inline rendering arrives in a later release; nothing has been crawled, indexed, or attached to chat.",
    action: null,
  },
  "frame-embedding-refused": {
    title: "Page refused embedding",
    detail:
      "This page sets X-Frame-Options or frame-ancestors to refuse embedding. Keiko does not bypass the site's embedding policy.",
    action: null,
  },
  "authentication-required": {
    title: "Sign-in required",
    detail:
      "This documentation requires authentication. Keiko does not collect or replay your credentials.",
    action: "Open the manual in your own browser session, then retry with an accessible page.",
  },
  "proxy-or-firewall-blocked": {
    title: "Blocked by network policy",
    detail:
      "A proxy or firewall blocked this request. Keiko respects your organization's network policy and will not route around it.",
    action: "Confirm the address is permitted by your network policy, then try again.",
  },
  "host-unreachable": {
    title: "Host not found",
    detail: "The address could not be resolved. Check the host name and your connection.",
    action: "Verify the address and retry.",
  },
  "request-timed-out": {
    title: "Request timed out",
    detail: "The documentation did not respond within the governed time limit.",
    action: "Retry, or confirm the server is running.",
  },
  "content-too-large": {
    title: "Document too large",
    detail: "This document exceeds the governed size limit for inspection.",
    action: null,
  },
  "unsupported-scheme": {
    title: "Unsupported address",
    detail:
      "The documentation browser opens http, https, and local file addresses. This address uses a scheme it does not open.",
    action: null,
  },
  "unsupported-external-target": {
    title: "Public address not opened",
    detail:
      "This is a public internet address. The documentation browser is for local and intranet manuals and does not open public sites in this release.",
    action: null,
  },
  "local-file-scope-unavailable": {
    title: "Outside approved scope",
    detail: "This local file is outside the approved documentation scope.",
    action: null,
  },
  "browser-backend-unavailable": {
    title: "Preview backend unavailable",
    detail:
      "A local browser backend is not configured, so a live preview is unavailable. Targets can still be classified.",
    action: null,
  },
  "invalid-target": {
    title: "Invalid address",
    detail: "That does not look like a valid documentation address.",
    action: null,
  },
  "navigation-failed": {
    title: "Could not open documentation",
    detail: "The documentation could not be opened.",
    action: "Please try again.",
  },
};

function errorFromUnknown(value: unknown): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: "Unexpected error." };
}

function severityClass(severity: DocumentationReasonSeverity): string {
  return `db-state-${severity}`;
}

function targetLabel(result: DocumentationNavigationResult): string {
  const path = result.pathSummary ?? "";
  return `${result.originSummary}${path === "/…" ? path : ""}`;
}

export function DocumentationBrowserWidget(props: DocumentationBrowserWidgetProps): ReactNode {
  const [targetInput, setTargetInput] = useState<string>(props.target ?? "");
  const [working, setWorking] = useState<boolean>(false);
  const [result, setResult] = useState<DocumentationNavigationResult | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [lastTarget, setLastTarget] = useState<string | null>(null);

  const runNavigate = useCallback(async (rawTarget: string): Promise<void> => {
    const target = rawTarget.trim();
    if (target.length === 0) {
      setError({ code: "EMPTY", message: "Enter a documentation address to open." });
      return;
    }
    setError(null);
    // Clear the previous outcome up front so a failed navigation never leaves stale loaded state.
    setResult(null);
    setWorking(true);
    try {
      const next = await navigateDocumentation(target);
      setResult(next);
      setLastTarget(target);
    } catch (err) {
      setError(errorFromUnknown(err));
    } finally {
      setWorking(false);
    }
  }, []);

  const handleOpen = useCallback((): void => {
    if (working) return;
    void runNavigate(targetInput);
  }, [working, targetInput, runNavigate]);

  const handleReload = useCallback((): void => {
    if (working || lastTarget === null) return;
    void runNavigate(lastTarget);
  }, [working, lastTarget, runNavigate]);

  const reloadDisabled = working || lastTarget === null;
  const copy = result === null ? null : REASON_COPY[result.reason];
  const announcement =
    working && targetInput.trim().length > 0
      ? "Opening documentation…"
      : error !== null
        ? error.message
        : copy !== null
          ? `${copy.title}. ${copy.detail}`
          : "";

  return (
    <div className={`docbrowser ${styles.lazyWidgetScope}`}>
      <div className="db-bar">
        <span
          className="db-dot"
          style={{
            background:
              result === null
                ? "var(--line-strong)"
                : result.severity === "ready"
                  ? "var(--ok)"
                  : result.severity === "error"
                    ? "var(--danger)"
                    : "var(--line-strong)",
          }}
          aria-hidden="true"
        />
        <label className="db-field db-field-target">
          <span className="db-field-label">Documentation address</span>
          <input
            type="text"
            className="db-input"
            value={targetInput}
            placeholder="https://intranet/handbook or file:///…"
            onChange={(e): void => setTargetInput(e.target.value)}
            onKeyDown={(e): void => {
              if (e.key === "Enter") handleOpen();
            }}
            disabled={working}
          />
        </label>
        <div className="db-actions" role="group" aria-label="Documentation navigation">
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={handleOpen}
            aria-disabled={working}
          >
            Open
          </button>
          <button
            type="button"
            className="db-btn"
            onClick={handleReload}
            aria-disabled={reloadDisabled}
          >
            Reload
          </button>
        </div>
      </div>

      {/* Persistent live region mirror; the visible panels below stay conditional. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {result !== null ? (
        <p className="db-target">
          Current target: <span className="mono">{targetLabel(result)}</span>
        </p>
      ) : null}

      {error !== null ? (
        <div className="db-error" role="alert">
          {error.message} <span className="err-code mono">({error.code})</span>
        </div>
      ) : null}

      <div className="db-view">
        {working ? (
          <>
            <div className="ph-stripes" aria-hidden="true" />
            <div className="db-overlay mono">Opening documentation…</div>
          </>
        ) : copy !== null && result !== null ? (
          <div className={`db-state ${severityClass(result.severity)}`}>
            <h3 className="db-state-title">{copy.title}</h3>
            <p className="db-state-detail">{copy.detail}</p>
            {copy.action !== null ? <p className="db-state-action">{copy.action}</p> : null}
          </div>
        ) : (
          <>
            <div className="ph-stripes" aria-hidden="true" />
            <div className="db-overlay mono">
              Enter a local or intranet documentation address and press Open
            </div>
          </>
        )}
      </div>

      {/* Indexing is a later, separately governed milestone. The affordance is shown but disabled so
          the surface never implies a manual has been crawled, indexed, or attached to chat. */}
      <div className="db-future">
        <button type="button" className="db-btn db-btn-ghost" aria-disabled={true} disabled>
          Prepare for indexing
        </button>
        <span className="db-future-note">Indexing arrives in a later Keiko release.</span>
      </div>
    </div>
  );
}
