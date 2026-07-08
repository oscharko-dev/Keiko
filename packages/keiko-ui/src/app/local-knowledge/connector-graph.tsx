"use client";

// Issue #197 — Connector graph render layer (CSS classes from globals.css).
// State lives in connector-graph-state.ts; types in connector-graph-types.ts.
//
// WCAG: lk-btn-primary uses #06281b on var(--accent) (>4.5:1). Danger text is
// var(--danger) on near-black backgrounds. Focus rings are in globals.css via
// .lk-btn:focus-visible. Min 30×30 target size exceeds WCAG 2.5.8 (24×24).

import Link from "next/link";
import { createPortal } from "react-dom";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  KnowledgeCapsuleId,
  CapsuleSetId,
  CapsuleLifecycleState,
  KnowledgePodSetReadinessReasonCode,
  KnowledgePodModelUsePolicy,
  ManualRefreshChangeSummary,
  ManualRefreshReasonCode,
} from "@oscharko-dev/keiko-contracts";
import {
  MANUAL_REFRESH_REASON_GUIDANCE,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import { isPrimaryActivationPointer } from "@/app/components/desktop/interactionGuards";
import { useModalInteractionLock } from "@/app/components/desktop/hooks/useModalInteractionLock";
import type {
  CapsuleListEntry,
  CapsuleSetListEntry,
  ConnectorGraphProps,
  RowActionKind,
} from "./connector-graph-types";
import { STATUS_LABELS } from "./connector-graph-types";
import { useConnectorGraph } from "./connector-graph-state";
import { CapsuleSetComposeDialog } from "./capsule-set-compose";
import { CapsuleDetail } from "./[capsuleId]/capsule-detail";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  type LocalKnowledgeConnectorDragPayload,
  type LocalKnowledgeConnectorDropDetail,
  serializeLocalKnowledgeConnectorDrag,
} from "./connector-drag";
import manualRefreshStyles from "./manual-refresh-panel.module.css";
import setCountsStyles from "./set-counts.module.css";

// ---------------------------------------------------------------------------
// AlertBanner
// ---------------------------------------------------------------------------

function AlertBanner({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}): ReactNode {
  return (
    <div role="alert" aria-live="assertive" className="lk-alert">
      {message}
      {onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry loading Knowledge Pods"
          className="lk-alert-retry"
        >
          Retry
        </button>
      ) : null}
      {/* Banners without a retry action used to be sticky until the next
          action replaced them (uiux-fix F032, C230). */}
      {onDismiss !== undefined ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error message"
          className="lk-alert-retry"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

function focusablesIn(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])",
    ),
  );
}

type CreateCapsulePolicyMode = "sealed-local" | "standard";

function policyForCreateMode(mode: CreateCapsulePolicyMode): KnowledgePodModelUsePolicy {
  return mode === "sealed-local" ? sealedLocalPodModelUsePolicy() : standardPodModelUsePolicy();
}

function CreateCapsuleDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string, modelUsePolicy: KnowledgePodModelUsePolicy) => Promise<void>;
}): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [policyMode, setPolicyMode] = useState<CreateCapsulePolicyMode>("sealed-local");
  const [validationError, setValidationError] = useState<string | null>(null);
  useModalInteractionLock();

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesIn(dialog);
      if (focusables.length === 0) {
        // All controls are disabled while busy — keep Tab from escaping
        // behind the backdrop (uiux-fix F033, C036).
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  // While busy every control is disabled, which blurs the focused element to
  // document.body. Park focus on the dialog container (tabIndex={-1}) instead;
  // when the request ends and the dialog is still open (error path), move it
  // back to the input (uiux-fix F033, C036).
  const wasBusyRef = useRef(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (busy) {
      wasBusyRef.current = true;
      dialog.focus();
    } else if (wasBusyRef.current) {
      wasBusyRef.current = false;
      focusablesIn(dialog)[0]?.focus();
    }
  }, [busy]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setValidationError("Pod display name is required.");
      return;
    }
    setValidationError(null);
    await onSubmit(trimmed, policyForCreateMode(policyMode));
  }

  const dialogError = validationError ?? error;
  return createPortal(
    <div className="mc-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="mc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="mc-dialog-title">
          Create Knowledge Pod
        </h2>
        {/* Copy used to promise "creates and indexes it" — POST /capsules only
            creates a Draft; indexing is a separate step on the capsule page
            (uiux-fix F032, C232). */}
        <p id={descriptionId} className="mc-dialog-body">
          Name this Knowledge Pod. After creating it, connect a source and start indexing from the
          pod page.
        </p>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label className="mc-dialog-field" htmlFor={inputId}>
            <span className="mc-dialog-label">Knowledge Pod display name</span>
            <input
              id={inputId}
              ref={inputRef}
              className="mc-dialog-input"
              value={name}
              disabled={busy}
              autoComplete="off"
              aria-invalid={dialogError !== null}
              aria-describedby={dialogError !== null ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (validationError !== null) setValidationError(null);
              }}
            />
          </label>
          <fieldset className="mc-dialog-field" disabled={busy}>
            <legend className="mc-dialog-label">Model-use policy</legend>
            <label>
              <input
                type="radio"
                name="model-use-policy"
                value="sealed-local"
                checked={policyMode === "sealed-local"}
                onChange={() => setPolicyMode("sealed-local")}
              />{" "}
              Sealed local
            </label>
            <label>
              <input
                type="radio"
                name="model-use-policy"
                value="standard"
                checked={policyMode === "standard"}
                onChange={() => setPolicyMode("standard")}
              />{" "}
              Standard
            </label>
          </fieldset>
          {/* role=alert + field link, matching the Compose dialog (uiux-fix F032, C103). */}
          {dialogError !== null ? (
            <div id={errorId} role="alert" aria-live="assertive" className="mc-dialog-error">
              {dialogError}
            </div>
          ) : null}
          <div className="mc-dialog-actions">
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button type="submit" className="lk-btn lk-btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create Knowledge Pod"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// DisconnectConfirmDialog — Disconnect removes the capsule's source link with a
// single click and has no undo; every other destructive action on this surface
// (delete, refresh, repair) confirms first (uiux-fix F033, C064).
// ---------------------------------------------------------------------------

function DisconnectConfirmDialog({
  capsuleName,
  onCancel,
  onConfirm,
}: {
  readonly capsuleName: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalInteractionLock();

  // Focus the first control on open; restore the opener on close (WCAG 2.4.3).
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog !== null) focusablesIn(dialog)[0]?.focus();
    return () => trigger?.focus?.();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesIn(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="mc-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="mc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="mc-dialog-title">
          Disconnect Knowledge Pod
        </h2>
        <p id={descriptionId} className="mc-dialog-body">
          Disconnect &quot;{capsuleName}&quot;? The pod keeps its index, but the source link is
          removed.
        </p>
        <div className="mc-dialog-actions">
          <button type="button" className="lk-btn lk-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="lk-btn lk-btn-danger" onClick={onConfirm}>
            Disconnect
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// DeleteCapsuleSetConfirmDialog — deleting a set has no undo; member capsules
// are unaffected, only the set's own metadata/membership is removed
// (AUDIT-E1821-003). Same focus-trap/Escape/Tab behavior as
// DisconnectConfirmDialog above.
// ---------------------------------------------------------------------------

function DeleteCapsuleSetConfirmDialog({
  capsuleSetName,
  onCancel,
  onConfirm,
}: {
  readonly capsuleSetName: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalInteractionLock();

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog !== null) focusablesIn(dialog)[0]?.focus();
    return () => trigger?.focus?.();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesIn(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="mc-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="mc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="mc-dialog-title">
          Delete Knowledge Pod Set
        </h2>
        <p id={descriptionId} className="mc-dialog-body">
          Delete &quot;{capsuleSetName}&quot;? The set&apos;s member Knowledge Pods keep their own
          indexes and are not affected; only this set is removed.
        </p>
        <div className="mc-dialog-actions">
          <button type="button" className="lk-btn lk-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="lk-btn lk-btn-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ state }: { state: CapsuleLifecycleState }): ReactNode {
  // Static text on purpose: a per-row role="status" live region (inside the
  // formerly aria-live section) made screen readers re-announce the whole list
  // on every reload — the page-level summary line announces changes instead
  // (uiux-fix F032, C226).
  return (
    <span className="lk-badge" data-state={state}>
      {STATUS_LABELS[state]}
    </span>
  );
}

function guidanceBadgeState(tone: "warning" | "danger" | "muted"): CapsuleLifecycleState {
  if (tone === "danger") return "error";
  if (tone === "warning") return "stale";
  return "draft";
}

function EmbeddingGuidanceBadge({
  guidance,
}: {
  readonly guidance: NonNullable<CapsuleListEntry["knowledgePod"]>["guidance"];
}): ReactNode {
  if (guidance === undefined) return null;
  return (
    <span className="lk-badge" data-state={guidanceBadgeState(guidance.tone)}>
      {guidance.label}
    </span>
  );
}

function EmbeddingGuidanceDescription({
  id,
  guidance,
}: {
  readonly id: string;
  readonly guidance: NonNullable<CapsuleListEntry["knowledgePod"]>["guidance"];
}): ReactNode {
  if (guidance === undefined) return null;
  return (
    <small id={id}>
      Knowledge Pod guidance: {guidance.label}. {guidance.description}
    </small>
  );
}

// ---------------------------------------------------------------------------
// ManualRefreshPanel — read-only diagnostics for the most recent explicit HTML
// manual refresh (Epic #1856, Issue #1893). There is no refresh trigger route
// in this epic; this panel only renders what the server already redacted onto
// `KnowledgePodSummary.manualRefresh`. Never renders a raw path/URL/body, and
// never renders the crawl-run fingerprint verbatim (it is an opaque token).
// ---------------------------------------------------------------------------

function manualRefreshBadgeState(
  outcome: ManualRefreshChangeSummary["outcome"],
): CapsuleLifecycleState {
  if (outcome === "updated" || outcome === "unchanged") return "ready";
  if (outcome === "partial") return "stale";
  if (outcome === "failed") return "error";
  return "draft";
}

function manualRefreshOutcomeLabel(outcome: ManualRefreshChangeSummary["outcome"]): string {
  if (outcome === "unchanged") return "Unchanged";
  if (outcome === "updated") return "Updated";
  if (outcome === "partial") return "Partial";
  if (outcome === "failed") return "Failed";
  return "Cancelled";
}

const MANUAL_REFRESH_COUNT_LABELS: Record<keyof ManualRefreshChangeSummary["counts"], string> = {
  addedPages: "Added",
  changedPages: "Changed",
  removedPages: "Removed",
  movedPages: "Moved",
  unchangedPages: "Unchanged",
  failedPages: "Failed",
  deniedLinks: "Denied links",
};

function manualRefreshCounts(counts: ManualRefreshChangeSummary["counts"]): ReactNode {
  const entries = Object.entries(MANUAL_REFRESH_COUNT_LABELS) as ReadonlyArray<
    [keyof ManualRefreshChangeSummary["counts"], string]
  >;
  return (
    <dl className="lkd-manual-refresh-counts">
      {entries.map(([key, label]) => (
        <Fragment key={key}>
          <dt>{label}</dt>
          <dd>{counts[key].toString()}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function manualRefreshGuidanceLines(reasonCodes: readonly ManualRefreshReasonCode[]): ReactNode {
  if (reasonCodes.length === 0) return null;
  return (
    <ul className="lkd-manual-refresh-guidance">
      {reasonCodes.map((code) => (
        <li key={code}>{MANUAL_REFRESH_REASON_GUIDANCE[code]}</li>
      ))}
    </ul>
  );
}

function ManualRefreshPanel({
  manualRefresh,
  headingId,
}: {
  readonly manualRefresh: ManualRefreshChangeSummary | undefined;
  readonly headingId: string;
}): ReactNode {
  if (manualRefresh === undefined) return null;
  const removalSkipped = manualRefresh.removalDetection === "not-evaluated-page-limit";
  return (
    <section
      className={`lkd-manual-refresh ${manualRefreshStyles.panelScope}`}
      aria-labelledby={headingId}
    >
      <div className="lkd-manual-refresh-heading">
        <span id={headingId} className="lkd-manual-refresh-title">
          Last refresh
        </span>
        <span className="lk-badge" data-state={manualRefreshBadgeState(manualRefresh.outcome)}>
          {manualRefreshOutcomeLabel(manualRefresh.outcome)}
        </span>
      </div>
      {manualRefreshCounts(manualRefresh.counts)}
      {removalSkipped ? (
        <p className="lkd-manual-refresh-note">
          Removed pages could not be detected this run (the crawl reached its page limit).
        </p>
      ) : null}
      {manualRefreshGuidanceLines(manualRefresh.reasonCodes)}
    </section>
  );
}

function readinessBadgeState(
  readiness: NonNullable<CapsuleSetListEntry["knowledgePod"]>["readiness"] | undefined,
): CapsuleLifecycleState {
  if (readiness === "ready") return "ready";
  if (readiness === "indexing") return "indexing";
  if (readiness === "error" || readiness === "unavailable") return "error";
  if (readiness === "stale" || readiness === "degraded") return "stale";
  return "draft";
}

function readinessLabel(
  readiness: NonNullable<CapsuleSetListEntry["knowledgePod"]>["readiness"] | undefined,
): string {
  if (readiness === undefined) return "Unknown";
  if (readiness === "ready") return "Ready";
  if (readiness === "indexing") return "Indexing";
  if (readiness === "stale") return "Stale";
  if (readiness === "degraded") return "Degraded";
  if (readiness === "unavailable") return "Unavailable";
  if (readiness === "error") return "Failed";
  return "Draft";
}

type CapsuleSetReadinessSummary = NonNullable<
  NonNullable<CapsuleSetListEntry["knowledgePod"]>["setReadiness"]
>;

const SET_READINESS_REASON_LABELS: Record<KnowledgePodSetReadinessReasonCode, string> = {
  "member-draft": "draft",
  "member-indexing": "indexing",
  "member-stale": "stale",
  "member-error": "error",
  "member-unavailable": "unavailable",
  "member-degraded": "degraded",
  "missing-member": "missing",
  "policy-denied": "policy denied",
  "embedding-unknown": "embedding unknown",
  "embedding-incompatible": "embedding mismatch",
  "embedding-unavailable": "embedding unavailable",
  "embedding-opaque": "embedding opaque",
  "no-sources": "no sources",
  "no-vectors": "no vectors",
  "future-remote-member": "remote placeholder",
  "future-federated-member": "federated placeholder",
  "future-ephemeral-member": "ephemeral placeholder",
};

function setReasonLabels(setReadiness: CapsuleSetReadinessSummary): readonly string[] {
  return setReadiness.reasonCodes.map((code) => SET_READINESS_REASON_LABELS[code]);
}

function setCountsEntries(
  counts: NonNullable<NonNullable<CapsuleSetListEntry["knowledgePod"]>["counts"]>,
  setReadiness: CapsuleSetReadinessSummary | undefined,
): ReadonlyArray<readonly [string, string]> {
  const base: ReadonlyArray<readonly [string, string]> = [
    ["pods", counts.capsuleCount.toString()],
    ["sources", counts.sourceCount.toString()],
    ["docs", counts.documentCount.toString()],
    ["chunks", counts.chunkCount.toString()],
    ["vectors", counts.vectorCount.toString()],
  ];
  if (setReadiness === undefined) return base;
  return [
    ...base,
    ["ready", setReadiness.readyCount.toString()],
    ["degraded", setReadiness.degradedCount.toString()],
    ["unavailable", setReadiness.unavailableCount.toString()],
    ["policy denied", setReadiness.deniedCount.toString()],
    ["indexing", setReadiness.indexingCount.toString()],
    ["stale", setReadiness.staleCount.toString()],
    ["error", setReadiness.errorCount.toString()],
    ["missing", setReadiness.missingCount.toString()],
  ];
}

// Structured definition list instead of one long slash-joined string (AUDIT-E1821-005):
// warnings/counts should reduce ambiguity, not become a wall of status text (#1931 engineering
// notes). Follows the same dt/dd + reasons-list pattern as manualRefreshCounts above.
function SetCountsList({ set }: { readonly set: CapsuleSetListEntry }): ReactNode {
  const counts = set.knowledgePod?.counts;
  if (counts === undefined) {
    return <>{`${set.capsuleCount.toString()} Knowledge Pods`}</>;
  }
  const setReadiness = set.knowledgePod?.setReadiness;
  const entries = setCountsEntries(counts, setReadiness);
  const reasonLabels = setReadiness === undefined ? [] : setReasonLabels(setReadiness);
  return (
    <>
      <dl className="lkd-set-counts">
        {entries.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {reasonLabels.length > 0 ? (
        <ul className="lkd-set-counts-reasons">
          <li>{`reasons: ${reasonLabels.join(", ")}`}</li>
        </ul>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// CapsuleRowActions — each action is a named sub-function to keep line counts down
// ---------------------------------------------------------------------------

interface RowActionProps {
  readonly capsule: CapsuleListEntry;
  readonly busy: boolean;
  // Which action is in flight on THIS row (null while idle) — the triggered
  // button swaps its label and announces aria-busy, matching the detail page's
  // "Indexing…"/"Working…" feedback (uiux-fix F048, C233).
  readonly busyKind: RowActionKind | null;
  readonly onStart: (id: KnowledgeCapsuleId) => void;
  readonly onCancel: (id: KnowledgeCapsuleId) => void;
  readonly onDisconnect: (id: KnowledgeCapsuleId) => void;
  readonly onHealth: (id: KnowledgeCapsuleId) => void;
  // Keyboard alternative to drag (WCAG 2.5.7): dispatches the same connector
  // drop event as drag-release onto the workspace.
  readonly onAddToWorkspace: (id: KnowledgeCapsuleId) => void;
}

function IndexOrCancelBtn({
  capsule,
  busy,
  busyKind,
  onStart,
  onCancel,
}: Pick<RowActionProps, "capsule" | "busy" | "busyKind" | "onStart" | "onCancel">): ReactNode {
  const { id, displayName, lifecycleState, sourceCount } = capsule;
  const noSourceHintId = useId();
  if (lifecycleState === "indexing") {
    return (
      <button
        type="button"
        disabled={busy}
        aria-busy={busyKind === "cancel"}
        aria-label={`Cancel indexing for Knowledge Pod ${displayName}`}
        onClick={() => {
          onCancel(id);
        }}
        className="lk-btn lk-btn-ghost"
      >
        {busyKind === "cancel" ? "Cancelling…" : "Cancel"}
      </button>
    );
  }
  const hasSources = sourceCount > 0;
  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-disabled={hasSources ? undefined : true}
        aria-busy={busyKind === "index"}
        aria-label={`Start indexing Knowledge Pod ${displayName}`}
        aria-describedby={hasSources ? undefined : noSourceHintId}
        title={hasSources ? undefined : "Attach a source before indexing this Knowledge Pod."}
        onClick={() => {
          if (!hasSources) return;
          onStart(id);
        }}
        className="lk-btn lk-btn-primary"
      >
        {busyKind === "index" ? "Indexing…" : "Index"}
      </button>
      {!hasSources ? (
        <span id={noSourceHintId} className="visually-hidden">
          Attach a source before indexing.
        </span>
      ) : null}
    </>
  );
}

function CapsuleRowActions({
  capsule,
  busy,
  busyKind,
  onStart,
  onCancel,
  onDisconnect,
  onHealth,
  onAddToWorkspace,
}: RowActionProps): ReactNode {
  const { id, displayName } = capsule;
  return (
    <div
      role="group"
      aria-label={`Actions for Knowledge Pod ${displayName}`}
      className="lk-capsule-actions"
    >
      <IndexOrCancelBtn
        capsule={capsule}
        busy={busy}
        busyKind={busyKind}
        onStart={onStart}
        onCancel={onCancel}
      />
      <button
        type="button"
        disabled={busy}
        aria-label={`Add Knowledge Pod ${displayName} to workspace`}
        onClick={() => {
          onAddToWorkspace(id);
        }}
        className="lk-btn lk-btn-ghost"
      >
        Add to workspace
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Open details for Knowledge Pod ${displayName}`}
        onClick={() => {
          onHealth(id);
        }}
        className="lk-btn lk-btn-ghost"
      >
        Details
      </button>
      <button
        type="button"
        disabled={busy}
        aria-busy={busyKind === "disconnect"}
        aria-label={`Disconnect Knowledge Pod ${displayName}`}
        onClick={() => {
          onDisconnect(id);
        }}
        className="lk-btn lk-btn-danger"
      >
        {busyKind === "disconnect" ? "Disconnecting…" : "Disconnect"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapsuleRow
// ---------------------------------------------------------------------------

function isRowActionDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(".lk-capsule-actions,a,input,select,textarea") !== null;
}

function getWorkspaceCenter(): { readonly clientX: number; readonly clientY: number } | null {
  const ws = document.querySelector("main.workspace");
  if (!(ws instanceof HTMLElement)) return null;
  const rect = ws.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2),
  };
}

function isWorkspaceDropTarget(clientX: number, clientY: number): boolean {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof Element)) return false;
  return target.closest("main.workspace") !== null && target.closest(".window") === null;
}

function dispatchConnectorDrop(
  payload: LocalKnowledgeConnectorDragPayload,
  event: { readonly clientX: number; readonly clientY: number },
): void {
  const detail: LocalKnowledgeConnectorDropDetail = {
    payload,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  window.dispatchEvent(new CustomEvent(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, { detail }));
}

interface CapsuleDragGhost {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly state: CapsuleLifecycleState;
}

function CapsuleRow({
  capsule,
  busy,
  busyKind,
  onStart,
  onCancel,
  onDisconnect,
  onHealth,
  onAddToWorkspace,
}: RowActionProps): ReactNode {
  const guidance = capsule.knowledgePod?.guidance;
  const guidanceDescriptionId = useId();
  const guidanceDescribedBy = guidance === undefined ? undefined : guidanceDescriptionId;
  const manualRefresh = capsule.knowledgePod?.manualRefresh;
  const manualRefreshHeadingId = useId();
  const [dragGhost, setDragGhost] = useState<CapsuleDragGhost | null>(null);
  const dragActiveRef = useRef(false);
  const dropDispatchedRef = useRef(false);
  const payload: LocalKnowledgeConnectorDragPayload = {
    kind: "capsule",
    id: capsule.id,
    label: capsule.displayName,
    lifecycleState: capsule.lifecycleState,
  };
  const emitDrop = (event: { readonly clientX: number; readonly clientY: number }): void => {
    if (dropDispatchedRef.current) return;
    dropDispatchedRef.current = true;
    dispatchConnectorDrop(payload, event);
    window.setTimeout(() => {
      dropDispatchedRef.current = false;
    }, 250);
  };
  const onDragStart = (event: DragEvent<HTMLElement>): void => {
    if (isRowActionDragTarget(event.target)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(
      LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
      serializeLocalKnowledgeConnectorDrag(payload),
    );
    event.dataTransfer.setData("text/plain", capsule.displayName);
  };
  const onDragEnd = (event: DragEvent<HTMLElement>): void => {
    if (isWorkspaceDropTarget(event.clientX, event.clientY)) {
      emitDrop(event);
    }
  };
  // GEN-PERF-MEMORY-004 — a single drag gesture previously registered BOTH the
  // pointer* and mouse* event families (double per-move work on devices that fire
  // both) and had NO pointercancel handler, so a gesture stolen by the browser
  // (scroll/zoom/contextmenu) left document.body.style.cursor='grabbing' and the
  // global listeners leaked. Use only the Pointer Events family — with an explicit
  // pointercancel teardown — falling back to mouse* only when PointerEvent is
  // unsupported.
  const pointerEventsSupported = typeof window !== "undefined" && "PointerEvent" in window;
  const startDragOut = (startX: number, startY: number): void => {
    dragActiveRef.current = true;
    let dragging = false;
    // GEN-PERF-LK-DRAG-001 — raw pointermove fires at up to 120-240Hz; committing the
    // ghost position per event meant one React render per event. Buffer the latest
    // pointer and commit at most once per animation frame (last-event-wins), the same
    // pattern as workspaceActions' connect gesture.
    let lastGhostX = 0;
    let lastGhostY = 0;
    let ghostFrame: number | null = null;
    const applyGhost = (): void => {
      ghostFrame = null;
      if (!dragging) return;
      setDragGhost({
        x: lastGhostX,
        y: lastGhostY,
        label: capsule.displayName,
        state: capsule.lifecycleState,
      });
    };
    const move = (moveEvent: PointerEvent | MouseEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 6) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      lastGhostX = moveEvent.clientX;
      lastGhostY = moveEvent.clientY;
      ghostFrame ??= requestAnimationFrame(applyGhost);
    };
    const teardown = (): void => {
      if (ghostFrame !== null) {
        cancelAnimationFrame(ghostFrame);
        ghostFrame = null;
      }
      if (pointerEventsSupported) {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      } else {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      }
      dragActiveRef.current = false;
      document.body.style.cursor = "";
      setDragGhost(null);
    };
    const up = (upEvent: PointerEvent | MouseEvent): void => {
      const wasDragging = dragging;
      const clientX = upEvent.clientX;
      const clientY = upEvent.clientY;
      teardown();
      if (wasDragging && isWorkspaceDropTarget(clientX, clientY)) {
        emitDrop({ clientX, clientY });
      }
    };
    // A cancelled gesture must run the same teardown (reset cursor + ghost + drop the
    // global listeners) but never emit a drop.
    const cancel = (): void => {
      teardown();
    };
    if (pointerEventsSupported) {
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    } else {
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (dragActiveRef.current || isRowActionDragTarget(event.target)) return;
    if (!isPrimaryActivationPointer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    startDragOut(event.clientX, event.clientY);
  };
  const onMouseDown = (event: ReactMouseEvent<HTMLElement>): void => {
    // Only start from mouse* when Pointer Events are unavailable; otherwise the
    // pointerdown path owns the gesture (avoids a synthetic mousedown double-start).
    if (pointerEventsSupported) return;
    if (dragActiveRef.current || isRowActionDragTarget(event.target)) return;
    if (!isPrimaryActivationPointer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    startDragOut(event.clientX, event.clientY);
  };

  return (
    <>
      <article
        aria-label={`Knowledge Pod: ${capsule.displayName}`}
        aria-describedby={guidanceDescribedBy}
        className="lk-capsule-row"
      >
        <button
          type="button"
          className="lk-capsule-drag-handle"
          // Pointer-only affordance: keyboard users add the capsule via the
          // "Add to workspace" button in CapsuleRowActions, so this drag handle
          // is removed from the Tab order (tabIndex={-1}) to avoid a redundant,
          // keyboard-inert stop (GEN-UI-KEYBOARD-004 / GEN-UI-INTERACTION-004).
          tabIndex={-1}
          aria-label={`Drag Knowledge Pod ${capsule.displayName} to the workspace`}
          aria-describedby={guidanceDescribedBy}
          title="Drag to the workspace to create a Knowledge Pod card"
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          draggable
        >
          <span aria-hidden="true" className="lk-capsule-icon">
            ⬡
          </span>
          <span className="lk-capsule-info">
            <span className="lk-capsule-name" title={capsule.displayName}>
              {capsule.displayName}
            </span>
            <StatusBadge state={capsule.lifecycleState} />
            <EmbeddingGuidanceBadge guidance={guidance} />
            <EmbeddingGuidanceDescription id={guidanceDescriptionId} guidance={guidance} />
          </span>
        </button>
        <CapsuleRowActions
          capsule={capsule}
          busy={busy}
          busyKind={busyKind}
          onStart={onStart}
          onCancel={onCancel}
          onDisconnect={onDisconnect}
          onHealth={onHealth}
          onAddToWorkspace={onAddToWorkspace}
        />
      </article>
      <ManualRefreshPanel manualRefresh={manualRefresh} headingId={manualRefreshHeadingId} />
      {dragGhost !== null
        ? createPortal(
            <div
              className="lk-connector-drag-ghost"
              style={{ left: dragGhost.x + 14, top: dragGhost.y + 14 }}
              aria-hidden="true"
            >
              <span className="lk-connector-drag-ghost-icon">▣</span>
              <span className="lk-connector-drag-ghost-copy">
                <span>{dragGhost.label}</span>
                <small>{STATUS_LABELS[dragGhost.state]}</small>
              </span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({
  creating,
  onCreateCapsule,
}: {
  creating: boolean;
  onCreateCapsule: () => void;
}): ReactNode {
  return (
    <div data-testid="empty-state" className="lk-empty">
      <span aria-hidden="true" className="lk-empty-icon">
        ⬡
      </span>
      <div>
        <p className="lk-empty-title">No Knowledge Pods yet</p>
        <p className="lk-empty-body">
          Create a Knowledge Pod to start indexing governed local knowledge sources.
        </p>
      </div>
      <button
        type="button"
        disabled={creating}
        onClick={onCreateCapsule}
        className="lk-btn lk-btn-primary lk-btn-xl"
      >
        {creating ? "Creating…" : "Create your first Knowledge Pod"}
      </button>
      {/* The permanently-disabled "Connect to existing Knowledge Pod" button (with a
          dev-jargon title tooltip nobody could reach by keyboard) is removed
          until the feature exists (uiux-fix F032, C149/C227). */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapsuleSection
// ---------------------------------------------------------------------------

interface CapsuleSectionProps {
  readonly capsules: readonly CapsuleListEntry[];
  readonly isLoading: boolean;
  readonly creating: boolean;
  readonly actionBusy: KnowledgeCapsuleId | null;
  readonly actionKind: RowActionKind | null;
  readonly onCreateCapsule: () => void;
  readonly onStartIndexing: (id: KnowledgeCapsuleId) => void;
  readonly onCancelIndexing: (id: KnowledgeCapsuleId) => void;
  readonly onDisconnect: (id: KnowledgeCapsuleId) => void;
  readonly onOpenHealth: (id: KnowledgeCapsuleId) => void;
}

function CapsuleSection({
  capsules,
  isLoading,
  creating,
  actionBusy,
  actionKind,
  onCreateCapsule,
  onStartIndexing,
  onCancelIndexing,
  onDisconnect,
  onOpenHealth,
}: CapsuleSectionProps): ReactNode {
  if (isLoading) {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        Loading Knowledge Pods…
      </p>
    );
  }
  if (capsules.length === 0) {
    return <EmptyState creating={creating} onCreateCapsule={onCreateCapsule} />;
  }
  return (
    <ul
      aria-label="Knowledge Pod list"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        listStyle: "none",
        padding: 0,
        margin: 0,
      }}
    >
      {capsules.map((capsule) => (
        <li key={capsule.id} style={{ display: "block" }}>
          <CapsuleRow
            capsule={capsule}
            busy={actionBusy === capsule.id}
            busyKind={actionBusy === capsule.id ? actionKind : null}
            onStart={onStartIndexing}
            onCancel={onCancelIndexing}
            onDisconnect={onDisconnect}
            onHealth={onOpenHealth}
            onAddToWorkspace={() => {
              const center = getWorkspaceCenter();
              if (center !== null)
                dispatchConnectorDrop(
                  {
                    kind: "capsule",
                    id: capsule.id,
                    label: capsule.displayName,
                    lifecycleState: capsule.lifecycleState,
                  },
                  center,
                );
            }}
          />
        </li>
      ))}
    </ul>
  );
}

function CapsuleSetRow({
  capsuleSet,
  onAddToWorkspace,
  onDelete,
  deleteBusy,
}: {
  readonly capsuleSet: CapsuleSetListEntry;
  readonly onAddToWorkspace: () => void;
  readonly onDelete: () => void;
  readonly deleteBusy: boolean;
}): ReactNode {
  const guidance = capsuleSet.knowledgePod?.guidance;
  const guidanceDescriptionId = useId();
  const countsId = useId();
  const describedBy = [countsId, guidance === undefined ? undefined : guidanceDescriptionId]
    .filter((id): id is string => id !== undefined)
    .join(" ");
  const readiness = capsuleSet.knowledgePod?.readiness;
  const payload: LocalKnowledgeConnectorDragPayload = {
    kind: "capsule-set",
    id: capsuleSet.id,
    label: capsuleSet.displayName,
    lifecycleState: readiness ?? "unknown",
  };
  const onDragStart = (event: DragEvent<HTMLElement>): void => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(
      LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
      serializeLocalKnowledgeConnectorDrag(payload),
    );
    event.dataTransfer.setData("text/plain", capsuleSet.displayName);
  };
  const onDragEnd = (event: DragEvent<HTMLElement>): void => {
    if (isWorkspaceDropTarget(event.clientX, event.clientY)) {
      dispatchConnectorDrop(payload, event);
    }
  };
  return (
    <article
      aria-label={`Knowledge Pod Set: ${capsuleSet.displayName}`}
      aria-describedby={describedBy}
      className="lk-capsule-row"
    >
      <button
        type="button"
        className="lk-capsule-drag-handle"
        tabIndex={-1}
        aria-label={`Drag Knowledge Pod Set ${capsuleSet.displayName} to the workspace`}
        aria-describedby={describedBy}
        title="Drag to the workspace to create a Knowledge Pod Set card"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <span aria-hidden="true" className="lk-capsule-icon">
          ▣
        </span>
        <span className="lk-capsule-info">
          <span className="lk-capsule-name" title={capsuleSet.displayName}>
            {capsuleSet.displayName}
          </span>
          <span className="lk-badge" data-state={readinessBadgeState(readiness)}>
            {readinessLabel(readiness)}
          </span>
          <span className="lk-badge" data-state="draft">
            {capsuleSet.capsuleCount.toString()} Pods
          </span>
          <EmbeddingGuidanceBadge guidance={guidance} />
          <small
            id={countsId}
            className={setCountsStyles.scope}
            style={{ display: "block", color: "var(--text-secondary)" }}
          >
            {`Knowledge Pod Set readiness: ${readinessLabel(readiness)}.`}
            <SetCountsList set={capsuleSet} />
          </small>
          <EmbeddingGuidanceDescription id={guidanceDescriptionId} guidance={guidance} />
        </span>
      </button>
      <div className="lk-capsule-actions">
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          onClick={onAddToWorkspace}
          aria-label={`Add Knowledge Pod Set ${capsuleSet.displayName} to workspace`}
          aria-describedby={describedBy}
        >
          Add to workspace
        </button>
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          onClick={onDelete}
          disabled={deleteBusy}
          aria-label={`Delete Knowledge Pod Set ${capsuleSet.displayName}`}
          aria-describedby={describedBy}
        >
          {deleteBusy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </article>
  );
}

function CapsuleSetSection({
  capsuleSets,
  onDelete,
  deleteBusyId,
}: {
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  readonly onDelete: (capsuleSet: CapsuleSetListEntry) => void;
  readonly deleteBusyId: CapsuleSetId | null;
}): ReactNode {
  if (capsuleSets.length === 0) return null;
  return (
    <>
      <h2 className="lk-section-head">Knowledge Pod Sets</h2>
      <ul
        aria-label="Knowledge Pod Set list"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          listStyle: "none",
          padding: 0,
          margin: "0 0 12px",
        }}
      >
        {capsuleSets.map((capsuleSet) => (
          <li key={capsuleSet.id} style={{ display: "block" }}>
            <CapsuleSetRow
              capsuleSet={capsuleSet}
              onAddToWorkspace={() => {
                const center = getWorkspaceCenter();
                if (center !== null)
                  dispatchConnectorDrop(
                    {
                      kind: "capsule-set",
                      id: capsuleSet.id,
                      label: capsuleSet.displayName,
                      lifecycleState: capsuleSet.knowledgePod?.readiness ?? "unknown",
                    },
                    center,
                  );
              }}
              onDelete={() => onDelete(capsuleSet)}
              deleteBusy={deleteBusyId === capsuleSet.id}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// GraphPageHeader — title bar + create button + alert banners
// ---------------------------------------------------------------------------

interface GraphPageHeaderProps {
  readonly creating: boolean;
  readonly createDialogOpen: boolean;
  readonly combineDialogOpen: boolean;
  readonly combineDisabled: boolean;
  readonly showBackToWorkspace: boolean;
  readonly loadStatus: string;
  readonly loadError: string | null;
  readonly actionError: string | null;
  readonly createError: string | null;
  readonly reload: () => void;
  readonly onCreateCapsule: () => void;
  readonly onCombineCapsules: () => void;
  readonly onDismissCreateError: () => void;
  readonly onDismissActionError: () => void;
}

function GraphPageHeader({
  creating,
  createDialogOpen,
  combineDialogOpen,
  combineDisabled,
  showBackToWorkspace,
  loadStatus,
  loadError,
  actionError,
  createError,
  reload,
  onCreateCapsule,
  onCombineCapsules,
  onDismissCreateError,
  onDismissActionError,
}: GraphPageHeaderProps): ReactNode {
  const combineHintId = useId();
  return (
    <>
      <header className="lk-header">
        <h1 className="lk-title">Knowledge Pods</h1>
        <div className="lk-header-actions">
          {showBackToWorkspace ? (
            <Link href="/" className="lk-btn lk-btn-ghost lk-btn-lg">
              Back to Workspace
            </Link>
          ) : null}
          {/* aria-disabled instead of native disabled: the button stays
              focusable, so keyboard/SR users can reach the reason why it is
              inactive (uiux-fix F032, C227). */}
          <button
            type="button"
            aria-disabled={combineDisabled}
            aria-describedby={combineDisabled ? combineHintId : undefined}
            aria-haspopup="dialog"
            aria-expanded={combineDialogOpen}
            title={
              combineDisabled
                ? "Create Knowledge Pods first, then combine them into a set."
                : undefined
            }
            onClick={() => {
              if (!combineDisabled) onCombineCapsules();
            }}
            className="lk-btn lk-btn-ghost lk-btn-lg"
          >
            Create Knowledge Pod Set
          </button>
          {combineDisabled ? (
            <span id={combineHintId} className="visually-hidden">
              Create Knowledge Pods first, then combine them into a set.
            </span>
          ) : null}
          <button
            type="button"
            disabled={creating}
            aria-haspopup="dialog"
            aria-expanded={createDialogOpen}
            onClick={onCreateCapsule}
            className="lk-btn lk-btn-primary lk-btn-lg"
          >
            {creating ? "Creating…" : "Create Knowledge Pod"}
          </button>
        </div>
      </header>
      {loadStatus === "error" && loadError !== null ? (
        <AlertBanner message={loadError} onRetry={reload} />
      ) : null}
      {/* While the create dialog is open the same message already shows inside
          it — rendering the page banner too doubled the SR announcement behind
          the backdrop (uiux-fix F032, C230). */}
      {createError !== null && !createDialogOpen ? (
        <AlertBanner message={createError} onDismiss={onDismissCreateError} />
      ) : null}
      {actionError !== null ? (
        <AlertBanner message={actionError} onDismiss={onDismissActionError} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ConnectorGraph — root export
// ---------------------------------------------------------------------------

// Summary for the single persistent live region (uiux-fix F032, C226):
// announces reload results without re-reading every row.
function catalogAnnouncement(
  capsules: readonly CapsuleListEntry[],
  capsuleSets: readonly CapsuleSetListEntry[],
): string {
  const indexing = capsules.filter((c) => c.lifecycleState === "indexing").length;
  const base = `${capsules.length.toString()} Knowledge Pod${capsules.length === 1 ? "" : "s"}`;
  const setBase = `${capsuleSets.length.toString()} Knowledge Pod Set${
    capsuleSets.length === 1 ? "" : "s"
  }`;
  const catalog = capsuleSets.length > 0 ? `${base}, ${setBase}` : base;
  return indexing > 0 ? `${catalog}, ${indexing.toString()} indexing` : catalog;
}

export function ConnectorGraph(props: ConnectorGraphProps): ReactNode {
  const { onOpenCapsule: externalOpenCapsule, showBackToWorkspace = true } = props;
  const [activeCapsuleId, setActiveCapsuleId] = useState<KnowledgeCapsuleId | null>(null);
  const handleOpenCapsule = useCallback(
    (id: KnowledgeCapsuleId): void => {
      if (externalOpenCapsule !== undefined) {
        externalOpenCapsule(id);
        return;
      }
      setActiveCapsuleId(id);
    },
    [externalOpenCapsule],
  );
  const {
    capsules,
    capsuleSets,
    loadStatus,
    loadError,
    actionBusy,
    actionKind,
    actionError,
    creating,
    createError,
    reload,
    clearCreateError,
    clearActionError,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
    handleCreateCapsule,
    capsuleSetActionBusy,
    capsuleSetActionError,
    clearCapsuleSetActionError,
    handleDeleteCapsuleSet,
  } = useConnectorGraph({ ...props, onOpenCapsule: handleOpenCapsule });
  const isLoading = loadStatus === "loading";
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  // Disconnect is destructive (removes the source link, no undo) — ask first
  // instead of firing the DELETE straight from the row button (uiux-fix F033, C064).
  const [disconnectTarget, setDisconnectTarget] = useState<CapsuleListEntry | null>(null);
  // Deleting a set is destructive and has no undo — same confirm-first pattern
  // as disconnect (AUDIT-E1821-003).
  const [deleteSetTarget, setDeleteSetTarget] = useState<CapsuleSetListEntry | null>(null);

  async function submitCreateCapsule(
    name: string,
    modelUsePolicy: KnowledgePodModelUsePolicy,
  ): Promise<void> {
    try {
      await handleCreateCapsule(name, modelUsePolicy);
      setCreateDialogOpen(false);
    } catch {
      // The state hook surfaces the error message; keep the dialog open for correction/retry.
    }
  }

  function onSetCreated(): void {
    setCombineDialogOpen(false);
    reload();
  }

  if (activeCapsuleId !== null && externalOpenCapsule === undefined) {
    return (
      <div className="lk-page">
        <button
          type="button"
          className="lk-btn lk-btn-ghost lk-btn-lg lk-back-inline"
          onClick={() => {
            setActiveCapsuleId(null);
            reload();
          }}
        >
          Back to Knowledge Pods
        </button>
        <CapsuleDetail
          capsuleId={activeCapsuleId}
          onDeleted={() => {
            setActiveCapsuleId(null);
            reload();
          }}
        />
      </div>
    );
  }

  return (
    <div className="lk-page">
      <GraphPageHeader
        creating={creating}
        createDialogOpen={createDialogOpen}
        combineDialogOpen={combineDialogOpen}
        combineDisabled={isLoading || capsules.length === 0}
        showBackToWorkspace={showBackToWorkspace}
        loadStatus={loadStatus}
        loadError={loadError}
        actionError={actionError}
        createError={createError}
        reload={reload}
        onCreateCapsule={() => setCreateDialogOpen(true)}
        onCombineCapsules={() => setCombineDialogOpen(true)}
        onDismissCreateError={clearCreateError}
        onDismissActionError={clearActionError}
      />
      {/* Compact live region instead of aria-live on the whole list section —
          re-announcing every row after each reload flooded screen readers
          (uiux-fix F032, C226; pattern of MemoryList). */}
      <p role="status" className="visually-hidden">
        {!isLoading && loadError === null ? catalogAnnouncement(capsules, capsuleSets) : null}
      </p>
      {capsuleSetActionError !== null ? (
        <AlertBanner message={capsuleSetActionError} onDismiss={clearCapsuleSetActionError} />
      ) : null}
      <section
        aria-label="Knowledge Pods"
        aria-busy={isLoading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <h2 className="lk-section-head">Knowledge Pods</h2>
        <CapsuleSection
          capsules={capsules}
          isLoading={isLoading}
          creating={creating}
          actionBusy={actionBusy}
          actionKind={actionKind}
          onCreateCapsule={() => setCreateDialogOpen(true)}
          onStartIndexing={handleStartIndexing}
          onCancelIndexing={handleCancelIndexing}
          onDisconnect={(id) =>
            setDisconnectTarget(capsules.find((capsule) => capsule.id === id) ?? null)
          }
          onOpenHealth={handleOpenHealth}
        />
        <CapsuleSetSection
          capsuleSets={capsuleSets}
          onDelete={setDeleteSetTarget}
          deleteBusyId={capsuleSetActionBusy}
        />
      </section>
      {createDialogOpen ? (
        <CreateCapsuleDialog
          busy={creating}
          error={createError}
          onCancel={() => {
            // Abandoning the dialog also drops its error — otherwise the stale
            // message stuck to the page banner (uiux-fix F032, C230).
            setCreateDialogOpen(false);
            clearCreateError();
          }}
          onSubmit={submitCreateCapsule}
        />
      ) : null}
      {combineDialogOpen ? (
        <CapsuleSetComposeDialog
          capsules={capsules}
          onCancel={() => setCombineDialogOpen(false)}
          onCreated={onSetCreated}
        />
      ) : null}
      {disconnectTarget !== null ? (
        <DisconnectConfirmDialog
          capsuleName={disconnectTarget.displayName}
          onCancel={() => setDisconnectTarget(null)}
          onConfirm={() => {
            handleDisconnect(disconnectTarget.id);
            setDisconnectTarget(null);
          }}
        />
      ) : null}
      {deleteSetTarget !== null ? (
        <DeleteCapsuleSetConfirmDialog
          capsuleSetName={deleteSetTarget.displayName}
          onCancel={() => setDeleteSetTarget(null)}
          onConfirm={() => {
            handleDeleteCapsuleSet(deleteSetTarget.id);
            setDeleteSetTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
