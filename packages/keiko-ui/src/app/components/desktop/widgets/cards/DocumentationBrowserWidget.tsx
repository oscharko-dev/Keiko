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
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "../../../../../lib/optional-widget-i18n";
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
function reasonCopy(reason: DocumentationNavigationReason, t: OptionalWidgetTranslate): ReasonCopy {
  const prefix = `documentationBrowser.reason.${reason}` as const;
  switch (reason) {
    case "preview-available":
    case "rendering-deferred":
    case "frame-embedding-refused":
    case "content-too-large":
    case "unsupported-scheme":
    case "unsupported-external-target":
    case "local-file-scope-unavailable":
    case "browser-backend-unavailable":
    case "invalid-target":
      return {
        title: t(`${prefix}.title`),
        detail: t(`${prefix}.detail`),
        action: null,
      };
    case "authentication-required":
    case "proxy-or-firewall-blocked":
    case "host-unreachable":
    case "request-timed-out":
    case "navigation-failed":
      return {
        title: t(`${prefix}.title`),
        detail: t(`${prefix}.detail`),
        action:
          reason === "authentication-required"
            ? t("documentationBrowser.reason.authentication-required.action")
            : reason === "proxy-or-firewall-blocked"
              ? t("documentationBrowser.reason.proxy-or-firewall-blocked.action")
              : reason === "host-unreachable"
                ? t("documentationBrowser.reason.host-unreachable.action")
                : reason === "request-timed-out"
                  ? t("documentationBrowser.reason.request-timed-out.action")
                  : t("documentationBrowser.reason.navigation-failed.action"),
      };
  }
}

interface ProposalCopy {
  readonly title: string;
  readonly detail: string;
}

// UI copy for every proposal state (child issues #1868/#1869). Approvability is derived from the wire
// shape (a scope preview is present only for approvable proposals), never re-computed here.
function proposalCopy(
  state: DocumentationManualProposalState,
  t: OptionalWidgetTranslate,
): ProposalCopy {
  const prefix = `documentationBrowser.proposal.${state}` as const;
  return { title: t(`${prefix}.title`), detail: t(`${prefix}.detail`) };
}

function confidenceCopy(
  confidence: DocumentationManualConfidence,
  t: OptionalWidgetTranslate,
): string {
  if (confidence === "none") return "";
  return t(`documentationBrowser.confidence.${confidence}`);
}

function deniedLinkClassCopy(
  deniedClass: DocumentationManualDeniedLinkClass,
  t: OptionalWidgetTranslate,
): string {
  return t(`documentationBrowser.deniedLinkClass.${deniedClass}`);
}

type IndexingPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "proposing" }
  | { readonly kind: "proposed"; readonly proposal: DocumentationIndexingProposal }
  // "approving" renders only a busy spinner, so it carries no payload.
  | { readonly kind: "approving" }
  | { readonly kind: "approved"; readonly approval: DocumentationIndexingApproval }
  | { readonly kind: "error"; readonly error: ErrorState };

function errorFromUnknown(value: unknown, t: OptionalWidgetTranslate): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: t("documentationBrowser.error.unexpected") };
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
  t,
}: {
  readonly preview: DocumentationManualScopePreview;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const denied = preview.deniedLinkClasses.map((cls) => deniedLinkClassCopy(cls, t)).join(", ");
  return (
    <dl className="db-scope">
      <div className="db-scope-row">
        <dt>{t("documentationBrowser.scope.podName")}</dt>
        <dd className="mono">{preview.proposedPodName}</dd>
      </div>
      <div className="db-scope-row">
        <dt>{t("documentationBrowser.scope.scope")}</dt>
        <dd className="mono">
          {preview.originSummary}
          {preview.pathPrefixSummary ?? ""}
        </dd>
      </div>
      <div className="db-scope-row">
        <dt>{t("documentationBrowser.scope.limits")}</dt>
        <dd>
          {t("documentationBrowser.scope.limitsValue", {
            maxPages: preview.limits.maxPages,
            maxDepth: preview.limits.maxDepth,
          })}
        </dd>
      </div>
      <div className="db-scope-row">
        <dt>{t("documentationBrowser.scope.pages")}</dt>
        <dd>{t("documentationBrowser.scope.pagesValue")}</dd>
      </div>
      <div className="db-scope-row">
        <dt>{t("documentationBrowser.scope.excluded")}</dt>
        <dd>{denied}</dd>
      </div>
      {preview.robotsPosture === "honor-robots-txt" ? (
        <div className="db-scope-row">
          <dt>{t("documentationBrowser.scope.robots")}</dt>
          <dd>{t("documentationBrowser.scope.robotsValue")}</dd>
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
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const { proposal } = props;
  const copy = proposalCopy(proposal.state, props.t);
  const confidence = confidenceCopy(proposal.confidence, props.t);
  const approvable = proposal.scopePreview !== null;
  const showOpenPods =
    proposal.alreadyIndexedPodId !== null && props.onOpenKnowledgePods !== undefined;
  return (
    <div className="db-proposal">
      <h3 className="db-proposal-title">{copy.title}</h3>
      <p className="db-proposal-detail">{copy.detail}</p>
      {confidence.length > 0 ? <p className="db-proposal-confidence">{confidence}</p> : null}
      {proposal.scopePreview !== null ? (
        <ScopePreviewView preview={proposal.scopePreview} t={props.t} />
      ) : null}
      {proposal.alreadyIndexedPodId !== null ? (
        <p className="db-proposal-detail">
          {props.t("documentationBrowser.proposal.existingPodReference")}{" "}
          <span className="mono">{proposal.alreadyIndexedPodId}</span>
        </p>
      ) : null}
      <div
        className="db-consent-actions"
        role="group"
        aria-label={props.t("documentationBrowser.consent.ariaLabel")}
      >
        {approvable ? (
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={props.onApprove}
            aria-disabled={props.busy}
            disabled={props.busy}
          >
            {props.t("documentationBrowser.consent.createPod")}
          </button>
        ) : null}
        {showOpenPods ? (
          <button type="button" className="db-btn" onClick={props.onOpenKnowledgePods}>
            {props.t("documentationBrowser.consent.viewPods")}
          </button>
        ) : null}
        <button
          type="button"
          className="db-btn"
          onClick={props.onCancel}
          aria-disabled={props.busy}
          disabled={props.busy}
        >
          {approvable
            ? props.t("documentationBrowser.action.cancel")
            : props.t("documentationBrowser.action.dismiss")}
        </button>
      </div>
    </div>
  );
}

function ApprovedPanel({
  approval,
  t,
}: {
  readonly approval: DocumentationIndexingApproval;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <div className="db-proposal db-state-ready">
      <h3 className="db-proposal-title">{t("documentationBrowser.approved.title")}</h3>
      <p className="db-proposal-detail">
        {t("documentationBrowser.approved.prefix")}{" "}
        <span className="mono">{approval.proposedPodName}</span>{" "}
        {t("documentationBrowser.approved.suffix")}
      </p>
    </div>
  );
}

function useDocumentationNavigation(
  initialTarget: string,
  t: OptionalWidgetTranslate,
): {
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

  const runNavigate = useCallback(
    async (rawTarget: string): Promise<void> => {
      const target = rawTarget.trim();
      if (target.length === 0) {
        setError({ code: "EMPTY", message: t("documentationBrowser.error.empty") });
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
        setError(errorFromUnknown(err, t));
      } finally {
        setWorking(false);
      }
    },
    [t],
  );

  return { targetInput, setTargetInput, working, result, error, lastTarget, runNavigate };
}

function announce(
  working: boolean,
  targetInput: string,
  error: ErrorState | null,
  copy: ReasonCopy | null,
  t: OptionalWidgetTranslate,
): string {
  if (working && targetInput.trim().length > 0) {
    return t("documentationBrowser.status.opening");
  }
  if (error !== null) return error.message;
  return copy !== null ? `${copy.title}. ${copy.detail}` : "";
}

function documentationStatusColor(result: DocumentationNavigationResult | null): string {
  if (result === null) return "var(--line-strong)";
  if (result.severity === "ready") return "var(--ok)";
  return result.severity === "error" ? "var(--danger)" : "var(--line-strong)";
}

function DocumentationView({
  working,
  copy,
  result,
  t,
}: {
  readonly working: boolean;
  readonly copy: ReasonCopy | null;
  readonly result: DocumentationNavigationResult | null;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (working) {
    return (
      <div className="db-view">
        <div className="ph-stripes" aria-hidden="true" />
        <div className="db-overlay mono">{t("documentationBrowser.status.opening")}</div>
      </div>
    );
  }
  if (copy !== null && result !== null) {
    return (
      <div className="db-view">
        <div className={`db-state ${severityClass(result.severity)}`}>
          <h3 className="db-state-title">{copy.title}</h3>
          <p className="db-state-detail">{copy.detail}</p>
          {copy.action !== null ? <p className="db-state-action">{copy.action}</p> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="db-view">
      <div className="ph-stripes" aria-hidden="true" />
      <div className="db-overlay mono">{t("documentationBrowser.empty.instructions")}</div>
    </div>
  );
}

interface DocumentationIndexingStateProps {
  readonly indexing: IndexingPhase;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onOpenKnowledgePods: DocumentationBrowserWidgetProps["onOpenKnowledgePods"];
  readonly t: OptionalWidgetTranslate;
}

function DocumentationIndexingState(props: DocumentationIndexingStateProps): ReactNode {
  switch (props.indexing.kind) {
    case "proposing":
    case "approving":
      return (
        <div className="db-indexing" role="status" aria-live="polite">
          <span className="mono">
            {props.indexing.kind === "proposing"
              ? props.t("documentationBrowser.indexing.checking")
              : props.t("documentationBrowser.indexing.recordingConsent")}
          </span>
        </div>
      );
    case "proposed":
      return (
        <div
          className="db-indexing"
          role="region"
          aria-label={props.t("documentationBrowser.indexing.proposalAriaLabel")}
        >
          <ProposalPanel
            proposal={props.indexing.proposal}
            busy={props.busy}
            onApprove={props.onApprove}
            onCancel={props.onCancel}
            onOpenKnowledgePods={props.onOpenKnowledgePods}
            t={props.t}
          />
        </div>
      );
    case "approved":
      return (
        <div
          className="db-indexing"
          role="region"
          aria-label={props.t("documentationBrowser.indexing.proposalAriaLabel")}
        >
          <ApprovedPanel approval={props.indexing.approval} t={props.t} />
        </div>
      );
    case "error":
      return (
        <div className="db-indexing db-error" role="alert">
          {props.indexing.error.message}{" "}
          <span className="err-code mono">({props.indexing.error.code})</span>
        </div>
      );
    default:
      return null;
  }
}

export function DocumentationBrowserWidget(props: DocumentationBrowserWidgetProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const nav = useDocumentationNavigation(props.target ?? "", t);
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
          setIndexing({ kind: "error", error: errorFromUnknown(err, t) });
        }
      } finally {
        indexingBusyRef.current = false;
      }
    },
    [nav.lastTarget, nav.result, t],
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
  const copy = nav.result === null ? null : reasonCopy(nav.result.reason, t);
  const proposalEligible =
    (nav.result?.capability.indexingProposalAvailable ?? false) &&
    nav.result?.reason !== "authentication-required";
  const announcement = announce(nav.working, nav.targetInput, nav.error, copy, t);

  return (
    <div className={`docbrowser ${styles.lazyWidgetScope}`}>
      <div className="db-bar">
        <span
          className="db-dot"
          style={{ background: documentationStatusColor(nav.result) }}
          aria-hidden="true"
        />
        <label className="db-field db-field-target">
          <span className="db-field-label">{t("documentationBrowser.field.address")}</span>
          <input
            type="text"
            className="db-input"
            value={nav.targetInput}
            placeholder={t("documentationBrowser.field.addressPlaceholder")}
            onChange={(e): void => nav.setTargetInput(e.target.value)}
            onKeyDown={(e): void => {
              if (e.key === "Enter") handleOpen();
            }}
            disabled={nav.working}
          />
        </label>
        <div
          className="db-actions"
          role="group"
          aria-label={t("documentationBrowser.navigation.ariaLabel")}
        >
          <button
            type="button"
            className="db-btn db-btn-primary"
            onClick={handleOpen}
            aria-disabled={openDisabled}
          >
            {t("documentationBrowser.action.open")}
          </button>
          <button
            type="button"
            className="db-btn"
            onClick={handleReload}
            aria-disabled={reloadDisabled}
          >
            {t("documentationBrowser.action.reload")}
          </button>
        </div>
      </div>

      {/* Persistent live region mirror; the visible panels below stay conditional. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {nav.result !== null ? (
        <p className="db-target">
          {t("documentationBrowser.currentTarget")}{" "}
          <span className="mono">{targetLabel(nav.result)}</span>
        </p>
      ) : null}

      {nav.error !== null ? (
        <div className="db-error" role="alert">
          {nav.error.message} <span className="err-code mono">({nav.error.code})</span>
        </div>
      ) : null}

      <DocumentationView working={nav.working} copy={copy} result={nav.result} t={t} />

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
          {t("documentationBrowser.action.prepareIndexing")}
        </button>
        <span className="db-future-note">
          {proposalEligible
            ? t("documentationBrowser.indexing.eligibleNote")
            : t("documentationBrowser.indexing.ineligibleNote")}
        </span>
      </div>

      <DocumentationIndexingState
        indexing={indexing}
        busy={indexingBusy}
        onApprove={handleApprove}
        onCancel={handleCancel}
        onOpenKnowledgePods={props.onOpenKnowledgePods}
        t={t}
      />
    </div>
  );
}
