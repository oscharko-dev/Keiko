"use client";

// Quality Intelligence hub — the singleton Workspace tool window (Epic #270, Issue #280).
// Start a run (requirements text or a local folder) and browse past runs. Selecting a run, or a run
// finishing, opens a `qiRun` result card on the Workspace canvas (one card per run). The hub never
// renders run results itself — it stays a compact launcher + list that lives beside the result cards.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiRunSummary,
} from "@oscharko-dev/keiko-contracts";
import { deleteQiRun, fetchQiRuns } from "@/lib/quality-intelligence-api";
import { RunLauncher } from "./RunLauncher";
import {
  StatusBadge,
  ReviewBadge,
  LoadingSkeleton,
  ErrorState,
  formatError,
  formatDate,
  runStatusLabel,
  REVIEW_LABEL,
} from "./qiShared";

export interface QiHubPanelProps {
  /** Opens a Workspace window — wired to the render context so the hub can spawn run cards. */
  readonly openRun: (
    runId: string,
    recheckableSources?: readonly QualityIntelligenceInlineSource[],
  ) => void;
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
  /** Seam for tests — injects the delete API call. */
  readonly deleteImpl?: typeof deleteQiRun;
}

// The run list accumulates over a project's lifetime (server returns up to 100 by default, 500 max).
// Render the first page and reveal the rest on demand — the #280 progressive-rendering Deliverable.
const INITIAL_VISIBLE_RUNS = 25;

// ---------------------------------------------------------------------------
// RunRow — a single list item with an open action and a two-step delete control.
// The two are SIBLINGS inside <li> (never nested buttons); the <li> is a flex row.
// ---------------------------------------------------------------------------

function RunRow({
  run,
  onOpen,
  onDelete,
  deleting,
}: {
  readonly run: QualityIntelligenceUiRunSummary;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly deleting: boolean;
}): ReactNode {
  const cases = run.totals.candidates;
  const [confirming, setConfirming] = useState(false);

  // Refs for focus management — focus Cancel when confirm appears; return to Delete on cancel.
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // When the confirm strip appears, focus Cancel (the safer default).
  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
    }
  }, [confirming]);

  const handleCancelConfirm = useCallback(() => {
    setConfirming(false);
    // Return focus to the Delete trigger once the confirm strip collapses.
    // Schedule after the state flush so the button is back in the DOM.
    requestAnimationFrame(() => {
      deleteTriggerRef.current?.focus();
    });
  }, []);

  const handleKeyDownConfirm = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancelConfirm();
      }
    },
    [handleCancelConfirm],
  );

  const handleConfirmDelete = useCallback(() => {
    if (deleting) return;
    onDelete(run.id);
  }, [deleting, onDelete, run.id]);

  return (
    // Flex row so the open button and the delete control are siblings, never nested.
    <li style={{ display: "flex", alignItems: "stretch" }}>
      {/* ── Open button ── keeps the original full-width flex layout, shrinks to make room. */}
      <button
        type="button"
        className="qi-run-item"
        style={{ flex: 1 }}
        onClick={() => {
          onOpen(run.id);
        }}
        // uiux-fix F030 C270: aria-label REPLACES the computed name from content — a bare
        // "Open run <id>" hid status, date and case count from screen-reader users. Compose
        // the full label so failed and succeeded runs are distinguishable while list-navigating.
        // "test case(s)" — the suite-wide object name (uiux-fix F047 C388: the hub said "cases",
        // the export preview "candidates", launcher/card "test cases").
        // Issue #282 A11y-2: append review state so screen-reader list-navigation announces the
        // artifact lifecycle state (AC1 — run-as-artifact has a visible + announced review state).
        aria-label={`Open run ${run.id} — ${runStatusLabel(run.status)}, ${formatDate(run.requestedAt)}, ${cases.toString()} test case${cases !== 1 ? "s" : ""}, review ${REVIEW_LABEL[run.reviewState]}`}
        title={`Open run ${run.id}`}
      >
        {/* uiux-fix F038 C145: the wire summary carries no source label, so the opaque UUID
            prefix had zero recognition value as the primary line. Until the contract grows a
            sourceLabel, the human-meaningful signal is the request date — promote it to the
            primary line and demote the id to truncated meta WITH an ellipsis (the bare 16-char
            slice looked like a complete id). Full id stays in title + aria-label. */}
        <span className="qi-run-title">{formatDate(run.requestedAt)}</span>
        <StatusBadge status={run.status} />
        {/* Issue #282 A11y-2: review badge surfaces the run-as-artifact lifecycle state in the
            primary scanning view (AC1). Reuses ReviewBadge from qiShared — same CSS tokens,
            same sr-only prefix, no duplication of the class map. */}
        <ReviewBadge state={run.reviewState} />
        <span className="qi-run-id">{run.id.slice(0, 16)}…</span>
        <span className="qi-run-totals">
          {run.totals.candidates.toString()} test case{run.totals.candidates !== 1 ? "s" : ""}
        </span>
      </button>

      {/* ── Delete control (two-step confirm) ── */}
      {!confirming ? (
        // Step 1: a single Delete trigger with a danger affordance.
        <button
          ref={deleteTriggerRef}
          type="button"
          className="qi-btn qi-btn-reject"
          style={{
            alignSelf: "center",
            minWidth: 0,
            padding: "4px 10px",
            fontSize: 12,
            margin: "0 6px 0 0",
            flexShrink: 0,
          }}
          aria-label={`Delete run ${formatDate(run.requestedAt)}`}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Delete
        </button>
      ) : (
        // Step 2: inline confirm strip — Confirm + Cancel as siblings in a group.
        // Escape is handled on the focusable buttons (not this group container) so it stays within
        // jsx-a11y's interactive-element rule; focus is always on Confirm or Cancel while open.
        <div
          className="qi-cand-actions"
          role="group"
          aria-label={`Confirm deleting run ${formatDate(run.requestedAt)}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 6px",
            flexShrink: 0,
          }}
        >
          <button
            ref={confirmRef}
            type="button"
            className="qi-btn qi-btn-reject"
            style={{ minWidth: 0, padding: "4px 10px", fontSize: 12, flexShrink: 0 }}
            aria-label={`Confirm delete of run ${formatDate(run.requestedAt)}`}
            aria-busy={deleting || undefined}
            // aria-disabled keeps the button focusable while in-flight (mirrors GovernedActionButton).
            aria-disabled={deleting || undefined}
            onClick={handleConfirmDelete}
            onKeyDown={handleKeyDownConfirm}
          >
            {deleting ? (
              <>
                <span aria-hidden="true">Deleting…</span>
                <span className="sr-only">Deleting run, please wait</span>
              </>
            ) : (
              "Confirm delete"
            )}
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="qi-btn qi-btn-secondary"
            style={{ minWidth: 0, padding: "4px 10px", fontSize: 12, flexShrink: 0 }}
            aria-disabled={deleting || undefined}
            onClick={() => {
              if (deleting) return;
              handleCancelConfirm();
            }}
            onKeyDown={handleKeyDownConfirm}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// QiHubPanel
// ---------------------------------------------------------------------------

export function QiHubPanel({
  openRun,
  connectedRoot = null,
  connectedFilePath = null,
  connectedRoots,
  connectedCapsuleIds,
  connectedCapsuleSetIds,
  connectedFigmaSnapshotRunIds,
  fetchRunsImpl = fetchQiRuns,
  deleteImpl = deleteQiRun,
}: QiHubPanelProps): ReactNode {
  const [runs, setRuns] = useState<readonly QualityIntelligenceUiRunSummary[]>([]);
  // uiux-fix F030 C277: the wire contract reports limit/totalRunIds/truncated explicitly so the
  // UI can render a "more available" indicator; the hub previously discarded them and silently
  // showed an incomplete list with a too-small count once the store exceeded the route limit.
  const [totalRunIds, setTotalRunIds] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleRuns, setVisibleRuns] = useState(INITIAL_VISIBLE_RUNS);
  // Per-row in-flight lock: null = idle, string = the run id whose delete is in flight.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Polite announcement when a delete completes — read by the dedicated sr-only live region.
  const [deletedAnnounce, setDeletedAnnounce] = useState("");

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
    (runId: string, recheckableSources: readonly QualityIntelligenceInlineSource[]): void => {
      void loadRuns();
      openRun(runId, recheckableSources);
    },
    [loadRuns, openRun],
  );

  // Delete a run: call the API, refetch the list, surface failures via the existing error channel.
  // The deletingId lock prevents concurrent deletes. On error the row stays; on success the refetch
  // removes it. The panel-level error channel (ErrorState) is reused — the same retryable alert
  // already proven in the list-load path is appropriate for a delete failure.
  const handleDelete = useCallback(
    async (runId: string): Promise<void> => {
      if (deletingId !== null) return; // concurrent-delete guard
      setDeletingId(runId);
      setError(null);
      try {
        await deleteImpl(runId);
        setDeletedAnnounce("Run deleted.");
        await loadRuns();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, deleteImpl, loadRuns],
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
        {/* Dedicated live region for delete completion announcements — separate from the list
            status region so a delete announcement does not clash with a concurrent list reload. */}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {deletedAnnounce}
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
                {runs.slice(0, visibleRuns).map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    onOpen={openRun}
                    onDelete={(id) => {
                      void handleDelete(id);
                    }}
                    deleting={deletingId === run.id}
                  />
                ))}
              </ul>
              {visibleRuns < runs.length ? (
                <button
                  type="button"
                  className="qi-btn qi-btn-secondary qi-show-more"
                  onClick={() => {
                    setVisibleRuns((v) => v + INITIAL_VISIBLE_RUNS);
                  }}
                >
                  Show more runs ({(runs.length - visibleRuns).toString()} remaining)
                </button>
              ) : null}
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
