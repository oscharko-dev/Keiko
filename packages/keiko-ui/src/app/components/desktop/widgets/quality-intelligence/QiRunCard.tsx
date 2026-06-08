"use client";

// Quality Intelligence run result card (Epic #270, Issue #280/#282/#283). One card per run, opened
// from the QI hub and keyed by runId. Shows the run summary, the generated test cases (responsive
// grid with per-candidate review), enterprise export, and any validation findings. Reuses the QI BFF
// routes; never embeds raw prompts or secrets (the wire projection is already redacted upstream).

import { useCallback, useEffect, useRef, useState } from "react";
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
import { ExportBar } from "./ExportBar";
import {
  StatusBadge,
  SeverityBadge,
  LoadingSkeleton,
  ErrorState,
  formatError,
  formatDate,
} from "./qiShared";

export interface QiRunCardProps {
  readonly runId: string;
  /** Seam for tests. */
  readonly fetchDetailImpl?: typeof fetchQiRunDetail;
  readonly reviewImpl?: typeof reviewQiRun;
  readonly editImpl?: typeof editQiCandidate;
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

export function QiRunCard({
  runId,
  fetchDetailImpl = fetchQiRunDetail,
  reviewImpl = reviewQiRun,
  editImpl = editQiCandidate,
}: QiRunCardProps): ReactNode {
  const [detail, setDetail] = useState<QualityIntelligenceUiRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const handleReview = useCallback(
    (candidateId: string, action: QiReviewAction): void => {
      void (async (): Promise<void> => {
        try {
          await reviewImpl(runId, action, candidateId);
        } finally {
          await loadDetail();
        }
      })();
    },
    [reviewImpl, runId, loadDetail],
  );

  const handleEdit = useCallback(
    async (
      candidateId: string,
      edited: QualityIntelligenceCandidateEditableFields,
    ): Promise<void> => {
      try {
        await editImpl(runId, candidateId, edited);
      } finally {
        await loadDetail();
      }
    },
    [editImpl, runId, loadDetail],
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
            <SummaryStrip detail={detail} />
            <FindingsList detail={detail} />
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
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
