"use client";

// Quality Intelligence hub — the singleton Workspace tool window (Epic #270, Issue #280).
// Start a run (requirements text or a local folder) and browse past runs. Selecting a run, or a run
// finishing, opens a `qiRun` result card on the Workspace canvas (one card per run). The hub never
// renders run results itself — it stays a compact launcher + list that lives beside the result cards.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiRunSummary,
} from "@oscharko-dev/keiko-contracts";
import { useQiTranslate as useTranslate, type I18nTranslate } from "./qi-i18n";
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
  reviewLabel,
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
  /** Figma Snapshot sources from connected windows, optionally scoped to selected screen ids. */
  readonly connectedFigmaSnapshotSources?:
    readonly QualityIntelligenceFigmaSnapshotSource[] | undefined;
  /** Image-only sources from connected Figma Image windows. */
  readonly connectedImageSources?: readonly QualityIntelligenceImageSource[] | undefined;
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
  t,
  openButtonRef,
}: {
  readonly run: QualityIntelligenceUiRunSummary;
  readonly onOpen: (
    id: string,
    recheckableSources?: readonly QualityIntelligenceInlineSource[],
  ) => void;
  readonly onDelete: (id: string) => void;
  readonly deleting: boolean;
  readonly t: I18nTranslate;
  // Registers this row's Open button with the panel so a delete can park keyboard focus on a
  // surviving row's Open button after the deleted row unmounts (GEN-UI-FOCUS-003, WCAG 2.4.3).
  readonly openButtonRef?: (id: string, el: HTMLButtonElement | null) => void;
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
        ref={(el) => {
          openButtonRef?.(run.id, el);
        }}
        style={{ flex: 1 }}
        onClick={() => {
          // Historical run-list rows do not know the original source handles; pass an explicit empty
          // set so the card never borrows whichever source happens to be connected now (#744).
          onOpen(run.id, []);
        }}
        // uiux-fix F030 C270: aria-label REPLACES the computed name from content — a bare
        // "Open run <id>" hid status, date and case count from screen-reader users. Compose
        // the full label so failed and succeeded runs are distinguishable while list-navigating.
        // "test case(s)" — the suite-wide object name (uiux-fix F047 C388: the hub said "cases",
        // the export preview "candidates", launcher/card "test cases").
        // Issue #282 A11y-2: append review state so screen-reader list-navigation announces the
        // artifact lifecycle state (AC1 — run-as-artifact has a visible + announced review state).
        aria-label={t("qi.hub.openRunAria", {
          runId: run.id,
          status: runStatusLabel(run.status, t),
          requestedAt: formatDate(run.requestedAt),
          count: cases,
          review: reviewLabel(run.reviewState, t),
        })}
        title={t("qi.hub.openRunTitle", { runId: run.id })}
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
          {t("qi.hub.testCaseCount", { count: run.totals.candidates })}
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
          aria-label={t("qi.hub.deleteRunAria", { requestedAt: formatDate(run.requestedAt) })}
          onClick={() => {
            setConfirming(true);
          }}
        >
          {t("common.delete")}
        </button>
      ) : (
        // Step 2: inline confirm strip — Confirm + Cancel as siblings in a group.
        // Escape is handled on the focusable buttons (not this group container) so it stays within
        // jsx-a11y's interactive-element rule; focus is always on Confirm or Cancel while open.
        <div
          className="qi-cand-actions"
          role="group"
          aria-label={t("qi.hub.confirmDeleteGroup", {
            requestedAt: formatDate(run.requestedAt),
          })}
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
            aria-label={t("qi.hub.confirmDeleteAria", {
              requestedAt: formatDate(run.requestedAt),
            })}
            aria-busy={deleting || undefined}
            // aria-disabled keeps the button focusable while in-flight (mirrors GovernedActionButton).
            aria-disabled={deleting || undefined}
            onClick={handleConfirmDelete}
            onKeyDown={handleKeyDownConfirm}
          >
            {deleting ? (
              <>
                <span aria-hidden="true">{t("qi.hub.deleting")}</span>
                <span className="sr-only">{t("qi.hub.deletingWait")}</span>
              </>
            ) : (
              t("qi.hub.confirmDelete")
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
            {t("common.cancel")}
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// QiHubPanel helpers — extracted from the component (SonarCloud S3776), mirroring the
// loadRunDetail / runReviewAction / computeStatusText / RunCardBody pattern in QiRunCard.tsx.
// ---------------------------------------------------------------------------

interface RunDeleteParams {
  readonly runId: string;
  readonly runs: readonly QualityIntelligenceUiRunSummary[];
  readonly deleteImpl: typeof deleteQiRun;
  readonly loadRuns: () => Promise<void>;
  readonly t: I18nTranslate;
  readonly openButtonRefs: { current: Map<string, HTMLButtonElement> };
  readonly runsHeadingRef: { current: HTMLHeadingElement | null };
  readonly setDeletingId: (value: string | null) => void;
  readonly setError: (value: string | null) => void;
  readonly setDeletedAnnounce: (value: string) => void;
}

// Deletes a run: calls the API, refetches the list, then parks keyboard focus on the closest
// surviving row's Open button (or the runs heading if none survive) so a delete never strands
// focus on <body> (GEN-UI-FOCUS-003, WCAG 2.4.3). Extracted from handleDelete (SonarCloud S3776)
// so the callback itself stays a thin guard + dispatch.
async function runDeleteRun(params: RunDeleteParams): Promise<void> {
  const {
    runId,
    runs,
    deleteImpl,
    loadRuns,
    t,
    openButtonRefs,
    runsHeadingRef,
    setDeletingId,
    setError,
    setDeletedAnnounce,
  } = params;
  // Determine the surviving neighbour BEFORE the delete unmounts the focused row: prefer the
  // next run's Open button, then the previous run's, so keyboard focus lands on the closest
  // surviving row (GEN-UI-FOCUS-003, WCAG 2.4.3). If this is the last run, park focus on the
  // runs heading instead (the empty-state container is not focusable).
  const index = runs.findIndex((run) => run.id === runId);
  const neighbour = index === -1 ? undefined : (runs[index + 1] ?? runs[index - 1]);
  const neighbourId = neighbour?.id;
  setDeletingId(runId);
  setError(null);
  try {
    await deleteImpl(runId);
    setDeletedAnnounce(t("qi.hub.deleted"));
    await loadRuns();
    // Park focus after the refetch commits the new list, so the target element exists in the
    // DOM. requestAnimationFrame lets React flush the removal of the deleted row first.
    requestAnimationFrame(() => {
      const target =
        neighbourId !== undefined ? openButtonRefs.current.get(neighbourId) : undefined;
      if (target !== undefined) {
        target.focus();
      } else {
        runsHeadingRef.current?.focus();
      }
    });
  } catch (err) {
    setError(formatError(err));
  } finally {
    setDeletingId(null);
  }
}

// uiux-fix F030 C111: the run-list load-status live region text. Extracted so the
// loading/error/loaded ternary chain isn't nested inline inside the JSX (SonarCloud S3776).
function computeRunsStatusText(
  loading: boolean,
  error: string | null,
  runs: readonly QualityIntelligenceUiRunSummary[],
  truncated: boolean,
  totalRunIds: number,
  t: I18nTranslate,
): string {
  if (loading) return t("qi.hub.loadingRuns");
  if (error === null) {
    return t("qi.hub.listLoaded", {
      shown: runs.length,
      total: truncated ? totalRunIds : runs.length,
    });
  }
  return "";
}

interface RunsListBodyProps {
  readonly loading: boolean;
  readonly error: string | null;
  readonly runs: readonly QualityIntelligenceUiRunSummary[];
  readonly visibleRuns: number;
  readonly deletingId: string | null;
  readonly truncated: boolean;
  readonly totalRunIds: number;
  readonly t: I18nTranslate;
  readonly openRun: (
    id: string,
    recheckableSources?: readonly QualityIntelligenceInlineSource[],
  ) => void;
  readonly onDelete: (id: string) => void;
  readonly onRetry: () => void;
  readonly onShowMore: () => void;
  readonly registerOpenButton: (id: string, el: HTMLButtonElement | null) => void;
}

// The loading/error/empty/list gate for the run-list column body. Extracted from QiHubPanel's
// JSX (SonarCloud S3776) — early returns instead of a nested ternary chain.
function RunsListBody({
  loading,
  error,
  runs,
  visibleRuns,
  deletingId,
  truncated,
  totalRunIds,
  t,
  openRun,
  onDelete,
  onRetry,
  onShowMore,
  registerOpenButton,
}: RunsListBodyProps): ReactNode {
  if (loading) return <LoadingSkeleton />;
  if (error !== null) return <ErrorState message={error} onRetry={onRetry} />;
  if (runs.length === 0) {
    return (
      <div className="lk-empty">
        <p className="lk-empty-title">{t("qi.hub.empty.title")}</p>
        <p className="lk-empty-body">{t("qi.hub.empty.body")}</p>
      </div>
    );
  }
  return (
    <>
      <ul className="qi-run-list" aria-label={t("qi.hub.runList")}>
        {runs.slice(0, visibleRuns).map((run) => (
          <RunRow
            key={run.id}
            run={run}
            onOpen={openRun}
            onDelete={onDelete}
            deleting={deletingId === run.id}
            t={t}
            openButtonRef={registerOpenButton}
          />
        ))}
      </ul>
      {visibleRuns < runs.length ? (
        <button type="button" className="qi-btn qi-btn-secondary qi-show-more" onClick={onShowMore}>
          {t("qi.hub.showMoreRuns", { count: runs.length - visibleRuns })}
        </button>
      ) : null}
      {truncated ? (
        <p className="qi-runs-truncated" data-testid="qi-runs-truncated">
          {t("qi.hub.truncated", { shown: runs.length, total: totalRunIds })}
        </p>
      ) : null}
    </>
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
  connectedFigmaSnapshotSources,
  connectedImageSources,
  fetchRunsImpl = fetchQiRuns,
  deleteImpl = deleteQiRun,
}: QiHubPanelProps): ReactNode {
  const t = useTranslate();
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
  // Focus management for delete (GEN-UI-FOCUS-003, WCAG 2.4.3): a successful delete unmounts the
  // focused row, which would strand keyboard focus on <body>. We register each row's Open button by
  // id and keep a ref to the (focusable) runs heading, then park focus on a surviving element after
  // the post-delete refetch resolves — mirroring the DriftPanel reCheckBtnRef park-focus pattern.
  const openButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const runsHeadingRef = useRef<HTMLHeadingElement>(null);
  const registerOpenButton = useCallback((id: string, el: HTMLButtonElement | null): void => {
    if (el === null) {
      openButtonRefs.current.delete(id);
    } else {
      openButtonRefs.current.set(id, el);
    }
  }, []);

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
  // already proven in the list-load path is appropriate for a delete failure. The body is
  // extracted to runDeleteRun (SonarCloud S3776); this callback stays a thin guard + dispatch.
  const handleDelete = useCallback(
    async (runId: string): Promise<void> => {
      if (deletingId !== null) return; // concurrent-delete guard
      await runDeleteRun({
        runId,
        runs,
        deleteImpl,
        loadRuns,
        t,
        openButtonRefs,
        runsHeadingRef,
        setDeletingId,
        setError,
        setDeletedAnnounce,
      });
    },
    [deletingId, deleteImpl, loadRuns, runs, t],
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
        connectedFigmaSnapshotSources={connectedFigmaSnapshotSources}
        connectedImageSources={connectedImageSources}
      />
      <section className="qi-hub-runs" aria-label={t("qi.hub.runsAria")}>
        <header className="qi-col-header">
          {/* tabIndex=-1 makes the heading programmatically focusable so a delete that removes the
              last run can park keyboard focus here instead of stranding it on <body>
              (GEN-UI-FOCUS-003, WCAG 2.4.3). It is not in the tab order. */}
          <h2 className="qi-col-title" ref={runsHeadingRef} tabIndex={-1}>
            {t("qi.hub.runs")}
          </h2>
          {!loading && error === null ? (
            <span className="qi-col-count">{totalRunIds.toString()}</span>
          ) : null}
        </header>
        {/* uiux-fix F030 C111: the live region is a small persistent sr-only status line — NOT
            the column body. aria-live on the body announced the entire interactive run list on
            every refresh. Load errors announce via ErrorState's own role="alert". */}
        <p className="sr-only" role="status" aria-live="polite">
          {computeRunsStatusText(loading, error, runs, truncated, totalRunIds, t)}
        </p>
        {/* Dedicated live region for delete completion announcements — separate from the list
            status region so a delete announcement does not clash with a concurrent list reload. */}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {deletedAnnounce}
        </p>
        <div className="qi-col-body" aria-busy={loading}>
          <RunsListBody
            loading={loading}
            error={error}
            runs={runs}
            visibleRuns={visibleRuns}
            deletingId={deletingId}
            truncated={truncated}
            totalRunIds={totalRunIds}
            t={t}
            openRun={openRun}
            onDelete={(id) => {
              void handleDelete(id);
            }}
            onRetry={() => {
              void loadRuns();
            }}
            onShowMore={() => {
              setVisibleRuns((v) => v + INITIAL_VISIBLE_RUNS);
            }}
            registerOpenButton={registerOpenButton}
          />
        </div>
      </section>
    </div>
  );
}
