"use client";

import { useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type {
  GitChangedFile,
  GitHistoryEntry,
  GitHistoryResponse,
  GitRepositoryStatusResponse,
} from "@/lib/types";
import { Icons } from "../../../Icons";
import type { GitMutationOutcome } from "./git-client-seam";
import { MutationOutcome } from "./git-client-ui";
import { HistoryPane } from "./HistoryPane";
import {
  badgeStyle,
  CHANGES_HEADER_STYLE,
  COMPACT_BTN,
  disabledStyle,
  EMPTY_STATE_STYLE,
  FILE_ROW_SELECTED_STYLE,
  FILE_ROW_STYLE,
  FILE_SELECT_BTN_STYLE,
  SUBTLE_TEXT_STYLE,
} from "./git-client-styles";

export type ChangesTab = "changes" | "history";

// Single-char status glyph, reused vocabulary from FilesWidget gitChangeLabel (contract §2 extend).
function gitChangeLabel(change: GitChangedFile): string {
  if (change.conflicted) return "U";
  if (change.untracked) return "?";
  if (change.indexStatus !== " ") return change.indexStatus;
  return change.worktreeStatus;
}

// The indicator badge for a row (text + colour, never colour alone). Conflict and untracked take
// precedence; otherwise the staged / partially-staged state is surfaced for tracked changes.
function changeBadge(
  change: GitChangedFile,
): { readonly text: string; readonly tone: Parameters<typeof badgeStyle>[0] } | null {
  if (change.conflicted) return { text: "Conflict", tone: "danger" };
  if (change.untracked) return { text: "Untracked", tone: "warning" };
  if (change.staged && change.unstaged) return { text: "Partially staged", tone: "accent" };
  if (change.staged) return { text: "Staged", tone: "accent" };
  return null;
}

function gitStatusCodeLabel(status: string): string {
  if (status === "A") return "added";
  if (status === "C") return "copied";
  if (status === "D") return "deleted";
  if (status === "M") return "modified";
  if (status === "R") return "renamed";
  if (status === "T") return "type changed";
  if (status === "U") return "unmerged";
  return `status ${status}`;
}

// Spoken status for the changed-file row (carried from the #1574 audit-gap repair). Conveys the
// staged/worktree state to assistive tech without relying on the single-char glyph alone.
function gitChangeStatusLabel(change: GitChangedFile): string {
  if (change.conflicted) return "conflicted";
  if (change.untracked) return "untracked";
  const staged = change.indexStatus !== " " ? gitStatusCodeLabel(change.indexStatus) : null;
  const worktree = change.worktreeStatus !== " " ? gitStatusCodeLabel(change.worktreeStatus) : null;
  if (staged !== null && worktree !== null) return `staged ${staged}; worktree ${worktree}`;
  if (staged !== null) return `staged ${staged}`;
  if (worktree !== null) return worktree;
  return "changed";
}

interface ChangesPaneProps {
  readonly tab: ChangesTab;
  readonly onTabChange: (tab: ChangesTab) => void;
  readonly status: GitRepositoryStatusResponse | null;
  readonly statusLoading: boolean;
  readonly statusError: string | null;
  readonly selectedChangePath: string | null;
  readonly onSelectChange: (path: string) => void;
  readonly onStageFile: (change: GitChangedFile) => void;
  readonly onUnstageFile: (change: GitChangedFile) => void;
  readonly onStageAll: () => void;
  readonly onUnstageAll: () => void;
  readonly stagingBusy: boolean;
  readonly stagingOutcome: GitMutationOutcome | null;
  readonly stagingError: string | null;
  readonly history: GitHistoryResponse | null;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  readonly selectedCommitSha: string | null;
  readonly onSelectCommit: (entry: GitHistoryEntry) => void;
  /** Commit composer, pinned beneath the changed-file list on the Changes tab. */
  readonly commitComposer: ReactNode;
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
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  stagingBusy,
  stagingOutcome,
  stagingError,
  history,
  historyLoading,
  historyError,
  selectedCommitSha,
  onSelectCommit,
  commitComposer,
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
        id={`${baseId}-panel-changes`}
        aria-labelledby={`${baseId}-tab-changes`}
        hidden={tab !== "changes"}
        style={{
          display: tab === "changes" ? "flex" : "none",
          flexDirection: "column",
          minHeight: 0,
          flex: 1,
        }}
      >
        <ChangesList
          status={status}
          statusLoading={statusLoading}
          statusError={statusError}
          selectedChangePath={selectedChangePath}
          onSelectChange={onSelectChange}
          onStageFile={onStageFile}
          onUnstageFile={onUnstageFile}
          onStageAll={onStageAll}
          onUnstageAll={onUnstageAll}
          stagingBusy={stagingBusy}
          stagingOutcome={stagingOutcome}
          stagingError={stagingError}
        />
        {commitComposer}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-history`}
        aria-labelledby={`${baseId}-tab-history`}
        hidden={tab !== "history"}
        style={{
          display: tab === "history" ? "flex" : "none",
          flexDirection: "column",
          minHeight: 0,
          flex: 1,
        }}
      >
        <HistoryPane
          history={history}
          loading={historyLoading}
          error={historyError}
          selectedSha={selectedCommitSha}
          onSelect={onSelectCommit}
        />
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
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  stagingBusy,
  stagingOutcome,
  stagingError,
}: {
  readonly status: GitRepositoryStatusResponse | null;
  readonly statusLoading: boolean;
  readonly statusError: string | null;
  readonly selectedChangePath: string | null;
  readonly onSelectChange: (path: string) => void;
  readonly onStageFile: (change: GitChangedFile) => void;
  readonly onUnstageFile: (change: GitChangedFile) => void;
  readonly onStageAll: () => void;
  readonly onUnstageAll: () => void;
  readonly stagingBusy: boolean;
  readonly stagingOutcome: GitMutationOutcome | null;
  readonly stagingError: string | null;
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
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <Icons.git size={20} />
        <p style={SUBTLE_TEXT_STYLE}>Select a repository to view its changes.</p>
      </div>
    );
  }
  if (!status.available) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <Icons.git size={20} />
        <p style={SUBTLE_TEXT_STYLE}>{status.message ?? "This folder is not a Git repository."}</p>
      </div>
    );
  }
  if (status.detached) {
    return (
      <div style={EMPTY_STATE_STYLE} role="alert" aria-live="assertive">
        <Icons.branch size={20} />
        <p style={SUBTLE_TEXT_STYLE}>
          Detached HEAD. Switch to an existing branch or create a branch before committing or syncing.
        </p>
      </div>
    );
  }

  const hasChanges = !status.clean && status.changes.length > 0;
  const bulkActionsBlocked = stagingBusy || status.truncated;
  const hasStaged = status.stagedCount > 0 && !status.truncated;
  const hasUnstaged = (status.unstagedCount > 0 || status.untrackedCount > 0) && !status.truncated;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {status.conflictedCount > 0 ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-3) var(--space-4)",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--feedback-danger)",
            background: "color-mix(in oklch, var(--feedback-danger) 10%, var(--surface-primary))",
            font: "var(--text-body-sm) var(--font-ui)",
          }}
        >
          <Icons.info size={14} />
          Resolve conflicted files before committing or syncing.
        </div>
      ) : null}
      {hasChanges ? (
        <div style={CHANGES_HEADER_STYLE}>
          <span style={{ ...SUBTLE_TEXT_STYLE, flex: 1, minWidth: 0 }}>
            {`${status.changes.length.toString()} changed · ${status.stagedCount.toString()} staged`}
          </span>
          <button
            type="button"
            style={{ ...COMPACT_BTN, ...disabledStyle(bulkActionsBlocked || !hasUnstaged) }}
            disabled={bulkActionsBlocked || !hasUnstaged}
            onClick={onStageAll}
          >
            <Icons.check size={11} /> Stage all
          </button>
          <button
            type="button"
            style={{ ...COMPACT_BTN, ...disabledStyle(bulkActionsBlocked || !hasStaged) }}
            disabled={bulkActionsBlocked || !hasStaged}
            onClick={onUnstageAll}
          >
            <Icons.reset size={11} /> Unstage all
          </button>
        </div>
      ) : null}

      {stagingError !== null || stagingOutcome !== null ? (
        <div style={{ padding: "var(--space-3) var(--space-4) 0" }}>
          <MutationOutcome
            outcome={stagingOutcome}
            error={stagingError}
            testid="git-staging-outcome"
          />
        </div>
      ) : null}

      {status.truncated ? (
        <p
          style={{ ...SUBTLE_TEXT_STYLE, padding: "var(--space-3) var(--space-4) 0" }}
          role="status"
        >
          Showing the first {status.maxChanges.toString()} changes; the list is truncated.
        </p>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {status.clean || status.changes.length === 0 ? (
          <div className="rv-empty">
            <p className="rv-empty-p">No changes</p>
          </div>
        ) : (
          <nav className="rv-filelist" aria-label="Changed files">
            <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-2)" }}>
              {status.changes.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  selected={change.path === selectedChangePath}
                  stagingBusy={stagingBusy}
                  onSelect={() => onSelectChange(change.path)}
                  onToggleStage={() =>
                    change.staged ? onUnstageFile(change) : onStageFile(change)
                  }
                />
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}

function ChangeRow({
  change,
  selected,
  stagingBusy,
  onSelect,
  onToggleStage,
}: {
  readonly change: GitChangedFile;
  readonly selected: boolean;
  readonly stagingBusy: boolean;
  readonly onSelect: () => void;
  readonly onToggleStage: () => void;
}): ReactNode {
  const badge = changeBadge(change);
  const statusLabel = gitChangeStatusLabel(change);
  const toggleLabel = `${change.staged ? "Unstage" : "Stage"} ${change.path}`;
  return (
    <li
      style={{
        ...FILE_ROW_STYLE,
        ...(selected ? FILE_ROW_SELECTED_STYLE : null),
      }}
    >
      <input
        type="checkbox"
        checked={change.staged}
        disabled={stagingBusy}
        onChange={onToggleStage}
        aria-label={toggleLabel}
        title={toggleLabel}
      />
      <button
        type="button"
        style={FILE_SELECT_BTN_STYLE}
        title={change.path}
        aria-label={`${change.path}, ${statusLabel}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="rv-stat mono" aria-hidden="true">
          {gitChangeLabel(change)}
        </span>
        <span className="rv-filerow-path mono">
          <span className="rv-sr-only">{statusLabel} </span>
          {change.path}
        </span>
      </button>
      {badge !== null ? <span style={badgeStyle(badge.tone)}>{badge.text}</span> : null}
    </li>
  );
}
