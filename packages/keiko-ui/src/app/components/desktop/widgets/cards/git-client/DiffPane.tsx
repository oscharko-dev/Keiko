"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { GitDiffScope, GitHistoryEntry } from "@/lib/types";
import { parseUnifiedDiff } from "../shared/diffParser";
import { DiffFileSection } from "../shared/diffView";
import type { GitClientSeam } from "./git-client-seam";
import { formatGitError } from "./git-client-seam";
import { CommitDetailMeta } from "./HistoryPane";
import {
  avatarStyle,
  COMMIT_DETAIL_HEADER_STYLE,
  DIFF_HEADER_STYLE,
  DIFF_PATH_STYLE,
  HASH_CHIP_STYLE,
  scopeButtonStyle,
  SCOPE_TOGGLE_STYLE,
  SUBTLE_TEXT_STYLE,
} from "./git-client-styles";

interface DiffState {
  readonly loading: boolean;
  readonly diff: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
}

const EMPTY_DIFF: DiffState = { loading: false, diff: null, truncated: false, error: null };

const SCOPES: readonly { readonly id: GitDiffScope; readonly label: string }[] = [
  { id: "worktree", label: "Worktree" },
  { id: "staged", label: "Staged" },
];

// git emits "Binary files a/x and b/x differ" (or a "GIT binary patch") instead of a text hunk.
function isBinaryDiff(diff: string): boolean {
  return /^Binary files .+ differ$/m.test(diff) || diff.includes("GIT binary patch");
}

// Split a repo-relative path into its directory (with trailing slash) and the file name.
function splitPath(path: string): { readonly dir: string; readonly name: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

function authorInitials(author: string): string {
  return author.slice(0, 2).toUpperCase();
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface DiffPaneProps {
  readonly client: GitClientSeam;
  readonly repositoryRoot: string | null;
  readonly selectedChangePath: string | null;
  readonly selectedCommit: GitHistoryEntry | null;
  readonly scope: GitDiffScope;
  readonly onScopeChange: (scope: GitDiffScope) => void;
  /** Bumped after a staging/commit mutation so the visible diff reloads. */
  readonly revision: number;
}

export function DiffPane({
  client,
  repositoryRoot,
  selectedChangePath,
  selectedCommit,
  scope,
  onScopeChange,
  revision,
}: DiffPaneProps): ReactNode {
  const [state, setState] = useState<DiffState>(EMPTY_DIFF);

  useEffect(() => {
    if (selectedCommit !== null) {
      setState(EMPTY_DIFF);
      return;
    }
    if (repositoryRoot === null || selectedChangePath === null) {
      setState(EMPTY_DIFF);
      return;
    }
    let cancelled = false;
    setState({ loading: true, diff: null, truncated: false, error: null });
    void client.getDiff({ root: repositoryRoot, path: selectedChangePath, scope }).then(
      (res) => {
        if (cancelled) return;
        setState({ loading: false, diff: res.diff, truncated: res.truncated, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({ loading: false, diff: null, truncated: false, error: formatGitError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, repositoryRoot, selectedChangePath, selectedCommit, scope, revision]);

  const binary = state.diff !== null && isBinaryDiff(state.diff);
  const parsed = useMemo(
    () => (state.diff !== null && !binary ? parseUnifiedDiff(state.diff) : null),
    [state.diff, binary],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1 }}>
      {selectedCommit !== null ? (
        <CommitDetailHeader entry={selectedCommit} />
      ) : selectedChangePath !== null ? (
        <div style={DIFF_HEADER_STYLE}>
          <DiffPathLabel path={selectedChangePath} />
          <span style={{ flex: 1 }} />
          <div role="group" aria-label="Diff scope" style={SCOPE_TOGGLE_STYLE}>
            {SCOPES.map((entry) => {
              const active = entry.id === scope;
              return (
                <button
                  key={entry.id}
                  type="button"
                  style={scopeButtonStyle(active)}
                  aria-pressed={active}
                  onClick={() => onScopeChange(entry.id)}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div
        style={{ flex: 1, minHeight: 0, overflow: "auto" }}
        className="review"
        role="region"
        aria-label="Diff"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Long diffs need a named, keyboard-scrollable region.
        tabIndex={0}
      >
        <DiffBody
          selectedChangePath={selectedChangePath}
          selectedCommit={selectedCommit}
          state={state}
          binary={binary}
          files={parsed?.files ?? null}
        />
      </div>
    </div>
  );
}

function DiffPathLabel({ path }: { readonly path: string }): ReactNode {
  const { dir, name } = splitPath(path);
  return (
    <span style={DIFF_PATH_STYLE} title={path}>
      {dir}
      <span style={{ color: "var(--fg)" }}>{name}</span>
    </span>
  );
}

// Commit-detail header (History view): subject as the pane heading + an author/hash/stats meta row.
function CommitDetailHeader({ entry }: { readonly entry: GitHistoryEntry }): ReactNode {
  return (
    <div style={COMMIT_DETAIL_HEADER_STYLE}>
      <h2 tabIndex={-1} style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
        {entry.subject}
      </h2>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          flexWrap: "wrap",
          fontSize: 11.5,
          color: "var(--fg-muted)",
        }}
      >
        <span aria-hidden="true" style={{ ...avatarStyle(22), fontSize: 9.5 }}>
          {authorInitials(entry.author)}
        </span>
        <span style={{ color: "var(--fg)" }}>{entry.author}</span>
        <span>committed</span>
        <span style={HASH_CHIP_STYLE}>{entry.shortSha}</span>
        <span>·</span>
        <span>{formatDate(entry.date)}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-faint)" }}>
          {entry.changedFileCount} {entry.changedFileCount === 1 ? "file changed" : "files changed"}
        </span>
      </div>
    </div>
  );
}

function DiffBody({
  selectedChangePath,
  selectedCommit,
  state,
  binary,
  files,
}: {
  readonly selectedChangePath: string | null;
  readonly selectedCommit: GitHistoryEntry | null;
  readonly state: DiffState;
  readonly binary: boolean;
  readonly files: ReturnType<typeof parseUnifiedDiff>["files"] | null;
}): ReactNode {
  if (selectedCommit !== null) return <CommitDetailMeta entry={selectedCommit} />;
  if (selectedChangePath === null) {
    return (
      <div className="rv-empty" aria-label="Diff">
        <h2 className="rv-empty-h">Diff</h2>
        <p className="rv-empty-p">Select a change to view its diff.</p>
      </div>
    );
  }
  if (state.error !== null) {
    return (
      <p className="rv-empty" role="alert" style={{ padding: 14 }}>
        {state.error}
      </p>
    );
  }
  if (state.loading) {
    return (
      <p className="rv-empty" role="status" style={{ padding: 14 }}>
        Loading diff…
      </p>
    );
  }
  if (binary) {
    return (
      <div className="rv-empty">
        <p className="rv-empty-p" style={SUBTLE_TEXT_STYLE}>
          Binary file — no text diff to display.
        </p>
      </div>
    );
  }
  if (files === null || files.length === 0) {
    return (
      <div className="rv-empty">
        <p className="rv-empty-p" style={SUBTLE_TEXT_STYLE}>
          No diff content for this change.
        </p>
      </div>
    );
  }
  return (
    <div className="rv-body">
      {state.truncated ? (
        <p className="rv-truncated" role="status" style={{ ...SUBTLE_TEXT_STYLE, padding: 14 }}>
          This diff is large and has been truncated.
        </p>
      ) : null}
      {files.map((file, index) => (
        <DiffFileSection
          key={file.path}
          file={file}
          index={index}
          changedFiles={[]}
          sectionRef={() => undefined}
        />
      ))}
    </div>
  );
}
