"use client";

// Quality Intelligence generated-candidate review surface (Issue #280/#282, Epic #270).
// Renders the authored test-case bodies for a run with their review state, and (when a review
// handler is supplied) per-candidate approve / reject / request-changes controls. Large lists use
// progressive rendering (capped initial slice + "show more") to stay responsive (#280 engineering
// note). Accessible: list semantics, focus-visible controls, aria-live review state.

import { useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceUiCandidate,
  QualityIntelligenceReviewState,
} from "@oscharko-dev/keiko-contracts";

const INITIAL_VISIBLE = 25;

export type QiReviewAction = "approve" | "reject" | "request-changes" | "reopen";

const REVIEW_LABEL: Readonly<Record<QualityIntelligenceReviewState, string>> = {
  open: "Open",
  approved: "Approved",
  "changes-requested": "Changes requested",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const REVIEW_CLASS: Readonly<Record<QualityIntelligenceReviewState, string>> = {
  open: "qi-review-open",
  approved: "qi-review-approved",
  "changes-requested": "qi-review-changes",
  rejected: "qi-review-rejected",
  withdrawn: "qi-review-withdrawn",
};

function ReviewBadge({ state }: { readonly state: QualityIntelligenceReviewState }): ReactNode {
  return (
    <span
      className={`qi-review-badge ${REVIEW_CLASS[state]}`}
      aria-label={`Review: ${REVIEW_LABEL[state]}`}
    >
      {REVIEW_LABEL[state]}
    </span>
  );
}

function StringList({
  items,
  label,
}: {
  readonly items: readonly string[];
  readonly label: string;
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <div className="qi-cand-block">
      <p className="qi-cand-block-label">{label}</p>
      <ol className="qi-cand-list" aria-label={label}>
        {items.map((item, i) => (
          <li key={`${label}-${String(i)}`}>{item}</li>
        ))}
      </ol>
    </div>
  );
}

function ReviewControls({
  candidateId,
  state,
  onReview,
}: {
  readonly candidateId: string;
  readonly state: QualityIntelligenceReviewState;
  readonly onReview: (candidateId: string, action: QiReviewAction) => void;
}): ReactNode {
  return (
    <div className="qi-cand-actions" role="group" aria-label="Review decision">
      <button
        type="button"
        className="qi-btn qi-btn-approve"
        aria-pressed={state === "approved"}
        onClick={() => {
          onReview(candidateId, "approve");
        }}
      >
        Approve
      </button>
      <button
        type="button"
        className="qi-btn qi-btn-reject"
        aria-pressed={state === "rejected"}
        onClick={() => {
          onReview(candidateId, "reject");
        }}
      >
        Reject
      </button>
      <button
        type="button"
        className="qi-btn qi-btn-secondary"
        aria-pressed={state === "changes-requested"}
        onClick={() => {
          onReview(candidateId, "request-changes");
        }}
      >
        Request changes
      </button>
    </div>
  );
}

function CandidateCard({
  candidate,
  onReview,
}: {
  readonly candidate: QualityIntelligenceUiCandidate;
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
}): ReactNode {
  return (
    <li className="qi-cand-card">
      <div className="qi-cand-header">
        <h3 className="qi-cand-title">{candidate.title}</h3>
        <div className="qi-cand-badges">
          <span className="qi-cand-pri">{candidate.priority}</span>
          <span className="qi-cand-risk">{candidate.riskClass}</span>
          <ReviewBadge state={candidate.reviewState} />
        </div>
      </div>
      <StringList items={candidate.preconditions} label="Preconditions" />
      <StringList items={candidate.steps} label="Steps" />
      <StringList items={candidate.expectedResults} label="Expected results" />
      {candidate.tags.length > 0 ? (
        <ul className="qi-cand-tags" aria-label="Tags">
          {candidate.tags.map((t) => (
            <li key={t} className="qi-cand-tag">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      {onReview !== undefined ? (
        <ReviewControls
          candidateId={candidate.id}
          state={candidate.reviewState}
          onReview={onReview}
        />
      ) : null}
    </li>
  );
}

export interface CandidatesPaneProps {
  readonly candidates: readonly QualityIntelligenceUiCandidate[];
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
}

export function CandidatesPane({ candidates, onReview }: CandidatesPaneProps): ReactNode {
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  if (candidates.length === 0) {
    return (
      <div className="lk-empty">
        <p className="lk-empty-title">No test cases</p>
        <p className="lk-empty-body">This run produced no generated test cases.</p>
      </div>
    );
  }
  const shown = candidates.slice(0, visible);
  return (
    <div className="qi-cand-pane">
      <ul className="qi-cand-cards" aria-label="Generated test cases">
        {shown.map((c) => (
          <CandidateCard key={c.id} candidate={c} onReview={onReview} />
        ))}
      </ul>
      {visible < candidates.length ? (
        <button
          type="button"
          className="qi-btn qi-btn-secondary qi-cand-more"
          onClick={() => {
            setVisible((v) => v + INITIAL_VISIBLE);
          }}
        >
          Show more ({(candidates.length - visible).toString()} remaining)
        </button>
      ) : null}
    </div>
  );
}
