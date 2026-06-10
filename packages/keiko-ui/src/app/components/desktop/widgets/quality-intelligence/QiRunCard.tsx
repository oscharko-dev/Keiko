"use client";

// Quality Intelligence run result card (Epic #270, Issue #280/#282/#283). One card per run, opened
// from the QI hub and keyed by runId. Shows the run summary, the generated test cases (responsive
// grid with per-candidate review), enterprise export, and any validation findings. Reuses the QI BFF
// routes; never embeds raw prompts or secrets (the wire projection is already redacted upstream).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceCandidateEditableFields,
} from "@oscharko-dev/keiko-contracts";
import {
  editQiCandidate,
  fetchQiRunDetail,
  reviewQiRun,
  type QiReviewAction,
} from "@/lib/quality-intelligence-api";
import { CandidatesPane } from "./CandidatesPane";
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
        <dd className="qi-run-summary-review">{detail.reviewState}</dd>
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

function FindingsList({ detail }: { readonly detail: QualityIntelligenceUiRunDetail }): ReactNode {
  if (detail.findingRefs.length === 0) return null;
  return (
    <section className="qi-run-findings" aria-label="Findings">
      <h3 className="qi-col-subtitle">
        Findings
        <span className="qi-col-count">{detail.findingRefs.length.toString()}</span>
      </h3>
      <ul className="qi-finding-list" aria-label="Findings list">
        {detail.findingRefs.map((f) => (
          <li key={f.id} className="qi-finding-item">
            <div className="qi-finding-header">
              <span className="qi-finding-kind">{f.kind}</span>
              <SeverityBadge severity={f.severity} />
            </div>
            <p className="qi-finding-summary">{f.summaryRedacted}</p>
          </li>
        ))}
      </ul>
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
  if (detail.coverageByAtom.length === 0) return null;
  const total = detail.coverageByAtom.length;
  const coveredCount = detail.coverageByAtom.filter((r) => r.status === "covered").length;
  const gaps = detail.coverageByAtom.filter((r) => r.status !== "covered");
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
            {gaps.map((row) => {
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
        </section>
      ) : null}
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
  const [reviewerLabel, setReviewerLabel] = useState("");
  const [reviewerLabelLoaded, setReviewerLabelLoaded] = useState(false);
  const reviewerHelpId = useId();
  const reviewerWarningId = useId();

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
      if (!governanceEnabled) return;
      void (async (): Promise<void> => {
        try {
          await reviewImpl(runId, action, candidateId, trimmedReviewerLabel);
          await loadDetail();
        } catch (err) {
          setError(formatError(err));
        }
      })();
    },
    [governanceEnabled, reviewImpl, runId, trimmedReviewerLabel, loadDetail],
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
        <span className="qi-run-id qi-monospace" title={runId}>
          {runId}
        </span>
      </header>
      <div className="qi-run-card-body" role="status" aria-live="polite" aria-busy={loading}>
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
              {!governanceEnabled ? (
                <p id={reviewerWarningId} className="qi-run-governance-warning" role="note">
                  {GOVERNANCE_REQUIRED_MESSAGE}
                </p>
              ) : null}
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
            ) : null}
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
