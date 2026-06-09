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
import { StatusBadge, LoadingSkeleton, ErrorState, formatError, formatDate } from "./qiShared";

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
  return (
    <li>
      <button
        type="button"
        className="qi-run-item"
        onClick={() => {
          onOpen(run.id);
        }}
        aria-label={`Open run ${run.id}`}
        title={`Open run ${run.id}`}
      >
        <span className="qi-run-id">{run.id.slice(0, 16)}</span>
        <StatusBadge status={run.status} />
        <span className="qi-run-meta">{formatDate(run.requestedAt)}</span>
        <span className="qi-run-totals">
          {run.totals.candidates.toString()} case{run.totals.candidates !== 1 ? "s" : ""}
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
  fetchRunsImpl = fetchQiRuns,
}: QiHubPanelProps): ReactNode {
  const [runs, setRuns] = useState<readonly QualityIntelligenceUiRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchRunsImpl());
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
      />
      <section className="qi-hub-runs" aria-label="Quality Intelligence runs">
        <header className="qi-col-header">
          <h2 className="qi-col-title">Runs</h2>
          {!loading && error === null ? (
            <span className="qi-col-count">{runs.length.toString()}</span>
          ) : null}
        </header>
        <div className="qi-col-body" aria-live="polite" aria-busy={loading}>
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
            <ul className="qi-run-list" aria-label="Run list">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} onOpen={openRun} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
