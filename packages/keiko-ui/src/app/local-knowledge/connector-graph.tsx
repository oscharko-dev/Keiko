"use client";

// Issue #197 — Connector graph render layer (CSS classes from globals.css).
// State lives in connector-graph-state.ts; types in connector-graph-types.ts.
//
// WCAG: lk-btn-primary uses #06281b on var(--accent) (>4.5:1). Danger text is
// var(--danger) on near-black backgrounds. Focus rings are in globals.css via
// .lk-btn:focus-visible. Min 30×30 target size exceeds WCAG 2.5.8 (24×24).

import type { ReactNode } from "react";
import type { KnowledgeCapsuleId, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import type { CapsuleListEntry, ConnectorGraphProps } from "./connector-graph-types";
import { STATUS_LABELS } from "./connector-graph-types";
import { useConnectorGraph } from "./connector-graph-state";

// ---------------------------------------------------------------------------
// AlertBanner
// ---------------------------------------------------------------------------

function AlertBanner({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
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
    </div>
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
  return (
    <div role="listitem" className="lk-node" data-connected={String(connected)}>
      <span aria-hidden="true" className="lk-node-icon">
        {NODE_ICON[kind]}
      </span>
      <div>
        <div className="lk-node-label">{label}</div>
        {sublabel !== undefined ? <div className="lk-node-sub">{sublabel}</div> : null}
      </div>
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
        <GraphNode kind="files-window" label="Files Window" sublabel="Source" connected={hasAny} />
        <ConnectorEdgeSvg />
        <GraphNode
          kind="local-knowledge"
          label="Local Knowledge"
          sublabel="Connector"
          connected={hasAny}
        />
        <ConnectorEdgeSvg />
        <GraphNode
          kind="capsule-pool"
          label="Capsules"
          sublabel={capsuleSublabel(capsules.length, isLoading)}
          connected={hasAny}
        />
        <ConnectorEdgeSvg />
        <GraphNode
          kind="conversation-center"
          label="Conversation Center"
          sublabel="Consumer"
          connected={hasReady}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ state }: { state: CapsuleLifecycleState }): ReactNode {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Status: ${STATUS_LABELS[state]}`}
      className="lk-badge"
      data-state={state}
    >
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
  readonly onStart: (id: KnowledgeCapsuleId) => void;
  readonly onCancel: (id: KnowledgeCapsuleId) => void;
  readonly onDisconnect: (id: KnowledgeCapsuleId) => void;
  readonly onHealth: (id: KnowledgeCapsuleId) => void;
}

function IndexOrCancelBtn({
  capsule,
  busy,
  onStart,
  onCancel,
}: Pick<RowActionProps, "capsule" | "busy" | "onStart" | "onCancel">): ReactNode {
  const { id, displayName, lifecycleState } = capsule;
  if (lifecycleState === "indexing") {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={`Cancel indexing for capsule ${displayName}`}
        onClick={() => {
          onCancel(id);
        }}
        className="lk-btn lk-btn-ghost"
      >
        Cancel
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`Start indexing capsule ${displayName}`}
      onClick={() => {
        onStart(id);
      }}
      className="lk-btn lk-btn-primary"
    >
      Index
    </button>
  );
}

function CapsuleRowActions({
  capsule,
  busy,
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
      <IndexOrCancelBtn capsule={capsule} busy={busy} onStart={onStart} onCancel={onCancel} />
      <button
        type="button"
        disabled={busy}
        aria-label={`Open health view for capsule ${displayName}`}
        onClick={() => {
          onHealth(id);
        }}
        className="lk-btn lk-btn-ghost"
      >
        Health
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Disconnect capsule ${displayName}`}
        onClick={() => {
          onDisconnect(id);
        }}
        className="lk-btn lk-btn-danger"
      >
        Disconnect
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
        <div className="lk-capsule-name">{capsule.displayName}</div>
        <StatusBadge state={capsule.lifecycleState} />
      </div>
      <CapsuleRowActions
        capsule={capsule}
        busy={busy}
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
      <button
        type="button"
        disabled
        aria-label="Connect to an existing capsule"
        title="Existing-capsule connection is unavailable until the Local Knowledge BFF is wired."
        className="lk-btn lk-btn-ghost lk-btn-lg"
      >
        Connect to existing capsule
      </button>
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
  readonly loadStatus: string;
  readonly loadError: string | null;
  readonly actionError: string | null;
  readonly createError: string | null;
  readonly reload: () => void;
  readonly onCreateCapsule: () => void;
}

function GraphPageHeader({
  creating,
  loadStatus,
  loadError,
  actionError,
  createError,
  reload,
  onCreateCapsule,
}: GraphPageHeaderProps): ReactNode {
  return (
    <>
      <header className="lk-header">
        <h1 className="lk-title">Local Knowledge Connector</h1>
        <button
          type="button"
          disabled={creating}
          aria-label="Create a new knowledge capsule"
          onClick={onCreateCapsule}
          className="lk-btn lk-btn-primary lk-btn-lg"
        >
          {creating ? "Creating…" : "Create capsule"}
        </button>
      </header>
      {loadStatus === "error" && loadError !== null ? (
        <AlertBanner message={loadError} onRetry={reload} />
      ) : null}
      {createError !== null ? <AlertBanner message={createError} /> : null}
      {actionError !== null ? <AlertBanner message={actionError} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ConnectorGraph — root export
// ---------------------------------------------------------------------------

export function ConnectorGraph(props: ConnectorGraphProps): ReactNode {
  const {
    capsules,
    loadStatus,
    loadError,
    actionBusy,
    actionError,
    creating,
    createError,
    reload,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
    handleCreateCapsule,
  } = useConnectorGraph(props);
  const isLoading = loadStatus === "loading";

  return (
    <div className="lk-page">
      <GraphPageHeader
        creating={creating}
        loadStatus={loadStatus}
        loadError={loadError}
        actionError={actionError}
        createError={createError}
        reload={reload}
        onCreateCapsule={handleCreateCapsule}
      />
      <PipelineDiagram capsules={capsules} isLoading={isLoading} />
      <section
        aria-label="Knowledge capsules"
        aria-live="polite"
        aria-busy={isLoading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <h2 className="lk-section-head">Knowledge Capsules</h2>
        <CapsuleSection
          capsules={capsules}
          isLoading={isLoading}
          creating={creating}
          actionBusy={actionBusy}
          onCreateCapsule={handleCreateCapsule}
          onStartIndexing={handleStartIndexing}
          onCancelIndexing={handleCancelIndexing}
          onDisconnect={handleDisconnect}
          onOpenHealth={handleOpenHealth}
        />
      </section>
    </div>
  );
}
