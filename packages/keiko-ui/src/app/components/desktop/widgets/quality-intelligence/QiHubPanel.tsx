"use client";

// Quality Intelligence hub — the singleton Workspace tool window (Epic #270, Issue #280).
// Start a run (requirements text or a local folder) and browse past runs. Selecting a run, or a run
// finishing, opens a `qiRun` result card on the Workspace canvas (one card per run). The hub never
// renders run results itself — it stays a compact launcher + list that lives beside the result cards.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { QualityIntelligenceUiRunSummary } from "@oscharko-dev/keiko-contracts";
import { fetchQiRuns } from "@/lib/quality-intelligence-api";
import { RunLauncher } from "./RunLauncher";
import {
  StatusBadge,
  LoadingSkeleton,
  ErrorState,
  formatError,
  formatDate,
  runStatusLabel,
} from "./qiShared";

export interface QiHubPanelProps {
  /** Opens a Workspace window — wired to the render context so the hub can spawn run cards. */
  readonly openRun: (runId: string) => void;
  /** Folder bound via a relationship edge to a Files window (Epic #270 Slice 1). */
  readonly connectedRoot?: string | null;
  /** Focused single file in the connected Files window (Epic #709) — preferred over the folder. */
  readonly connectedFilePath?: string | null;
  /** All connected Files window roots (Epic #729 N+1). Empty when no Files windows are connected. */
  readonly connectedRoots?: readonly string[] | undefined;
  /** Capsule ids from connected Connector windows (Epic #710 #718). */
  readonly connectedCapsuleIds?: readonly string[] | undefined;
  /** Capsule-set ids from connected Connector windows (Epic #710 #718). */
  readonly connectedCapsuleSetIds?: readonly string[] | undefined;
  /** Figma Snapshot run ids from connected Figma Snapshot windows (Epic #750 #756). */
  readonly connectedFigmaSnapshotRunIds?: readonly string[] | undefined;
  /** Seam for tests. */
  readonly fetchRunsImpl?: typeof fetchQiRuns;
}

function RunRow({
  run,
  onOpen,
}: {
  readonly run: QualityIntelligenceUiRunSummary;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const cases = run.totals.candidates;
  return (
    <li>
      <button
        type="button"
        className="qi-run-item"
        onClick={() => {
          onOpen(run.id);
        }}
        // uiux-fix F030 C270: aria-label REPLACES the computed name from content — a bare
        // "Open run <id>" hid status, date and case count from screen-reader users. Compose
        // the full label so failed and succeeded runs are distinguishable while list-navigating.
        // "test case(s)" — the suite-wide object name (uiux-fix F047 C388: the hub said "cases",
        // the export preview "candidates", launcher/card "test cases").
        aria-label={`Open run ${run.id} — ${runStatusLabel(run.status)}, ${formatDate(run.requestedAt)}, ${cases.toString()} test case${cases !== 1 ? "s" : ""}`}
        title={`Open run ${run.id}`}
      >
        {/* uiux-fix F038 C145: the wire summary carries no source label, so the opaque UUID
            prefix had zero recognition value as the primary line. Until the contract grows a
            sourceLabel, the human-meaningful signal is the request date — promote it to the
            primary line and demote the id to truncated meta WITH an ellipsis (the bare 16-char
            slice looked like a complete id). Full id stays in title + aria-label. */}
        <span className="qi-run-title">{formatDate(run.requestedAt)}</span>
        <StatusBadge status={run.status} />
        <span className="qi-run-id">{run.id.slice(0, 16)}…</span>
        <span className="qi-run-totals">
          {run.totals.candidates.toString()} test case{run.totals.candidates !== 1 ? "s" : ""}
        </span>
      </button>
    </li>
  );
}

export function QiHubPanel({
  openRun,
  connectedRoot = null,
  connectedFilePath = null,
  connectedRoots,
  connectedCapsuleIds,
  connectedCapsuleSetIds,
  connectedFigmaSnapshotRunIds,
  fetchRunsImpl = fetchQiRuns,
}: QiHubPanelProps): ReactNode {
  const [runs, setRuns] = useState<readonly QualityIntelligenceUiRunSummary[]>([]);
  // uiux-fix F030 C277: the wire contract reports limit/totalRunIds/truncated explicitly so the
  // UI can render a "more available" indicator; the hub previously discarded them and silently
  // showed an incomplete list with a too-small count once the store exceeded the route limit.
  const [totalRunIds, setTotalRunIds] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRunsImpl();
      setRuns(res.runs);
      setTotalRunIds(res.totalRunIds);
      setTruncated(res.truncated);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchRunsImpl]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const handleRunCompleted = useCallback(
    (runId: string): void => {
      void loadRuns();
      openRun(runId);
    },
    [loadRuns, openRun],
  );

  return (
    <div className="qi-hub">
      <RunLauncher
        onRunCompleted={handleRunCompleted}
        connectedRoot={connectedRoot}
        connectedFilePath={connectedFilePath}
        connectedRoots={connectedRoots}
        connectedCapsuleIds={connectedCapsuleIds}
        connectedCapsuleSetIds={connectedCapsuleSetIds}
        connectedFigmaSnapshotRunIds={connectedFigmaSnapshotRunIds}
      />
      <section className="qi-hub-runs" aria-label="Quality Intelligence runs">
        <header className="qi-col-header">
          <h2 className="qi-col-title">Runs</h2>
          {!loading && error === null ? (
            <span className="qi-col-count">{totalRunIds.toString()}</span>
          ) : null}
        </header>
        {/* uiux-fix F030 C111: the live region is a small persistent sr-only status line — NOT
            the column body. aria-live on the body announced the entire interactive run list on
            every refresh. Load errors announce via ErrorState's own role="alert". */}
        <p className="sr-only" role="status" aria-live="polite">
          {loading
            ? "Loading runs…"
            : error === null
              ? `Run list loaded: ${runs.length.toString()} run${runs.length === 1 ? "" : "s"}${truncated ? ` of ${totalRunIds.toString()}` : ""}.`
              : ""}
        </p>
        <div className="qi-col-body" aria-busy={loading}>
          {loading ? (
            <LoadingSkeleton />
          ) : error !== null ? (
            <ErrorState
              message={error}
              onRetry={() => {
                void loadRuns();
              }}
            />
          ) : runs.length === 0 ? (
            <div className="lk-empty">
              <p className="lk-empty-title">No runs yet</p>
              <p className="lk-empty-body">
                Start a run above — generated test cases open as cards on your workspace.
              </p>
            </div>
          ) : (
            <>
              <ul className="qi-run-list" aria-label="Run list">
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} onOpen={openRun} />
                ))}
              </ul>
              {truncated ? (
                <p className="qi-runs-truncated" data-testid="qi-runs-truncated">
                  {`Showing ${runs.length.toString()} of ${totalRunIds.toString()} runs.`}
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
