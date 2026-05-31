"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchWorkspaceSummary, ApiError } from "@/lib/api";
import type { WorkspaceSummary, ContextEntrySummary } from "@/lib/types";
import { workspaceErrorMessage } from "@/lib/workspace-error-messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilesPanelProps {
  project: { path: string; name: string };
  onClose: () => void;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; summary: WorkspaceSummary };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateMiddle(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

// ---------------------------------------------------------------------------
// Skeleton row
// ---------------------------------------------------------------------------

function SkeletonRow(): ReactNode {
  return (
    <div className="flex gap-2">
      <div className="h-3.5 w-24 animate-pulse rounded bg-elevated" />
      <div className="h-3.5 w-32 animate-pulse rounded bg-elevated" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context entry list (first 5 entries only — structural metadata, no content)
// ---------------------------------------------------------------------------

interface EntryListProps {
  entries: readonly ContextEntrySummary[];
}

function EntryList({ entries }: EntryListProps): ReactNode {
  const visible = entries.slice(0, 5);
  return (
    <ol className="mt-2 space-y-1 text-xs text-ink-muted">
      {visible.map((e) => (
        <li key={e.path} className="flex items-center justify-between gap-2 font-mono">
          <span className="min-w-0 flex-1 truncate" title={e.path}>
            {truncateMiddle(e.path, 36)}
          </span>
          <span className="shrink-0 tabular-nums">{formatBytes(e.sizeBytes)}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// FilesPanel
// ---------------------------------------------------------------------------

const PANEL_HEADING_ID = "files-panel-heading";

/**
 * Displays a redacted workspace summary for the selected project.
 * Fetches /api/workspace?dir=<project.path> on mount and on project change.
 */
export function FilesPanel({ project, onClose }: FilesPanelProps): ReactNode {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus on mount for screen-reader announcement.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Fetch workspace summary when project changes.
  useEffect(() => {
    setState({ kind: "loading" });
    let active = true;
    void fetchWorkspaceSummary({ dir: project.path })
      .then(({ summary }) => {
        if (!active) return;
        setState({ kind: "data", summary });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiError
            ? workspaceErrorMessage(err.code)
            : "Could not load workspace information.";
        setState({ kind: "error", message });
      });
    return () => {
      active = false;
    };
  }, [project.path]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={PANEL_HEADING_ID}
      className="flex w-72 flex-col overflow-hidden bg-panel focus:outline-none
        focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      style={{ borderLeft: "1px solid #3a4052" }}
    >
      {/* Panel header */}
      <header className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid #3a4052" }}>
        <h2 id={PANEL_HEADING_ID} className="text-sm font-semibold text-ink">
          Files
        </h2>
        <button
          type="button"
          aria-label="Close Files panel"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded text-ink-muted
            hover:bg-elevated hover:text-ink
            focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </header>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {state.kind === "loading" && (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading project files"
            className="space-y-3"
          >
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        )}

        {state.kind === "error" && (
          <div
            role="alert"
            className="rounded bg-elevated px-3 py-2 text-sm text-ink"
          >
            {state.message}
          </div>
        )}

        {state.kind === "data" && <SummaryView summary={state.summary} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryView — renders WorkspaceSummary as a definition list
// ---------------------------------------------------------------------------

interface SummaryViewProps {
  summary: WorkspaceSummary;
}

function SummaryView({ summary }: SummaryViewProps): ReactNode {
  const ctx = summary.context;

  return (
    <div className="space-y-4 text-xs">
      <dl className="space-y-2">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Name</dt>
          <dd className="text-right text-ink">{summary.name ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Version</dt>
          <dd className="text-right text-ink">{summary.version ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Test framework</dt>
          <dd className="text-right text-ink">{summary.testFramework}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Languages</dt>
          <dd className="text-right text-ink">{summary.languages.join(", ") || "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Source dirs</dt>
          <dd className="text-right text-ink">{[...summary.sourceDirs].join(", ") || "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Test dirs</dt>
          <dd className="text-right text-ink">{[...summary.testDirs].join(", ") || "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-muted">Files</dt>
          <dd className="text-right text-ink">
            {summary.counts.discovered} discovered,{" "}
            {summary.counts.denied} denied,{" "}
            {summary.counts.ignored} ignored
          </dd>
        </div>

        {ctx && (
          <div className="flex justify-between gap-2">
            <dt className="text-ink-muted">Context pack</dt>
            <dd className="text-right text-ink">
              {ctx.entries.length} entries · {formatBytes(ctx.usedBytes)} of{" "}
              {formatBytes(ctx.budgetBytes)}
            </dd>
          </div>
        )}
      </dl>

      {ctx && ctx.entries.length > 0 && (
        <section aria-label="Context pack entries">
          <p className="mb-1 text-ink-dim">Top entries</p>
          <EntryList entries={ctx.entries} />
        </section>
      )}
    </div>
  );
}

export default FilesPanel;
