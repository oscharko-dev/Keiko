"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { GitDiffScope, GitHistoryEntry } from "@/lib/types";
import { Icons } from "../../../Icons";
import { parseUnifiedDiff } from "../shared/diffParser";
import { DiffFileSection } from "../shared/diffView";
import type { GitClientSeam } from "./git-client-seam";
import { formatGitError } from "./git-client-seam";
import { HistoryCommitDetail } from "./HistoryPane";
import {
  DIFF_HEADER_STYLE,
  disabledStyle,
  FOOTER_STYLE,
  PANE_STYLE,
  scopeButtonStyle,
  SCOPE_TOGGLE_STYLE,
  SECONDARY_BTN,
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

interface DiffPaneProps {
  readonly client: GitClientSeam;
  readonly repositoryRoot: string | null;
  readonly selectedChangePath: string | null;
  readonly selectedCommit: GitHistoryEntry | null;
  readonly scope: GitDiffScope;
  readonly onScopeChange: (scope: GitDiffScope) => void;
  /** Bumped after a staging/commit mutation so the visible diff reloads. */
  readonly revision: number;
  readonly onCreatePullRequest?: (() => void) | undefined;
  readonly onMerge?: (() => void) | undefined;
}

export function DiffPane({
  client,
  repositoryRoot,
  selectedChangePath,
  selectedCommit,
  scope,
  onScopeChange,
  revision,
  onCreatePullRequest,
  onMerge,
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
  const hasRepository = repositoryRoot !== null;

  return (
    <div style={PANE_STYLE}>
      {selectedCommit !== null ? (
        <div style={DIFF_HEADER_STYLE}>
          <span className="rv-filerow-path mono" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {selectedCommit.shortSha}
          </span>
        </div>
      ) : selectedChangePath !== null ? (
        <div style={DIFF_HEADER_STYLE}>
          <span className="rv-filerow-path mono" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {selectedChangePath}
          </span>
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
      <footer style={FOOTER_STYLE}>
        <button
          type="button"
          style={{ ...SECONDARY_BTN, ...disabledStyle(!hasRepository) }}
          disabled={!hasRepository}
          onClick={onCreatePullRequest}
        >
          <Icons.git size={12} /> Create Pull Request
        </button>
        <button
          type="button"
          style={{ ...SECONDARY_BTN, ...disabledStyle(!hasRepository) }}
          disabled={!hasRepository}
          onClick={onMerge}
        >
          <Icons.branch size={12} /> Merge…
        </button>
      </footer>
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
  if (selectedCommit !== null) return <HistoryCommitDetail entry={selectedCommit} />;
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
      <p className="rv-empty" role="alert" style={{ padding: "var(--space-4)" }}>
        {state.error}
      </p>
    );
  }
  if (state.loading) {
    return (
      <p className="rv-empty" role="status" style={{ padding: "var(--space-4)" }}>
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
        <p
          className="rv-truncated"
          role="status"
          style={{ ...SUBTLE_TEXT_STYLE, padding: "var(--space-4)" }}
        >
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
