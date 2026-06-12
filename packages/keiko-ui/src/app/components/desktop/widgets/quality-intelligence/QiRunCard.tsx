"use client";

// Quality Intelligence run result card (Epic #270, Issue #280/#282/#283). One card per run, opened
// from the QI hub and keyed by runId. Shows the run summary, the generated test cases (responsive
// grid with per-candidate review), enterprise export, and any validation findings. Reuses the QI BFF
// routes; never embeds raw prompts or secrets (the wire projection is already redacted upstream).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceCandidateEditableFields,
} from "@oscharko-dev/keiko-contracts";
import { editQiCandidate, fetchQiRunDetail, reviewQiRun } from "@/lib/quality-intelligence-api";
import { CandidatesPane, type QiPendingReview, type QiReviewAction } from "./CandidatesPane";
import { DriftPanel } from "./DriftPanel";
import type { DriftPanelProps } from "./DriftPanel";
import { ExportBar } from "./ExportBar";
import {
  StatusBadge,
  SeverityBadge,
  QualityScoreBadge,
  LoadingSkeleton,
  ErrorState,
  formatError,
  formatDate,
  REVIEW_LABEL,
} from "./qiShared";

const REVIEWER_LABEL_STORAGE_KEY = "keiko.qi.reviewerLabel";
const GOVERNANCE_REQUIRED_MESSAGE = "Set a reviewer label to review or edit candidates.";

function readStoredReviewerLabel(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(REVIEWER_LABEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export interface QiRunCardProps {
  readonly runId: string;
  /**
   * The sources this run was launched from (Epic #735). When non-empty, the card offers drift
   * re-check + targeted regeneration against them; when empty/absent, that affordance is hidden.
   */
  readonly connectedSources?: DriftPanelProps["connectedSources"] | undefined;
  /**
   * Called after a successful targeted regeneration with the new run's result. The hub uses this to
   * open the new immutable run on the canvas (Issue #744 "refreshed card"). Absent → no-op.
   */
  readonly onRegenerated?: DriftPanelProps["onRegenerated"];
  /** Seam for tests. */
  readonly fetchDetailImpl?: typeof fetchQiRunDetail;
  readonly reviewImpl?: typeof reviewQiRun;
  readonly editImpl?: typeof editQiCandidate;
  readonly reCheckImpl?: DriftPanelProps["reCheckImpl"];
  readonly regenerateImpl?: DriftPanelProps["regenerateImpl"];
}

function SummaryStrip({ detail }: { readonly detail: QualityIntelligenceUiRunDetail }): ReactNode {
  return (
    <dl className="qi-run-summary" aria-label="Run summary">
      <div className="qi-run-summary-item">
        <dt>Status</dt>
        <dd>
          <StatusBadge status={detail.status} />
        </dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>Test cases</dt>
        <dd>{detail.totals.candidates.toString()}</dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>Findings</dt>
        <dd>{detail.totals.findings.toString()}</dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>Quality</dt>
        <dd>
          <QualityScoreBadge score={detail.qualityScore} />
        </dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>Review</dt>
        <dd className="qi-run-summary-review">{REVIEW_LABEL[detail.reviewState]}</dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>Requested</dt>
        <dd>{formatDate(detail.requestedAt)}</dd>
      </div>
      {detail.completedAt !== null ? (
        <div className="qi-run-summary-item">
          <dt>Completed</dt>
          <dd>{formatDate(detail.completedAt)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

// Human labels for the contract's finding-kind tokens (uiux-fix F030 C273) — the raw machine
// tokens ("logic-defect") used to render via CSS capitalize as "Logic-Defect". Unknown kinds
// fall back to the raw value.
const KIND_LABEL: Readonly<Record<string, string>> = {
  "logic-defect": "Logic defect",
  "faithfulness-defect": "Faithfulness defect",
  "semantic-defect": "Semantic defect",
  "mutation-defect": "Mutation defect",
  "policy-violation": "Policy violation",
  "manual-rejection": "Manual rejection",
  "coverage-gap": "Coverage gap",
  "test-quality": "Test quality",
};

// Findings, coverage gaps, and the run list can each grow to hundreds of rows (findings are capped
// at 512 server-side; the coverage gap radar has NO server cap and scales with source-atom count).
// Render the first page eagerly and reveal the rest on demand — the #280 "progressive rendering for
// large artifact lists" Deliverable, mirroring CandidatesPane's INITIAL_VISIBLE pattern.
const INITIAL_VISIBLE_ROWS = 20;

function FindingsList({ detail }: { readonly detail: QualityIntelligenceUiRunDetail }): ReactNode {
  const [visible, setVisible] = useState(INITIAL_VISIBLE_ROWS);
  const total = detail.findingRefs.length;
  if (total === 0) return null;
  const shown = detail.findingRefs.slice(0, visible);
  return (
    <section className="qi-run-findings" aria-label="Findings">
      <h3 className="qi-col-subtitle">
        Findings
        <span className="qi-col-count">{total.toString()}</span>
      </h3>
      <ul className="qi-finding-list" aria-label="Findings list">
        {shown.map((f) => (
          <li key={f.id} className="qi-finding-item">
            <div className="qi-finding-header">
              <span className="qi-finding-kind">{KIND_LABEL[f.kind] ?? f.kind}</span>
              <SeverityBadge severity={f.severity} />
            </div>
            <p className="qi-finding-summary">{f.summaryRedacted}</p>
          </li>
        ))}
      </ul>
      {visible < total ? (
        <button
          type="button"
          className="qi-btn qi-btn-secondary qi-show-more"
          onClick={() => {
            setVisible((v) => v + INITIAL_VISIBLE_ROWS);
          }}
        >
          Show more findings ({(total - visible).toString()} remaining)
        </button>
      ) : null}
    </section>
  );
}

const COVERAGE_STATUS_LABEL: Readonly<Record<"covered" | "weakly-covered" | "uncovered", string>> =
  {
    covered: "Covered",
    "weakly-covered": "Weakly covered",
    uncovered: "Uncovered",
  };

const COVERAGE_STATUS_CLASS: Readonly<Record<"covered" | "weakly-covered" | "uncovered", string>> =
  {
    covered: "qi-cov-covered",
    "weakly-covered": "qi-cov-weak",
    uncovered: "qi-cov-uncovered",
  };

function CoveragePanel({ detail }: { readonly detail: QualityIntelligenceUiRunDetail }): ReactNode {
  const [visibleGaps, setVisibleGaps] = useState(INITIAL_VISIBLE_ROWS);
  // Derive once per fetch — coverageByAtom only changes when `detail` is replaced, not on the
  // show-more state change (the old code re-filtered the whole matrix on every render).
  const { total, coveredCount, gaps } = useMemo(() => {
    const rows = detail.coverageByAtom;
    return {
      total: rows.length,
      coveredCount: rows.filter((r) => r.status === "covered").length,
      gaps: rows.filter((r) => r.status !== "covered"),
    };
  }, [detail.coverageByAtom]);
  if (total === 0) return null;
  const shownGaps = gaps.slice(0, visibleGaps);
  return (
    <section className="qi-coverage-panel" aria-label="Coverage">
      <h3 className="qi-col-subtitle">
        Coverage
        <span
          className="qi-badge qi-badge-default"
          aria-label={`Coverage: ${detail.coveragePercentage.toFixed(0)} percent, ${coveredCount.toString()} of ${total.toString()} requirements covered`}
          data-testid="qi-coverage-pct"
        >
          {detail.coveragePercentage.toFixed(0)}%
        </span>
      </h3>
      <p className="qi-coverage-summary" data-testid="qi-coverage-summary">
        {`${coveredCount.toString()} of ${total.toString()} requirements covered · ${gaps.length.toString()} gap${gaps.length === 1 ? "" : "s"}`}
      </p>
      {gaps.length > 0 ? (
        <section className="qi-coverage-gaps" aria-label="Gap radar">
          <h4 className="qi-col-subtitle">{`Gap radar (${gaps.length.toString()})`}</h4>
          <ul className="qi-coverage-gap-list" aria-label="Uncovered and weakly covered atoms">
            {shownGaps.map((row) => {
              const label = COVERAGE_STATUS_LABEL[row.status];
              const cls = COVERAGE_STATUS_CLASS[row.status];
              const excerpt = row.requirementExcerptRedacted;
              return (
                <li
                  key={row.atomId}
                  className="qi-coverage-gap-item"
                  aria-label={
                    excerpt === undefined
                      ? `Atom ${row.atomId}: ${label}`
                      : `Requirement "${excerpt}" (atom ${row.atomId}): ${label}`
                  }
                >
                  <span className="qi-coverage-gap-req">
                    {excerpt === undefined ? null : (
                      <span className="qi-coverage-gap-text" data-testid="qi-coverage-gap-text">
                        {excerpt}
                      </span>
                    )}
                    <span className="qi-coverage-atom-id qi-monospace">{row.atomId}</span>
                  </span>
                  <span className={`qi-badge ${cls}`} aria-hidden="true">
                    {label}
                  </span>
                  <span className="qi-sr-only">{label}</span>
                </li>
              );
            })}
          </ul>
          {visibleGaps < gaps.length ? (
            <button
              type="button"
              className="qi-btn qi-btn-secondary qi-show-more"
              onClick={() => {
                setVisibleGaps((v) => v + INITIAL_VISIBLE_ROWS);
              }}
            >
              Show more gaps ({(gaps.length - visibleGaps).toString()} remaining)
            </button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function DriftUnavailablePanel({
  detail,
}: {
  readonly detail: QualityIntelligenceUiRunDetail;
}): ReactNode {
  const noteId = useId();
  if (!detail.drift.reCheckSupported) return null;
  return (
    <section className="qi-drift-panel" aria-label="Drift detection">
      <div className="qi-drift-head">
        <h3 className="qi-col-subtitle">Living tests</h3>
        {/* a11y m-03: aria-disabled (not native `disabled`) keeps the control focusable so keyboard
            and screen-reader users can reach it and hear WHY it is inactive via aria-describedby —
            the same governance pattern used everywhere else in the QI surface. The click no-ops. */}
        <button
          type="button"
          className="qi-btn qi-btn-secondary"
          aria-disabled="true"
          aria-describedby={noteId}
          data-testid="qi-drift-recheck-unavailable"
          onClick={(event) => {
            event.preventDefault();
          }}
        >
          Re-check drift
        </button>
      </div>
      <p id={noteId} className="qi-drift-note" data-testid="qi-drift-unavailable">
        Drift fingerprints are recorded for this run, but this card has no current source handle.
        Reopen it from the connected source or start a new run from the current source.
      </p>
    </section>
  );
}

export function QiRunCard({
  runId,
  connectedSources,
  onRegenerated,
  fetchDetailImpl = fetchQiRunDetail,
  reviewImpl = reviewQiRun,
  editImpl = editQiCandidate,
  reCheckImpl,
  regenerateImpl,
}: QiRunCardProps): ReactNode {
  const [detail, setDetail] = useState<QualityIntelligenceUiRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A failed review action must NOT replace the whole card with an ErrorState (uiux-fix F030
  // C113): it is shown as a dismissible alert above the still-rendered content instead.
  const [actionError, setActionError] = useState<string | null>(null);
  // The review request currently in flight (uiux-fix F029 C275): locks the review controls, labels
  // the clicked button "Saving…", and guards against duplicate submits from an impatient double-click.
  const [pendingReview, setPendingReview] = useState<QiPendingReview | null>(null);
  const [reviewerLabel, setReviewerLabel] = useState("");
  const [reviewerLabelLoaded, setReviewerLabelLoaded] = useState(false);
  const reviewerHelpId = useId();
  const reviewerWarningId = useId();
  // Issue #282 A11y-1 (WCAG 4.1.3): dedicated live region for review-outcome announcements.
  // The existing "Run loaded: N test cases" region de-dupes when the text is byte-identical across
  // successive reviews (AT suppresses repeated identical strings). This separate region carries a
  // varying announcement (candidate title + resulting state label) so AT always re-announces even
  // when the same action is applied twice in a row (e.g. reopening the same candidate twice).
  const [reviewAnnounce, setReviewAnnounce] = useState("");
  // Monotonic nonce appended to the message guarantees uniqueness on identical repeat actions.
  const announceNonceRef = useRef(0);

  // Drop stale responses when the same card re-fetches after a review (request-of-record guard).
  const seqRef = useRef(0);

  const loadDetail = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDetailImpl(runId);
      if (seqRef.current === seq) setDetail(res);
    } catch (err) {
      if (seqRef.current === seq) setError(formatError(err));
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [fetchDetailImpl, runId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    setReviewerLabel(readStoredReviewerLabel());
    setReviewerLabelLoaded(true);
  }, []);

  useEffect(() => {
    if (!reviewerLabelLoaded || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(REVIEWER_LABEL_STORAGE_KEY, reviewerLabel);
    } catch {
      // localStorage may be unavailable in hardened browser contexts.
    }
  }, [reviewerLabel, reviewerLabelLoaded]);

  const trimmedReviewerLabel = reviewerLabel.trim();
  const governanceEnabled = trimmedReviewerLabel.length > 0;

  const handleReview = useCallback(
    (candidateId: string, action: QiReviewAction): void => {
      if (!governanceEnabled || pendingReview !== null) return;
      setPendingReview({ candidateId, action });
      void (async (): Promise<void> => {
        setActionError(null);
        try {
          await reviewImpl(runId, action, candidateId, trimmedReviewerLabel);
          await loadDetail();
          // Issue #282 A11y-1: announce the review outcome via a dedicated live region.
          // The label map maps the action to the resulting visible state ("reopen" → "Open").
          // A monotonic nonce guarantees the string differs on identical repeat actions so AT
          // always re-reads it (AT suppresses byte-identical repeated announcements).
          const resultLabel =
            REVIEW_LABEL[
              action === "approve"
                ? "approved"
                : action === "reject"
                  ? "rejected"
                  : action === "request-changes"
                    ? "changes-requested"
                    : "open" // reopen → open
            ];
          // Look up the candidate title from the last-loaded detail snapshot (best effort: the
          // reload above may have updated state but setDetail is async; use the snapshot we had
          // at the time of the call — the title is immutable so this is always correct).
          const candidateTitle =
            detail?.candidates.find((c) => c.id === candidateId)?.title ?? candidateId;
          announceNonceRef.current += 1;
          setReviewAnnounce(
            `Candidate "${candidateTitle}" marked ${resultLabel}. (${announceNonceRef.current.toString()})`,
          );
        } catch (err) {
          setActionError(formatError(err));
        } finally {
          setPendingReview(null);
        }
      })();
    },
    // detail is included so the announcement always resolves the candidate title from the current
    // loaded snapshot (title is immutable per run so the lookup is always correct).
    [governanceEnabled, pendingReview, reviewImpl, runId, trimmedReviewerLabel, loadDetail, detail],
  );

  const handleEdit = useCallback(
    async (
      candidateId: string,
      edited: QualityIntelligenceCandidateEditableFields,
    ): Promise<void> => {
      if (!governanceEnabled) {
        throw new Error(GOVERNANCE_REQUIRED_MESSAGE);
      }
      await editImpl(runId, candidateId, edited, trimmedReviewerLabel);
      await loadDetail();
    },
    [editImpl, governanceEnabled, runId, trimmedReviewerLabel, loadDetail],
  );

  return (
    <div className="qi-run-card" data-testid="qi-run-card">
      <header className="qi-run-card-head">
        {/* a11y m-02: name the card as a level-2 heading so the inner section <h3>s are not
            orphaned and screen-reader heading navigation can reach the card. role="heading" keeps
            the existing monospace run-id visual unchanged (no font/structure change). */}
        <span
          className="qi-run-id qi-monospace"
          title={runId}
          role="heading"
          aria-level={2}
          aria-label={`Quality Intelligence run ${runId}`}
        >
          {runId}
        </span>
      </header>
      {/* uiux-fix F030 C111: the live region is a small persistent sr-only status line — NOT the
          whole card body. role="status" on the body (implicit aria-atomic) re-announced every
          candidate after each review/edit reload, and interactive controls inside a live region
          are an anti-pattern. Load errors announce via ErrorState's own role="alert". */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading
          ? "Loading run…"
          : error === null && detail !== null
            ? `Run loaded: ${detail.totals.candidates.toString()} test case${detail.totals.candidates === 1 ? "" : "s"}.`
            : ""}
      </p>
      {/* Issue #282 A11y-1 (WCAG 4.1.3): dedicated review-outcome live region, separate from the
          load-status region above. The load region announces "Run loaded: N test cases" on every
          reload — byte-identical across review actions — so AT de-duplicates → silence. This
          region carries a unique string (candidate title + resulting state label + nonce) so AT
          always re-announces the outcome. sr-only: no visible change, purely for AT users. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="qi-review-announce">
        {reviewAnnounce}
      </p>
      <div className="qi-run-card-body" aria-busy={loading}>
        {loading && detail === null ? (
          <LoadingSkeleton />
        ) : error !== null ? (
          <ErrorState message={error} onRetry={() => void loadDetail()} />
        ) : detail === null ? (
          <div className="lk-empty">
            <p className="lk-empty-body">Run not found.</p>
          </div>
        ) : (
          <>
            {actionError !== null ? (
              <div className="lk-alert qi-action-error" role="alert" data-testid="qi-action-error">
                {actionError}
                <button
                  type="button"
                  className="lk-alert-retry"
                  onClick={() => {
                    setActionError(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            <section className="qi-run-governance" aria-label="Review governance">
              <label className="qi-field" htmlFor={`qi-reviewer-label-${runId}`}>
                <span className="qi-field-label">Reviewer label</span>
                <input
                  id={`qi-reviewer-label-${runId}`}
                  className="qi-input qi-run-governance-input"
                  value={reviewerLabel}
                  placeholder="Required for review and edit actions"
                  aria-invalid={!governanceEnabled}
                  aria-describedby={
                    governanceEnabled ? reviewerHelpId : `${reviewerHelpId} ${reviewerWarningId}`
                  }
                  onChange={(event) => {
                    setReviewerLabel(event.target.value);
                  }}
                />
              </label>
              <p id={reviewerHelpId} className="qi-run-governance-help">
                Used for QI review and edit audit entries.
              </p>
              {/* Persistent live region (a11y M-02): always mounted so AT announces when the user
                  clears the reviewer label and governance turns off. role="note" carries no implicit
                  aria-live, and a conditionally-inserted region is unreliably announced. Empty (and
                  visually nothing — the class has no box) while governance is enabled. */}
              <p
                id={reviewerWarningId}
                className="qi-run-governance-warning"
                role="status"
                aria-live="polite"
              >
                {!governanceEnabled ? GOVERNANCE_REQUIRED_MESSAGE : ""}
              </p>
            </section>
            <SummaryStrip detail={detail} />
            <FindingsList detail={detail} />
            <CoveragePanel detail={detail} />
            {connectedSources !== undefined && connectedSources.length > 0 ? (
              <DriftPanel
                runId={runId}
                connectedSources={connectedSources}
                onRegenerated={onRegenerated}
                reCheckImpl={reCheckImpl}
                regenerateImpl={regenerateImpl}
              />
            ) : (
              <DriftUnavailablePanel detail={detail} />
            )}
            <section className="qi-run-cases" aria-label="Generated test cases">
              <div className="qi-run-cases-head">
                <h3 className="qi-col-subtitle">
                  Test cases
                  <span className="qi-col-count">{detail.candidates.length.toString()}</span>
                </h3>
                {detail.candidates.length > 0 ? <ExportBar runId={runId} /> : null}
              </div>
              <CandidatesPane
                candidates={detail.candidates}
                onReview={handleReview}
                pendingReview={pendingReview}
                onEdit={handleEdit}
                actionsDisabled={!governanceEnabled}
                actionsDisabledReason={GOVERNANCE_REQUIRED_MESSAGE}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
