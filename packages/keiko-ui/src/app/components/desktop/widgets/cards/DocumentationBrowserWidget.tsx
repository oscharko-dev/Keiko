"use client";

// Epic #1851 (ADR-0113) — DocumentationBrowserWidget: the first user-visible, governed surface for
// inspecting local and intranet HTML manuals inside Keiko. It sends a target to the BFF
// /api/docs-browser/navigate route, which classifies it and returns a redacted navigation outcome.
//
// Epic #1852 extends it into the consent boundary: for a proposal-eligible target the user can ask
// Keiko to check whether it looks like an indexable HTML manual (POST /propose), review the bounded,
// redacted scope preview, and give explicit consent to index it (POST /approve). It still does NOT
// crawl, index, capture, persist, or attach any manual to chat; approving only records a redacted
// consent handoff for a later governed indexing step. Inline rendering remains deferred — Keiko's own
// CSP (frame-ancestors 'none') blocks embedding and is not widened here.

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import styles from "./DocumentationBrowserWidget.module.css";
import { ApiError } from "../../../../../lib/api";
import {
  approveDocumentationIndexing,
  navigateDocumentation,
  proposeDocumentationIndexing,
} from "../../../../../lib/docs-browser-api";
import type {
  DocumentationIndexingApproval,
  DocumentationIndexingProposal,
  DocumentationManualConfidence,
  DocumentationManualDeniedLinkClass,
  DocumentationManualProposalState,
  DocumentationManualScopePreview,
  DocumentationNavigationReason,
  DocumentationNavigationResult,
  DocumentationReasonSeverity,
} from "../../../../../lib/types";

interface DocumentationBrowserWidgetProps {
  /** Display hint for the location input default; not authoritative navigation state. */
  readonly target?: string;
  /**
   * Opens the Local Knowledge / Knowledge Pods surface. Supplied by the window host so an
   * already-indexed manual can point the user at the existing pod instead of creating a duplicate.
   */
  readonly onOpenKnowledgePods?: (() => void) | undefined;
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

interface ProposalCopy {
  readonly title: string;
  readonly detail: string;
}

// UI copy for every proposal state (child issues #1868/#1869). Approvability is derived from the wire
// shape (a scope preview is present only for approvable proposals), never re-computed here.
const PROPOSAL_COPY: Readonly<Record<DocumentationManualProposalState, ProposalCopy>> = {
  "not-evaluated": { title: "Not evaluated", detail: "Keiko has not checked this target yet." },
  "likely-manual": {
    title: "Looks like an indexable manual",
    detail:
      "Keiko recognized this as a static HTML manual. Review the scope below before approving.",
  },
  "probable-manual": {
    title: "This may be an indexable manual",
    detail: "Review the proposed scope carefully before approving — Keiko is not fully certain.",
  },
  "requires-local-file-approval": {
    title: "Local manual — needs file access",
    detail:
      "This looks like a local HTML manual. Approving grants Keiko access to index it from your approved local file scope.",
  },
  unsupported: {
    title: "Not offered for indexing",
    detail:
      "Keiko does not index this target class. Public sites and unsupported schemes are excluded.",
  },
  denied: {
    title: "Cannot index this target",
    detail: "The address was rejected. Keiko does not index credentialed targets.",
  },
  "authentication-required": {
    title: "Sign-in required",
    detail:
      "This manual requires authentication Keiko will not collect. Open an accessible page instead.",
  },
  "already-indexed": {
    title: "Already in a Knowledge Pod",
    detail:
      "A Knowledge Pod already covers this manual. Open the existing pod instead of creating a duplicate.",
  },
  degraded: {
    title: "Not a static manual",
    detail:
      "This looks like a dynamic or action page. Try the manual's start page — for example its index.html.",
  },
};

const CONFIDENCE_COPY: Readonly<Record<DocumentationManualConfidence, string>> = {
  high: "High confidence",
  medium: "Fair confidence",
  low: "Low confidence — review carefully",
  none: "",
};

const DENIED_LINK_CLASS_COPY: Readonly<Record<DocumentationManualDeniedLinkClass, string>> = {
  "cross-origin": "other sites",
  "outside-path-prefix": "pages outside this section",
  "unsupported-scheme": "non-web links",
  "credentialed-url": "links carrying credentials",
  "path-traversal": "path-traversal links",
};

type IndexingPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "proposing" }
  | { readonly kind: "proposed"; readonly proposal: DocumentationIndexingProposal }
  // "approving" renders only a busy spinner, so it carries no payload.
  | { readonly kind: "approving" }
  | { readonly kind: "approved"; readonly approval: DocumentationIndexingApproval }
  | { readonly kind: "error"; readonly error: ErrorState };

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

function ScopePreviewView({
  preview,
}: {
  readonly preview: DocumentationManualScopePreview;
}): ReactNode {
  const denied = preview.deniedLinkClasses.map((cls) => DENIED_LINK_CLASS_COPY[cls]).join(", ");
  return (
    <dl className="db-scope">
      <div className="db-scope-row">
        <dt>Knowledge Pod name</dt>
        <dd className="mono">{preview.proposedPodName}</dd>
      </div>
      <div className="db-scope-row">
        <dt>Scope</dt>
        <dd className="mono">
          {preview.originSummary}
          {preview.pathPrefixSummary === null ? "" : preview.pathPrefixSummary}
        </dd>
      </div>
      <div className="db-scope-row">
        <dt>Limits</dt>
        <dd>
          up to {preview.limits.maxPages} pages, depth {preview.limits.maxDepth}, no redirects
        </dd>
      </div>
      <div className="db-scope-row">
        <dt>Pages</dt>
        <dd>Not yet sampled — counted during indexing.</dd>
      </div>
      <div className="db-scope-row">
        <dt>Excluded</dt>
        <dd>{denied}</dd>
      </div>
      {preview.robotsPosture === "honor-robots-txt" ? (
        <div className="db-scope-row">
          <dt>Robots</dt>
          <dd>Keiko will honor the site's robots.txt.</dd>
        </div>
      ) : null}
    </dl>
  );
}

function ProposalPanel(props: {
  readonly proposal: DocumentationIndexingProposal;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onOpenKnowledgePods?: (() => void) | undefined;
}): ReactNode {
  const { proposal } = props;
  const copy = PROPOSAL_COPY[proposal.state];
  const confidence = CONFIDENCE_COPY[proposal.confidence];
  const approvable = proposal.scopePreview !== null;
  const showOpenPods =
    proposal.alreadyIndexedPodId !== null && props.onOpenKnowledgePods !== undefined;
  return (
    <div className="db-proposal">
      <h3 className="db-proposal-title">{copy.title}</h3>
      <p className="db-proposal-detail">{copy.detail}</p>
      {confidence.length > 0 ? <p className="db-proposal-confidence">{confidence}</p> : null}
      {proposal.scopePreview !== null ? <ScopePreviewView preview={proposal.scopePreview} /> : null}
      {proposal.alreadyIndexedPodId !== null ? (
        <p className="db-proposal-detail">
          Existing pod reference: <span className="mono">{proposal.alreadyIndexedPodId}</span>
        </p>
      ) : null}
      <div className="db-consent-actions" role="group" aria-label="Indexing consent">
        {approvable ? (
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={props.onApprove}
            aria-disabled={props.busy}
            disabled={props.busy}
          >
            Create Knowledge Pod from this manual
          </button>
        ) : null}
        {showOpenPods ? (
          <button type="button" className="db-btn" onClick={props.onOpenKnowledgePods}>
            View your Knowledge Pods
          </button>
        ) : null}
        <button
          type="button"
          className="db-btn"
          onClick={props.onCancel}
          aria-disabled={props.busy}
          disabled={props.busy}
        >
          {approvable ? "Cancel" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}

function ApprovedPanel({
  approval,
}: {
  readonly approval: DocumentationIndexingApproval;
}): ReactNode {
  return (
    <div className="db-proposal db-state-ready">
      <h3 className="db-proposal-title">Approved for indexing</h3>
      <p className="db-proposal-detail">
        Keiko will index <span className="mono">{approval.proposedPodName}</span> through the
        governed local indexing pipeline. Nothing has been crawled yet; indexing runs as a separate
        governed step and stays on this device.
      </p>
    </div>
  );
}

function useDocumentationNavigation(initialTarget: string): {
  readonly targetInput: string;
  readonly setTargetInput: (value: string) => void;
  readonly working: boolean;
  readonly result: DocumentationNavigationResult | null;
  readonly error: ErrorState | null;
  readonly lastTarget: string | null;
  readonly runNavigate: (raw: string) => Promise<void>;
} {
  const [targetInput, setTargetInput] = useState<string>(initialTarget);
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

  return { targetInput, setTargetInput, working, result, error, lastTarget, runNavigate };
}

function announce(
  working: boolean,
  targetInput: string,
  error: ErrorState | null,
  copy: ReasonCopy | null,
): string {
  if (working && targetInput.trim().length > 0) return "Opening documentation…";
  if (error !== null) return error.message;
  return copy !== null ? `${copy.title}. ${copy.detail}` : "";
}

export function DocumentationBrowserWidget(props: DocumentationBrowserWidgetProps): ReactNode {
  const nav = useDocumentationNavigation(props.target ?? "");
  const [indexing, setIndexing] = useState<IndexingPhase>({ kind: "idle" });
  // Synchronous re-entry guard: a rapid double-click can fire an indexing handler again before the
  // "proposing"/"approving" state has flushed and disabled the button, which would send a second
  // propose/approve request. The ref bails out immediately regardless of render timing.
  const indexingBusyRef = useRef<boolean>(false);
  // Mirrors nav.lastTarget for synchronous reads inside an in-flight propose/approve continuation.
  // A stale closure over nav.lastTarget would keep pointing at the target the call was started for;
  // this ref always reflects the currently displayed target so a late-resolving call can detect that
  // the user has since navigated away (#1868 cross-target race).
  const navTargetRef = useRef<string | null>(nav.lastTarget);
  navTargetRef.current = nav.lastTarget;

  const runNavigate = useCallback(
    async (raw: string): Promise<void> => {
      setIndexing({ kind: "idle" });
      await nav.runNavigate(raw);
    },
    [nav],
  );

  const handleOpen = useCallback((): void => {
    if (nav.working || indexingBusyRef.current) return;
    void runNavigate(nav.targetInput);
  }, [nav.working, nav.targetInput, runNavigate]);

  const handleReload = useCallback((): void => {
    if (nav.working || nav.lastTarget === null || indexingBusyRef.current) return;
    void runNavigate(nav.lastTarget);
  }, [nav.working, nav.lastTarget, runNavigate]);

  const runIndexingCall = useCallback(
    async <T,>(
      call: (
        target: string,
        lastNavigationReason: DocumentationNavigationReason | null,
      ) => Promise<T>,
      onOk: (value: T) => IndexingPhase,
      pending: IndexingPhase,
    ): Promise<void> => {
      if (nav.lastTarget === null || indexingBusyRef.current) return;
      // Capture the target this call was started for. A navigation to a different target while the
      // call is in flight must not let its result resurrect a stale proposal/approval for the
      // manual that is no longer displayed as the current target (#1868 cross-target race).
      const callTarget = nav.lastTarget;
      indexingBusyRef.current = true;
      setIndexing(pending);
      try {
        const value = await call(callTarget, nav.result?.reason ?? null);
        if (navTargetRef.current === callTarget) {
          setIndexing(onOk(value));
        }
      } catch (err) {
        if (navTargetRef.current === callTarget) {
          setIndexing({ kind: "error", error: errorFromUnknown(err) });
        }
      } finally {
        indexingBusyRef.current = false;
      }
    },
    [nav.lastTarget, nav.result],
  );

  const handlePrepare = useCallback((): void => {
    void runIndexingCall(
      proposeDocumentationIndexing,
      (proposal) => ({ kind: "proposed", proposal }),
      { kind: "proposing" },
    );
  }, [runIndexingCall]);

  const handleApprove = useCallback((): void => {
    void runIndexingCall(
      approveDocumentationIndexing,
      (approval) => ({ kind: "approved", approval }),
      { kind: "approving" },
    );
  }, [runIndexingCall]);

  const handleCancel = useCallback((): void => setIndexing({ kind: "idle" }), []);

  const indexingBusy = indexing.kind === "proposing" || indexing.kind === "approving";
  const openDisabled = nav.working || indexingBusy;
  const reloadDisabled = nav.working || nav.lastTarget === null || indexingBusy;
  const copy = nav.result === null ? null : REASON_COPY[nav.result.reason];
  const proposalEligible =
    (nav.result?.capability.indexingProposalAvailable ?? false) &&
    nav.result?.reason !== "authentication-required";
  const announcement = announce(nav.working, nav.targetInput, nav.error, copy);

  return (
    <div className={`docbrowser ${styles.lazyWidgetScope}`}>
      <div className="db-bar">
        <span
          className="db-dot"
          style={{
            background:
              nav.result === null
                ? "var(--line-strong)"
                : nav.result.severity === "ready"
                  ? "var(--ok)"
                  : nav.result.severity === "error"
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
            value={nav.targetInput}
            placeholder="https://intranet/handbook or file:///…"
            onChange={(e): void => nav.setTargetInput(e.target.value)}
            onKeyDown={(e): void => {
              if (e.key === "Enter") handleOpen();
            }}
            disabled={nav.working}
          />
        </label>
        <div className="db-actions" role="group" aria-label="Documentation navigation">
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={handleOpen}
            aria-disabled={openDisabled}
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

      {nav.result !== null ? (
        <p className="db-target">
          Current target: <span className="mono">{targetLabel(nav.result)}</span>
        </p>
      ) : null}

      {nav.error !== null ? (
        <div className="db-error" role="alert">
          {nav.error.message} <span className="err-code mono">({nav.error.code})</span>
        </div>
      ) : null}

      <div className="db-view">
        {nav.working ? (
          <>
            <div className="ph-stripes" aria-hidden="true" />
            <div className="db-overlay mono">Opening documentation…</div>
          </>
        ) : copy !== null && nav.result !== null ? (
          <div className={`db-state ${severityClass(nav.result.severity)}`}>
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

      {/* Indexing is explicit and consent-gated. The affordance is enabled only for a proposal-eligible
          target; it never implies a manual has been crawled, indexed, or attached to chat. */}
      <div className="db-future">
        <button
          type="button"
          className="db-btn db-btn-ghost"
          onClick={handlePrepare}
          aria-disabled={!proposalEligible || indexingBusy}
          disabled={!proposalEligible || indexingBusy}
        >
          Prepare for indexing
        </button>
        <span className="db-future-note">
          {proposalEligible
            ? "Check whether this looks like an indexable manual — you approve before anything is indexed."
            : "Open a local or intranet manual to check whether it can be indexed."}
        </span>
      </div>

      {indexing.kind === "proposing" || indexing.kind === "approving" ? (
        <div className="db-indexing" role="status" aria-live="polite">
          <span className="mono">
            {indexing.kind === "proposing" ? "Checking for a manual…" : "Recording your consent…"}
          </span>
        </div>
      ) : null}

      {indexing.kind === "proposed" ? (
        <div className="db-indexing" role="region" aria-label="Indexing proposal">
          <ProposalPanel
            proposal={indexing.proposal}
            busy={indexingBusy}
            onApprove={handleApprove}
            onCancel={handleCancel}
            onOpenKnowledgePods={props.onOpenKnowledgePods}
          />
        </div>
      ) : null}

      {indexing.kind === "approved" ? (
        <div className="db-indexing" role="region" aria-label="Indexing proposal">
          <ApprovedPanel approval={indexing.approval} />
        </div>
      ) : null}

      {indexing.kind === "error" ? (
        <div className="db-indexing db-error" role="alert">
          {indexing.error.message} <span className="err-code mono">({indexing.error.code})</span>
        </div>
      ) : null}
    </div>
  );
}
