"use client";

import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { GitHistoryEntry, GitHistoryResponse } from "@/lib/types";
import { Icons } from "../../../Icons";
import {
  EMPTY_STATE_STYLE,
  LIST_STYLE,
  REPO_OPTION_SELECTED_STYLE,
  REPO_OPTION_STYLE,
  SUBTLE_TEXT_STYLE,
} from "./git-client-styles";

interface HistoryPaneProps {
  readonly history: GitHistoryResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedSha: string | null;
  readonly onSelect: (entry: GitHistoryEntry) => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function HistoryPane({
  history,
  loading,
  error,
  selectedSha,
  onSelect,
}: HistoryPaneProps): ReactNode {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const entries = history?.entries ?? [];

  const moveFocus = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, entries.length - 1));
    refs.current[clamped]?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(entries.length - 1);
    }
  };

  if (error !== null) {
    return (
      <p className="rv-empty" role="alert" style={{ padding: "var(--space-4)" }}>
        {error}
      </p>
    );
  }
  if (loading && history === null) {
    return (
      <p className="rv-empty" role="status" style={{ padding: "var(--space-4)" }}>
        Loading history…
      </p>
    );
  }
  if (history === null) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <Icons.activity size={20} />
        <p style={SUBTLE_TEXT_STYLE}>Commit history appears after selecting a repository.</p>
      </div>
    );
  }
  if (!history.available) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <Icons.activity size={20} />
        <p style={SUBTLE_TEXT_STYLE}>History is unavailable for this repository.</p>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <Icons.activity size={20} />
        <p style={SUBTLE_TEXT_STYLE}>No commits yet. Make a commit to start history.</p>
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label="Commit history"
      style={{ ...LIST_STYLE, padding: "var(--space-3)" }}
    >
      {entries.map((entry, index) => {
        const selected = entry.sha === selectedSha;
        return (
          <button
            key={entry.sha}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="option"
            aria-selected={selected}
            style={{
              ...REPO_OPTION_STYLE,
              ...(selected ? REPO_OPTION_SELECTED_STYLE : {}),
            }}
            onClick={() => onSelect(entry)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span
              style={{
                display: "block",
                font: "var(--weight-semibold) var(--text-body-sm) var(--font-ui)",
              }}
            >
              {entry.subject}
            </span>
            <span className="mono" style={{ display: "block", color: "var(--text-secondary)" }}>
              {entry.shortSha} · {entry.author} · {formatDate(entry.date)}
            </span>
            <span style={{ display: "block", color: "var(--text-secondary)" }}>
              {entry.changedFileCount.toString()}{" "}
              {entry.changedFileCount === 1 ? "file changed" : "files changed"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function HistoryCommitDetail({
  entry,
}: {
  readonly entry: GitHistoryEntry;
}): ReactNode {
  return (
    <div className="rv-empty" role="region" aria-label="Commit details">
      <h2 className="rv-empty-h">{entry.subject}</h2>
      <p className="rv-empty-p">
        {entry.author} · {formatDate(entry.date)}
      </p>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content minmax(0, 1fr)",
          gap: "var(--space-2) var(--space-4)",
          width: "min(560px, 100%)",
          textAlign: "left",
          font: "var(--text-body-sm) var(--font-ui)",
        }}
      >
        <dt>Commit</dt>
        <dd className="mono" style={{ margin: 0, overflowWrap: "anywhere" }}>
          {entry.sha}
        </dd>
        <dt>Short SHA</dt>
        <dd className="mono" style={{ margin: 0 }}>
          {entry.shortSha}
        </dd>
        <dt>Parents</dt>
        <dd style={{ margin: 0 }}>{entry.parentCount.toString()}</dd>
        <dt>Changed files</dt>
        <dd style={{ margin: 0 }}>{entry.changedFileCount.toString()}</dd>
        <dt>Refs</dt>
        <dd style={{ margin: 0 }}>{entry.refs.length === 0 ? "None" : entry.refs.join(", ")}</dd>
      </dl>
    </div>
  );
}
