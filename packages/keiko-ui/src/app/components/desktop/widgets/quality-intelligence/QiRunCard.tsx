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
import { reviewActionResultState } from "@oscharko-dev/keiko-contracts";
import { useQiTranslate as useTranslate, type I18nTranslate } from "./qi-i18n";
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
  reviewLabel,
} from "./qiShared";

const REVIEWER_LABEL_STORAGE_KEY = "keiko.qi.reviewerLabel";
const GOVERNANCE_REQUIRED_MESSAGE =
  "Add a display label for audit notes; review identity is resolved by the server.";

function clearLegacyDurableReviewerLabel(): void {
  try {
    window.localStorage.removeItem(REVIEWER_LABEL_STORAGE_KEY);
  } catch {
    // Hardened browser contexts may make localStorage unavailable.
  }
}

function readStoredReviewerLabel(): string {
  if (typeof window === "undefined") return "";
  clearLegacyDurableReviewerLabel();
  try {
    return window.sessionStorage.getItem(REVIEWER_LABEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredReviewerLabel(value: string): void {
  if (typeof window === "undefined") return;
  clearLegacyDurableReviewerLabel();
  try {
    if (value.length > 0) window.sessionStorage.setItem(REVIEWER_LABEL_STORAGE_KEY, value);
    else window.sessionStorage.removeItem(REVIEWER_LABEL_STORAGE_KEY);
  } catch {
    // sessionStorage may be unavailable in hardened browser contexts.
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

function SummaryStrip({
  detail,
  t,
}: {
  readonly detail: QualityIntelligenceUiRunDetail;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <dl className="qi-run-summary" aria-label={t("qi.run.summary")}>
      <div className="qi-run-summary-item">
        <dt>{t("common.status")}</dt>
        <dd>
          <StatusBadge status={detail.status} />
        </dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>{t("qi.run.testCases")}</dt>
        <dd>{detail.totals.candidates.toString()}</dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>{t("qi.run.findings")}</dt>
        <dd>{detail.totals.findings.toString()}</dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>{t("qi.run.quality")}</dt>
        <dd>
          <QualityScoreBadge score={detail.qualityScore} />
        </dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>{t("qi.run.review")}</dt>
        <dd className="qi-run-summary-review">{reviewLabel(detail.reviewState, t)}</dd>
      </div>
      <div className="qi-run-summary-item">
        <dt>{t("qi.run.requested")}</dt>
        <dd>{formatDate(detail.requestedAt)}</dd>
      </div>
      {detail.completedAt !== null ? (
        <div className="qi-run-summary-item">
          <dt>{t("qi.run.completed")}</dt>
          <dd>{formatDate(detail.completedAt)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

// Human labels for the contract's finding-kind tokens (uiux-fix F030 C273) — the raw machine
// tokens ("logic-defect") used to render via CSS capitalize as "Logic-Defect". Unknown kinds
// fall back to the raw value.
function findingKindLabel(kind: string, t: I18nTranslate): string {
  if (kind === "logic-defect") return t("qi.finding.logicDefect");
  if (kind === "faithfulness-defect") return t("qi.finding.faithfulnessDefect");
  if (kind === "semantic-defect") return t("qi.finding.semanticDefect");
  if (kind === "mutation-defect") return t("qi.finding.mutationDefect");
  if (kind === "policy-violation") return t("qi.finding.policyViolation");
  if (kind === "manual-rejection") return t("qi.finding.manualRejection");
  if (kind === "coverage-gap") return t("qi.finding.coverageGap");
  if (kind === "test-quality") return t("qi.finding.testQuality");
  return kind;
}

// Findings, coverage gaps, and the run list can each grow to hundreds of rows (findings are capped
// at 512 server-side; the coverage gap radar has NO server cap and scales with source-atom count).
// Render the first page eagerly and reveal the rest on demand — the #280 "progressive rendering for
// large artifact lists" Deliverable, mirroring CandidatesPane's INITIAL_VISIBLE pattern.
const INITIAL_VISIBLE_ROWS = 20;

function FindingsList({
  detail,
  t,
}: {
  readonly detail: QualityIntelligenceUiRunDetail;
  readonly t: I18nTranslate;
}): ReactNode {
  const [visible, setVisible] = useState(INITIAL_VISIBLE_ROWS);
  const total = detail.findingRefs.length;
  if (total === 0) return null;
  const shown = detail.findingRefs.slice(0, visible);
  return (
    <section className="qi-run-findings" aria-label={t("qi.run.findings")}>
      <h3 className="qi-col-subtitle">
        {t("qi.run.findings")}
        <span className="qi-col-count">{total.toString()}</span>
      </h3>
      <ul className="qi-finding-list" aria-label={t("qi.finding.list")}>
        {shown.map((f) => (
          <li key={f.id} className="qi-finding-item">
            <div className="qi-finding-header">
              <span className="qi-finding-kind">{findingKindLabel(f.kind, t)}</span>
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
          {t("qi.finding.showMore", { count: total - visible })}
        </button>
      ) : null}
    </section>
  );
}

function coverageStatusLabel(
  status: "covered" | "weakly-covered" | "uncovered",
  t: I18nTranslate,
): string {
  if (status === "covered") return t("qi.coverage.covered");
  if (status === "weakly-covered") return t("qi.coverage.weaklyCovered");
  return t("qi.coverage.uncovered");
}

function coverageSummaryText(
  coveredCount: number,
  total: number,
  gapCount: number,
  t: I18nTranslate,
): string {
  return gapCount === 1
    ? t("qi.coverage.summary.oneGap", { covered: coveredCount, total })
    : t("qi.coverage.summary.manyGaps", {
        covered: coveredCount,
        total,
        gaps: gapCount,
      });
}

const COVERAGE_STATUS_CLASS: Readonly<Record<"covered" | "weakly-covered" | "uncovered", string>> =
  {
    covered: "qi-cov-covered",
    "weakly-covered": "qi-cov-weak",
    uncovered: "qi-cov-uncovered",
  };

// Gap-radar display severity: uncovered (no covering test at all) is the most severe gap, then
// weakly-covered (only incidental coverage). The server emits coverageByAtom sorted by atomId, NOT
// by severity (coverageRelevance.buildAtomCoverageStatuses), so without this the gap radar lists
// gaps in opaque hash order and the worst gaps can fall below the INITIAL_VISIBLE_ROWS fold on
// large runs. Surfacing uncovered first mirrors the server's sort-before-truncate invariant for
// findings (#738/#1066) and satisfies the #739 intent: "see at a glance what is NOT tested".
const COVERAGE_GAP_SEVERITY_ORDER: Readonly<
  Record<"covered" | "weakly-covered" | "uncovered", number>
> = { uncovered: 0, "weakly-covered": 1, covered: 2 };

function CoveragePanel({
  detail,
  t,
}: {
  readonly detail: QualityIntelligenceUiRunDetail;
  readonly t: I18nTranslate;
}): ReactNode {
  const [visibleGaps, setVisibleGaps] = useState(INITIAL_VISIBLE_ROWS);
  // Derive once per fetch — coverageByAtom only changes when `detail` is replaced, not on the
  // show-more state change (the old code re-filtered the whole matrix on every render).
  const { total, coveredCount, gaps } = useMemo(() => {
    const rows = detail.coverageByAtom;
    // `.filter()` returns a fresh array, so the in-place `.sort()` never mutates detail.coverageByAtom.
    // Array.prototype.sort is stable (ES2019+), so atoms keep their server atomId order within a tier.
    return {
      total: rows.length,
      coveredCount: rows.filter((r) => r.status === "covered").length,
      gaps: rows
        .filter((r) => r.status !== "covered")
        .sort(
          (a, b) => COVERAGE_GAP_SEVERITY_ORDER[a.status] - COVERAGE_GAP_SEVERITY_ORDER[b.status],
        ),
    };
  }, [detail.coverageByAtom]);
  if (total === 0) return null;
  const shownGaps = gaps.slice(0, visibleGaps);
  return (
    <section className="qi-coverage-panel" aria-label={t("qi.coverage.title")}>
      <h3 className="qi-col-subtitle">
        {t("qi.coverage.title")}
        <span
          className="qi-badge qi-badge-default"
          aria-label={t("qi.coverage.percentAria", {
            percent: detail.coveragePercentage.toFixed(0),
            covered: coveredCount,
            total,
          })}
          data-testid="qi-coverage-pct"
        >
          {detail.coveragePercentage.toFixed(0)}%
        </span>
      </h3>
      <p className="qi-coverage-summary" data-testid="qi-coverage-summary">
        {coverageSummaryText(coveredCount, total, gaps.length, t)}
      </p>
      {gaps.length > 0 ? (
        <section className="qi-coverage-gaps" aria-label={t("qi.coverage.gapRadar")}>
          <h4 className="qi-col-subtitle">
            {t("qi.coverage.gapRadarCount", { count: gaps.length })}
          </h4>
          <ul className="qi-coverage-gap-list" aria-label={t("qi.coverage.gapList")}>
            {shownGaps.map((row) => {
              const label = coverageStatusLabel(row.status, t);
              const cls = COVERAGE_STATUS_CLASS[row.status];
              const excerpt = row.requirementExcerptRedacted;
              return (
                <li
                  key={row.atomId}
                  className="qi-coverage-gap-item"
                  aria-label={
                    excerpt === undefined
                      ? t("qi.coverage.atomAria", { atomId: row.atomId, label })
                      : t("qi.coverage.requirementAria", { excerpt, atomId: row.atomId, label })
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
              {t("qi.coverage.showMoreGaps", { count: gaps.length - visibleGaps })}
            </button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function DriftUnavailablePanel({
  detail,
  t,
}: {
  readonly detail: QualityIntelligenceUiRunDetail;
  readonly t: I18nTranslate;
}): ReactNode {
  const noteId = useId();
  if (!detail.drift.reCheckSupported) return null;
  return (
    <section className="qi-drift-panel" aria-label={t("qi.drift.title")}>
      <div className="qi-drift-head">
        <h3 className="qi-col-subtitle">{t("qi.drift.livingTests")}</h3>
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
          {t("qi.drift.recheck")}
        </button>
      </div>
      <p id={noteId} className="qi-drift-note" data-testid="qi-drift-unavailable">
        {t("qi.drift.unavailable")}
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
  const t = useTranslate();
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
    writeStoredReviewerLabel(reviewerLabel);
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
          // The shared contracts projection maps the action to the resulting review state
          // ("reopen" → "open", "withdraw" → "withdrawn", …) and REVIEW_LABEL renders its human
          // label. A monotonic nonce guarantees the string differs on identical repeat actions so AT
          // always re-reads it (AT suppresses byte-identical repeated announcements).
          const resultLabel = reviewLabel(reviewActionResultState(action), t);
          // Look up the candidate title from the last-loaded detail snapshot (best effort: the
          // reload above may have updated state but setDetail is async; use the snapshot we had
          // at the time of the call — the title is immutable so this is always correct).
          const candidateTitle =
            detail?.candidates.find((c) => c.id === candidateId)?.title ?? candidateId;
          announceNonceRef.current += 1;
          setReviewAnnounce(
            t("qi.review.announce", {
              title: candidateTitle,
              state: resultLabel,
              nonce: announceNonceRef.current,
            }),
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
    [
      governanceEnabled,
      pendingReview,
      reviewImpl,
      runId,
      trimmedReviewerLabel,
      loadDetail,
      detail,
      t,
    ],
  );

  const handleEdit = useCallback(
    async (
      candidateId: string,
      edited: QualityIntelligenceCandidateEditableFields,
    ): Promise<void> => {
      if (!governanceEnabled) {
        throw new Error(t("qi.governance.required"));
      }
      await editImpl(runId, candidateId, edited, trimmedReviewerLabel);
      await loadDetail();
    },
    [editImpl, governanceEnabled, runId, trimmedReviewerLabel, loadDetail, t],
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
          aria-label={t("qi.run.aria", { runId })}
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
          ? t("qi.run.loading")
          : error === null && detail !== null
            ? t("qi.run.loaded", { count: detail.totals.candidates })
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
            <p className="lk-empty-body">{t("qi.run.notFound")}</p>
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
                  {t("common.dismiss")}
                </button>
              </div>
            ) : null}
            <section className="qi-run-governance" aria-label={t("qi.governance.title")}>
              <label className="qi-field" htmlFor={`qi-reviewer-label-${runId}`}>
                <span className="qi-field-label">{t("qi.governance.auditLabel")}</span>
                <input
                  id={`qi-reviewer-label-${runId}`}
                  className="qi-input qi-run-governance-input"
                  value={reviewerLabel}
                  placeholder={t("qi.governance.auditPlaceholder")}
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
                {t("qi.governance.help")}
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
                {!governanceEnabled ? t("qi.governance.required") : ""}
              </p>
            </section>
            <SummaryStrip detail={detail} t={t} />
            <FindingsList detail={detail} t={t} />
            <CoveragePanel detail={detail} t={t} />
            {connectedSources !== undefined && connectedSources.length > 0 ? (
              <DriftPanel
                runId={runId}
                connectedSources={connectedSources}
                onRegenerated={onRegenerated}
                reCheckImpl={reCheckImpl}
                regenerateImpl={regenerateImpl}
              />
            ) : (
              <DriftUnavailablePanel detail={detail} t={t} />
            )}
            <section className="qi-run-cases" aria-label={t("qi.run.generatedTestCases")}>
              <div className="qi-run-cases-head">
                <h3 className="qi-col-subtitle">
                  {t("qi.run.testCases")}
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
                actionsDisabledReason={t("qi.governance.required")}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
