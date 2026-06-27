"use client";

import { useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { GitChangedFile, GitRepositoryStatusResponse } from "@/lib/types";
import { Icons } from "../../../Icons";
import { EMPTY_STATE_STYLE, SUBTLE_TEXT_STYLE } from "./git-client-styles";

export type ChangesTab = "changes" | "history";

// Single-char status glyph, reused vocabulary from FilesWidget gitChangeLabel (contract §2 extend).
function gitChangeLabel(change: GitChangedFile): string {
  if (change.conflicted) return "U";
  if (change.untracked) return "?";
  if (change.indexStatus !== " ") return change.indexStatus;
  return change.worktreeStatus;
}

interface ChangesPaneProps {
  readonly tab: ChangesTab;
  readonly onTabChange: (tab: ChangesTab) => void;
  readonly status: GitRepositoryStatusResponse | null;
  readonly statusLoading: boolean;
  readonly statusError: string | null;
  readonly selectedChangePath: string | null;
  readonly onSelectChange: (path: string) => void;
}

const TABS: readonly { readonly id: ChangesTab; readonly label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "history", label: "History" },
];

export function ChangesPane({
  tab,
  onTabChange,
  status,
  statusLoading,
  statusError,
  selectedChangePath,
  onSelectChange,
}: ChangesPaneProps): ReactNode {
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    const nextTab = TABS[nextIndex];
    if (nextTab === undefined) return;
    onTabChange(nextTab.id);
    const buttons = tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div className="ed-tabs mono">
        <div
          ref={tablistRef}
          className="ed-tablist"
          role="tablist"
          aria-label="Changes and history"
        >
          {TABS.map((entry) => {
            const active = entry.id === tab;
            return (
              <span className={`ed-tab${active ? " active" : ""}`} key={entry.id}>
                <button
                  type="button"
                  className="ed-tab-hit"
                  role="tab"
                  id={`${baseId}-tab-${entry.id}`}
                  aria-selected={active ? "true" : "false"}
                  aria-controls={`${baseId}-panel-${entry.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onTabChange(entry.id)}
                  onKeyDown={onTabKeyDown}
                >
                  <span className="ed-tab-label">{entry.label}</span>
                </button>
              </span>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
      >
        {tab === "changes" ? (
          <ChangesList
            status={status}
            statusLoading={statusLoading}
            statusError={statusError}
            selectedChangePath={selectedChangePath}
            onSelectChange={onSelectChange}
          />
        ) : (
          <div style={EMPTY_STATE_STYLE}>
            <Icons.activity size={20} />
            <p style={SUBTLE_TEXT_STYLE}>Commit history appears here once a commit is selected.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ChangesList({
  status,
  statusLoading,
  statusError,
  selectedChangePath,
  onSelectChange,
}: {
  readonly status: GitRepositoryStatusResponse | null;
  readonly statusLoading: boolean;
  readonly statusError: string | null;
  readonly selectedChangePath: string | null;
  readonly onSelectChange: (path: string) => void;
}): ReactNode {
  if (statusError !== null) {
    return (
      <p className="rv-empty" role="alert" style={{ padding: "var(--space-4)" }}>
        {statusError}
      </p>
    );
  }
  if (statusLoading && status === null) {
    return (
      <p className="rv-empty" role="status" style={{ padding: "var(--space-4)" }}>
        Loading changes…
      </p>
    );
  }
  if (status === null) {
    return (
      <div style={EMPTY_STATE_STYLE}>
        <Icons.git size={20} />
        <p style={SUBTLE_TEXT_STYLE}>Select a repository to view its changes.</p>
      </div>
    );
  }
  if (!status.available) {
    return (
      <div style={EMPTY_STATE_STYLE}>
        <Icons.git size={20} />
        <p style={SUBTLE_TEXT_STYLE}>{status.message ?? "This folder is not a Git repository."}</p>
      </div>
    );
  }
  if (status.clean || status.changes.length === 0) {
    return (
      <div className="rv-empty">
        <p className="rv-empty-p">No changes</p>
      </div>
    );
  }

  return (
    <nav className="rv-filelist" aria-label="Changed files">
      <ul>
        {status.changes.map((change) => {
          const selected = change.path === selectedChangePath;
          return (
            <li key={change.path}>
              <button
                type="button"
                className="rv-filerow"
                title={change.path}
                aria-pressed={selected}
                onClick={() => onSelectChange(change.path)}
              >
                <span className="rv-stat mono" aria-hidden="true">
                  {gitChangeLabel(change)}
                </span>
                <span className="rv-filerow-path mono">{change.path}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
