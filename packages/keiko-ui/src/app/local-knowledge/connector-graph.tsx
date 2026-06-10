"use client";

// Issue #197 — Connector graph render layer (CSS classes from globals.css).
// State lives in connector-graph-state.ts; types in connector-graph-types.ts.
//
// WCAG: lk-btn-primary uses #06281b on var(--accent) (>4.5:1). Danger text is
// var(--danger) on near-black backgrounds. Focus rings are in globals.css via
// .lk-btn:focus-visible. Min 30×30 target size exceeds WCAG 2.5.8 (24×24).

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import type { CapsuleListEntry, ConnectorGraphProps, RowActionKind } from "./connector-graph-types";
import { STATUS_LABELS } from "./connector-graph-types";
import { useConnectorGraph } from "./connector-graph-state";
import { CapsuleSetComposeDialog } from "./capsule-set-compose";

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
          aria-label="Retry loading capsules"
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

function CreateCapsuleDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
}): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

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
      setValidationError("Capsule display name is required.");
      return;
    }
    setValidationError(null);
    await onSubmit(trimmed);
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
          Create capsule
        </h2>
        {/* Copy used to promise "creates and indexes it" — POST /capsules only
            creates a Draft; indexing is a separate step on the capsule page
            (uiux-fix F032, C232). */}
        <p id={descriptionId} className="mc-dialog-body">
          Name the capsule. After creating it, connect a source and start indexing from the capsule
          page.
        </p>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label className="mc-dialog-field" htmlFor={inputId}>
            <span className="mc-dialog-label">Capsule display name</span>
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
              {busy ? "Creating…" : "Create capsule"}
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
          Disconnect capsule
        </h2>
        <p id={descriptionId} className="mc-dialog-body">
          Disconnect &quot;{capsuleName}&quot;? The capsule keeps its index, but the source link is
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
// ConnectorEdgeSvg
// ---------------------------------------------------------------------------

function ConnectorEdgeSvg(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="40"
      height="24"
      viewBox="0 0 40 24"
      style={{ flexShrink: 0, alignSelf: "center" }}
    >
      <path
        d="M2 12 H32 M28 6 L38 12 L28 18"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity="0.7"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// GraphNode
// ---------------------------------------------------------------------------

type GraphNodeKind = "files-window" | "local-knowledge" | "capsule-pool" | "conversation-center";

const NODE_ICON: Record<GraphNodeKind, string> = {
  "files-window": "📂",
  "local-knowledge": "🧠",
  "capsule-pool": "⬡",
  "conversation-center": "💬",
};

function GraphNode({
  kind,
  label,
  sublabel,
  connected = false,
}: {
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  connected?: boolean;
}): ReactNode {
  // Connected state used to live only in the border colour (data-connected);
  // the tick is a second, non-colour cue and the sr-only text carries it into
  // the accessibility tree (uiux-fix F032, C228).
  return (
    <div className="lk-node" data-connected={String(connected)}>
      <span aria-hidden="true" className="lk-node-icon">
        {NODE_ICON[kind]}
      </span>
      <div>
        <div className="lk-node-label">
          {label}
          {connected ? (
            <span aria-hidden="true" className="lk-node-tick">
              ✓
            </span>
          ) : null}
        </div>
        {sublabel !== undefined ? <div className="lk-node-sub">{sublabel}</div> : null}
        <span className="visually-hidden">{connected ? "Connected" : "Not connected"}</span>
      </div>
    </div>
  );
}

// Keeps each node and its outgoing arrow on the same flex line: as bare
// siblings inside the wrapping .lk-pipeline an arrow could break alone onto
// the next line and point at nothing (uiux-fix F032, C370).
function PipelineSegment({ children }: { children: ReactNode }): ReactNode {
  return (
    <div role="listitem" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineDiagram
// ---------------------------------------------------------------------------

function capsuleSublabel(count: number, loading: boolean): string {
  if (loading) return "Loading…";
  if (count === 0) return "No capsules";
  return `${count.toString()} capsule${count === 1 ? "" : "s"}`;
}

function PipelineDiagram({
  capsules,
  isLoading,
}: {
  capsules: readonly CapsuleListEntry[];
  isLoading: boolean;
}): ReactNode {
  const hasReady = capsules.some((c) => c.lifecycleState === "ready");
  const hasAny = capsules.length > 0;
  return (
    <section aria-label="Connector pipeline diagram" style={{ flexShrink: 0 }}>
      <div role="list" aria-label="Pipeline nodes" className="lk-pipeline">
        <PipelineSegment>
          <GraphNode
            kind="files-window"
            label="Files Window"
            sublabel="Source"
            connected={hasAny}
          />
          <ConnectorEdgeSvg />
        </PipelineSegment>
        <PipelineSegment>
          <GraphNode
            kind="local-knowledge"
            label="Local Knowledge"
            sublabel="Connector"
            connected={hasAny}
          />
          <ConnectorEdgeSvg />
        </PipelineSegment>
        <PipelineSegment>
          <GraphNode
            kind="capsule-pool"
            label="Capsules"
            sublabel={capsuleSublabel(capsules.length, isLoading)}
            connected={hasAny}
          />
          <ConnectorEdgeSvg />
        </PipelineSegment>
        <PipelineSegment>
          <GraphNode
            kind="conversation-center"
            label="Conversation Center"
            sublabel="Consumer"
            connected={hasReady}
          />
        </PipelineSegment>
      </div>
    </section>
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
}

function IndexOrCancelBtn({
  capsule,
  busy,
  busyKind,
  onStart,
  onCancel,
}: Pick<RowActionProps, "capsule" | "busy" | "busyKind" | "onStart" | "onCancel">): ReactNode {
  const { id, displayName, lifecycleState } = capsule;
  if (lifecycleState === "indexing") {
    return (
      <button
        type="button"
        disabled={busy}
        aria-busy={busyKind === "cancel"}
        aria-label={`Cancel indexing for capsule ${displayName}`}
        onClick={() => {
          onCancel(id);
        }}
        className="lk-btn lk-btn-ghost"
      >
        {busyKind === "cancel" ? "Cancelling…" : "Cancel"}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busyKind === "index"}
      aria-label={`Start indexing capsule ${displayName}`}
      onClick={() => {
        onStart(id);
      }}
      className="lk-btn lk-btn-primary"
    >
      {busyKind === "index" ? "Indexing…" : "Index"}
    </button>
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
}: RowActionProps): ReactNode {
  const { id, displayName } = capsule;
  return (
    <div
      role="group"
      aria-label={`Actions for capsule ${displayName}`}
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
        aria-label={`Open details for capsule ${displayName}`}
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
        aria-label={`Disconnect capsule ${displayName}`}
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

function CapsuleRow({
  capsule,
  busy,
  busyKind,
  onStart,
  onCancel,
  onDisconnect,
  onHealth,
}: RowActionProps): ReactNode {
  return (
    <article aria-label={`Capsule: ${capsule.displayName}`} className="lk-capsule-row">
      <span aria-hidden="true" className="lk-capsule-icon">
        ⬡
      </span>
      <div className="lk-capsule-info">
        <div className="lk-capsule-name" title={capsule.displayName}>
          {capsule.displayName}
        </div>
        <StatusBadge state={capsule.lifecycleState} />
      </div>
      <CapsuleRowActions
        capsule={capsule}
        busy={busy}
        busyKind={busyKind}
        onStart={onStart}
        onCancel={onCancel}
        onDisconnect={onDisconnect}
        onHealth={onHealth}
      />
    </article>
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
        <p className="lk-empty-title">No capsules yet</p>
        <p className="lk-empty-body">
          Create a capsule to start indexing your local knowledge sources.
        </p>
      </div>
      <button
        type="button"
        disabled={creating}
        aria-label="Create your first knowledge capsule"
        onClick={onCreateCapsule}
        className="lk-btn lk-btn-primary lk-btn-xl"
      >
        {creating ? "Creating…" : "Create your first capsule"}
      </button>
      {/* The permanently-disabled "Connect to existing capsule" button (with a
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
        Loading capsules…
      </p>
    );
  }
  if (capsules.length === 0) {
    return <EmptyState creating={creating} onCreateCapsule={onCreateCapsule} />;
  }
  return (
    <ul
      aria-label="Knowledge capsule list"
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
          />
        </li>
      ))}
    </ul>
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
        <h1 className="lk-title">Local Knowledge Connector</h1>
        <div className="lk-header-actions">
          {/* Declared exit back to the desktop shell — the route is reachable
              from the LeftRail but had no way back (uiux-fix F032, C056). */}
          <Link href="/" className="lk-btn lk-btn-ghost lk-btn-lg">
            Back to Workspace
          </Link>
          {/* aria-disabled instead of native disabled: the button stays
              focusable, so keyboard/SR users can reach the reason why it is
              inactive (uiux-fix F032, C227). */}
          <button
            type="button"
            aria-disabled={combineDisabled}
            aria-describedby={combineDisabled ? combineHintId : undefined}
            aria-label="Combine capsules into a set"
            aria-haspopup="dialog"
            aria-expanded={combineDialogOpen}
            title={
              combineDisabled ? "Create capsules first, then combine them into a set." : undefined
            }
            onClick={() => {
              if (!combineDisabled) onCombineCapsules();
            }}
            className="lk-btn lk-btn-ghost lk-btn-lg"
          >
            Combine capsules
          </button>
          {combineDisabled ? (
            <span id={combineHintId} className="visually-hidden">
              Create capsules first, then combine them into a set.
            </span>
          ) : null}
          <button
            type="button"
            disabled={creating}
            aria-label="Create a new knowledge capsule"
            aria-haspopup="dialog"
            aria-expanded={createDialogOpen}
            onClick={onCreateCapsule}
            className="lk-btn lk-btn-primary lk-btn-lg"
          >
            {creating ? "Creating…" : "Create capsule"}
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
function capsuleAnnouncement(capsules: readonly CapsuleListEntry[]): string {
  const indexing = capsules.filter((c) => c.lifecycleState === "indexing").length;
  const base = `${capsules.length.toString()} capsule${capsules.length === 1 ? "" : "s"}`;
  return indexing > 0 ? `${base}, ${indexing.toString()} indexing` : base;
}

export function ConnectorGraph(props: ConnectorGraphProps): ReactNode {
  const {
    capsules,
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
  } = useConnectorGraph(props);
  const isLoading = loadStatus === "loading";
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  // Disconnect is destructive (removes the source link, no undo) — ask first
  // instead of firing the DELETE straight from the row button (uiux-fix F033, C064).
  const [disconnectTarget, setDisconnectTarget] = useState<CapsuleListEntry | null>(null);

  async function submitCreateCapsule(name: string): Promise<void> {
    try {
      await handleCreateCapsule(name);
      setCreateDialogOpen(false);
    } catch {
      // The state hook surfaces the error message; keep the dialog open for correction/retry.
    }
  }

  function onSetCreated(): void {
    setCombineDialogOpen(false);
    reload();
  }

  return (
    <div className="lk-page">
      <GraphPageHeader
        creating={creating}
        createDialogOpen={createDialogOpen}
        combineDialogOpen={combineDialogOpen}
        combineDisabled={isLoading || capsules.length === 0}
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
      <PipelineDiagram capsules={capsules} isLoading={isLoading} />
      {/* Compact live region instead of aria-live on the whole list section —
          re-announcing every row after each reload flooded screen readers
          (uiux-fix F032, C226; pattern of MemoryList). */}
      <p role="status" className="visually-hidden">
        {!isLoading && loadError === null ? capsuleAnnouncement(capsules) : null}
      </p>
      <section
        aria-label="Knowledge capsules"
        aria-busy={isLoading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <h2 className="lk-section-head">Knowledge Capsules</h2>
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
    </div>
  );
}
