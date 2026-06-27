"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "../../../Icons";
import { parseUnifiedDiff } from "../shared/diffParser";
import { DiffFileSection } from "../shared/diffView";
import type { GitClientSeam } from "./git-client-seam";
import { formatGitError } from "./git-client-seam";
import {
  FOOTER_STYLE,
  PANE_STYLE,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

interface DiffState {
  readonly loading: boolean;
  readonly diff: string | null;
  readonly error: string | null;
}

const EMPTY_DIFF: DiffState = { loading: false, diff: null, error: null };

interface DiffPaneProps {
  readonly client: GitClientSeam;
  readonly repositoryRoot: string | null;
  readonly selectedChangePath: string | null;
  readonly onCreatePullRequest?: (() => void) | undefined;
  readonly onMerge?: (() => void) | undefined;
}

export function DiffPane({
  client,
  repositoryRoot,
  selectedChangePath,
  onCreatePullRequest,
  onMerge,
}: DiffPaneProps): ReactNode {
  const [state, setState] = useState<DiffState>(EMPTY_DIFF);

  useEffect(() => {
    if (repositoryRoot === null || selectedChangePath === null) {
      setState(EMPTY_DIFF);
      return;
    }
    let cancelled = false;
    setState({ loading: true, diff: null, error: null });
    void client.getDiff({ root: repositoryRoot, path: selectedChangePath }).then(
      (res) => {
        if (cancelled) return;
        setState({ loading: false, diff: res.diff, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({ loading: false, diff: null, error: formatGitError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, repositoryRoot, selectedChangePath]);

  const parsed = useMemo(
    () => (state.diff !== null ? parseUnifiedDiff(state.diff) : null),
    [state.diff],
  );
  const hasRepository = repositoryRoot !== null;

  return (
    <div style={PANE_STYLE}>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }} className="review">
        <DiffBody
          selectedChangePath={selectedChangePath}
          state={state}
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
  state,
  files,
}: {
  readonly selectedChangePath: string | null;
  readonly state: DiffState;
  readonly files: ReturnType<typeof parseUnifiedDiff>["files"] | null;
}): ReactNode {
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
