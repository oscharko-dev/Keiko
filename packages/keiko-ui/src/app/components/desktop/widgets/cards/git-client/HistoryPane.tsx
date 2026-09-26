"use client";

import { useRef } from "react";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { GitHistoryEntry, GitHistoryResponse } from "@/lib/types";
import { Icons } from "../../../Icons";
import { NATIVE_LIST_KEEP_PADDING_STYLE } from "../../../native-element-styles";
import {
  avatarStyle,
  commitRowStyle,
  EMPTY_STATE_STYLE,
  HEAD_PILL_STYLE,
  HISTORY_LIST_STYLE,
  LOADING_STATE_STYLE,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
} from "./git-client-styles";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const ActivityIcon = Icons.activity;

interface HistoryPaneProps {
  readonly history: GitHistoryResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadingMore: boolean;
  readonly loadMoreError: string | null;
  readonly onLoadMore: () => void;
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

function authorInitials(author: string): string {
  return author.slice(0, 2).toUpperCase();
}

// The decoration list carries "HEAD" / "HEAD -> branch" when the commit is the current tip.
function isHeadCommit(entry: GitHistoryEntry): boolean {
  return entry.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD"));
}

function loadMoreLabel(
  loadingMore: boolean,
  loadMoreError: string | null,
  t: OptionalWidgetTranslate,
): string {
  if (loadingMore) return t("gitClientWindow.history.loadingMore");
  if (loadMoreError === null) return t("gitClientWindow.history.loadMore");
  return t("gitClientWindow.history.retryLoadMore");
}

export function HistoryPane({
  history,
  loading,
  error,
  loadingMore,
  loadMoreError,
  onLoadMore,
  selectedSha,
  onSelect,
}: HistoryPaneProps): ReactNode {
  const t = useOptionalWidgetTranslate();
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
      <p className="rv-empty" role="alert" style={{ padding: 14 }}>
        {error}
      </p>
    );
  }
  if (loading && history === null) {
    return (
      <output className="rv-empty" style={LOADING_STATE_STYLE}>
        Loading history…
      </output>
    );
  }
  if (history === null) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <ActivityIcon size={20} />
        <p style={SUBTLE_TEXT_STYLE}>Commit history appears after selecting a repository.</p>
      </div>
    );
  }
  if (!history.available) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <ActivityIcon size={20} />
        <p style={SUBTLE_TEXT_STYLE}>History is unavailable for this repository.</p>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div style={EMPTY_STATE_STYLE} role="status" aria-live="polite">
        <ActivityIcon size={20} />
        <p style={SUBTLE_TEXT_STYLE}>No commits yet. Make a commit to start history.</p>
      </div>
    );
  }

  return (
    <>
      {/* The server reports when it capped the read. Without this the list silently claims to be the
          whole history — the same truncation the Changes and Diff panes already label. */}
      {history.truncated ? (
        <output
          className="rv-truncated"
          style={{ ...SUBTLE_TEXT_STYLE, display: "block", padding: "8px 14px 0", fontSize: 12 }}
        >
          {t("gitClientWindow.history.truncated", { count: entries.length })}
        </output>
      ) : null}
      <ul
        aria-label="Commit history"
        style={{ ...NATIVE_LIST_KEEP_PADDING_STYLE, ...HISTORY_LIST_STYLE }}
      >
        {entries.map((entry, index) => {
          const selected = entry.sha === selectedSha;
          const head = isHeadCommit(entry);
          return (
            <li key={entry.sha} style={{ display: "contents" }}>
              <button
                ref={(node) => {
                  refs.current[index] = node;
                }}
                type="button"
                aria-current={selected ? "true" : undefined}
                style={commitRowStyle(selected)}
                onClick={() => onSelect(entry)}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <span aria-hidden="true" style={{ ...avatarStyle(28), fontSize: 10.5 }}>
                  {authorInitials(entry.author)}
                </span>
                <span
                  style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--fg)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      lineHeight: 1.3,
                    }}
                  >
                    {entry.subject}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      fontSize: 11,
                      color: "var(--fg-faint)",
                    }}
                  >
                    <span className="mono" style={{ color: "var(--fg-muted)" }}>
                      {entry.shortSha}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{entry.author}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDate(entry.date)}</span>
                    {head ? <span style={HEAD_PILL_STYLE}>HEAD</span> : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px 14px",
        }}
      >
        {history.truncated ? (
          <>
            {loadMoreError === null ? null : (
              <p role="alert" style={{ ...SUBTLE_TEXT_STYLE, color: "var(--danger)", margin: 0 }}>
                {loadMoreError}
              </p>
            )}
            <button
              type="button"
              style={{ ...SECONDARY_BTN, minWidth: 150 }}
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadMoreLabel(loadingMore, loadMoreError, t)}
            </button>
          </>
        ) : (
          <p
            role="status"
            aria-live="polite"
            aria-label={t("gitClientWindow.history.paginationStatusAria")}
            style={{ ...SUBTLE_TEXT_STYLE, margin: 0 }}
          >
            {t("gitClientWindow.history.end", { count: entries.length })}
          </p>
        )}
      </div>
    </>
  );
}

// Commit-detail metadata block rendered in the diff pane body (the subject + author/hash/stats live
// in the diff-pane header). Exposes the full sha, parents, changed-file count and refs.
export function CommitDetailMeta({ entry }: { readonly entry: GitHistoryEntry }): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <section className="rv-empty" aria-label={t("gitClientWindow.history.commitDetailsAria")}>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content minmax(0, 1fr)",
          gap: "6px 16px",
          width: "min(560px, 100%)",
          textAlign: "left",
          font: "400 13px var(--font-ui)",
          color: "var(--fg-muted)",
        }}
      >
        <dt>Commit</dt>
        <dd className="mono" style={{ margin: 0, color: "var(--fg)", overflowWrap: "anywhere" }}>
          {entry.sha}
        </dd>
        <dt>Short SHA</dt>
        <dd className="mono" style={{ margin: 0, color: "var(--fg)" }}>
          {entry.shortSha}
        </dd>
        <dt>Parents</dt>
        <dd style={{ margin: 0, color: "var(--fg)" }}>{entry.parentCount}</dd>
        <dt>Changed files</dt>
        <dd style={{ margin: 0, color: "var(--fg)" }}>{entry.changedFileCount}</dd>
        <dt>Refs</dt>
        <dd style={{ margin: 0, color: "var(--fg)" }}>
          {entry.refs.length === 0 ? "None" : entry.refs.join(", ")}
        </dd>
      </dl>
    </section>
  );
}
