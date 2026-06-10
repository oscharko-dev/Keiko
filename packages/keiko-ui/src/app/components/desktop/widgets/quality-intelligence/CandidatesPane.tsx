"use client";

// Quality Intelligence generated-candidate review surface (Issue #280/#282/#712, Epic #270/#712).
// Renders the authored test-case bodies for a run with their review state, per-candidate review
// controls (when a review handler is supplied), and inline editing (when an edit handler is
// supplied). Large lists use progressive rendering (capped initial slice + "show more") to stay
// responsive. Accessible: list semantics, focus-visible controls, labelled inputs, Escape cancels.

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import type {
  QualityIntelligenceUiCandidate,
  QualityIntelligenceReviewState,
  QualityIntelligenceCandidateEditableFields,
} from "@oscharko-dev/keiko-contracts";
import { CandidateEditForm } from "./CandidateEditForm";
import { REVIEW_LABEL, WeakTestFlag } from "./qiShared";

const INITIAL_VISIBLE = 25;

export type QiReviewAction = "approve" | "reject" | "request-changes" | "reopen";

export type QiCandidateEdit = (
  candidateId: string,
  edited: QualityIntelligenceCandidateEditableFields,
) => Promise<void> | void;

/** A review request currently in flight (no second request may start until it settles). */
export interface QiPendingReview {
  readonly candidateId: string;
  readonly action: QiReviewAction;
}

const REVIEW_CLASS: Readonly<Record<QualityIntelligenceReviewState, string>> = {
  open: "qi-review-open",
  approved: "qi-review-approved",
  "changes-requested": "qi-review-changes",
  rejected: "qi-review-rejected",
  withdrawn: "qi-review-withdrawn",
};

// No aria-label here: naming is prohibited on a generic <span> (ARIA 1.2), so assistive tech ignores
// it. The "Review:" context is supplied via a screen-reader-only prefix instead.
function ReviewBadge({ state }: { readonly state: QualityIntelligenceReviewState }): ReactNode {
  return (
    <span className={`qi-review-badge ${REVIEW_CLASS[state]}`}>
      <span className="sr-only">Review: </span>
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

// A governance-gated review/edit action. We use aria-disabled (NOT the native `disabled` attribute)
// so the control stays in the focus order and a screen reader announces both the action and its
// disabled reason via aria-describedby — native `disabled` removes the button from the a11y tree,
// making the "set a reviewer label" reason unreachable (mirrors ScopeConnectButton, Copilot PR #254).
function GovernedActionButton({
  className,
  label,
  pressed,
  disabled,
  describedBy,
  onActivate,
}: {
  readonly className: string;
  readonly label: string;
  readonly pressed?: boolean | undefined;
  readonly disabled: boolean;
  readonly describedBy?: string | undefined;
  readonly onActivate: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={className}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? describedBy : undefined}
      onClick={() => {
        if (disabled) return;
        onActivate();
      }}
    >
      {label}
    </button>
  );
}

function ReviewControls({
  candidateId,
  state,
  onReview,
  disabled = false,
  describedBy,
  pendingReview,
}: {
  readonly candidateId: string;
  readonly state: QualityIntelligenceReviewState;
  readonly onReview: (candidateId: string, action: QiReviewAction) => void;
  readonly disabled?: boolean;
  readonly describedBy?: string | undefined;
  readonly pendingReview?: QiPendingReview | null | undefined;
}): ReactNode {
  // While any review request is in flight, every review button is locked (aria-disabled keeps them
  // focusable) and the clicked one is relabelled "Saving…" so the round-trip has visible feedback.
  const reviewBusy = pendingReview !== null && pendingReview !== undefined;
  const isSaving = (action: QiReviewAction): boolean =>
    reviewBusy && pendingReview.candidateId === candidateId && pendingReview.action === action;
  return (
    <div className="qi-cand-actions" role="group" aria-label="Review decision">
      <GovernedActionButton
        className="qi-btn qi-btn-approve"
        label={isSaving("approve") ? "Saving…" : "Approve"}
        pressed={state === "approved"}
        disabled={disabled || reviewBusy}
        describedBy={describedBy}
        onActivate={() => {
          onReview(candidateId, "approve");
        }}
      />
      <GovernedActionButton
        className="qi-btn qi-btn-reject"
        label={isSaving("reject") ? "Saving…" : "Reject"}
        pressed={state === "rejected"}
        disabled={disabled || reviewBusy}
        describedBy={describedBy}
        onActivate={() => {
          onReview(candidateId, "reject");
        }}
      />
      <GovernedActionButton
        className="qi-btn qi-btn-secondary"
        label={isSaving("request-changes") ? "Saving…" : "Request changes"}
        pressed={state === "changes-requested"}
        disabled={disabled || reviewBusy}
        describedBy={describedBy}
        onActivate={() => {
          onReview(candidateId, "request-changes");
        }}
      />
    </div>
  );
}

function CandidateView({
  candidate,
  onReview,
  onStartEdit,
  actionsDisabled = false,
  describedBy,
  editButtonRef,
  pendingReview,
}: {
  readonly candidate: QualityIntelligenceUiCandidate;
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
  readonly onStartEdit?: (() => void) | undefined;
  readonly actionsDisabled?: boolean;
  readonly describedBy?: string | undefined;
  readonly editButtonRef?: Ref<HTMLButtonElement> | undefined;
  readonly pendingReview?: QiPendingReview | null | undefined;
}): ReactNode {
  return (
    <>
      <div className="qi-cand-header">
        <h3 className="qi-cand-title">{candidate.title}</h3>
        <div className="qi-cand-badges">
          <span className="qi-cand-pri">{candidate.priority}</span>
          <span className="qi-cand-risk">{candidate.riskClass}</span>
          <ReviewBadge state={candidate.reviewState} />
        </div>
      </div>
      {candidate.weakTestFlag !== undefined ? <WeakTestFlag flag={candidate.weakTestFlag} /> : null}
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
      <div className="qi-cand-actions-row">
        {onStartEdit !== undefined ? (
          <button
            ref={editButtonRef}
            type="button"
            className="qi-btn qi-btn-secondary qi-cand-edit"
            aria-disabled={actionsDisabled || undefined}
            aria-describedby={actionsDisabled ? describedBy : undefined}
            onClick={() => {
              if (actionsDisabled) return;
              onStartEdit();
            }}
          >
            Edit
          </button>
        ) : null}
        {onReview !== undefined ? (
          <ReviewControls
            candidateId={candidate.id}
            state={candidate.reviewState}
            onReview={onReview}
            disabled={actionsDisabled}
            describedBy={describedBy}
            pendingReview={pendingReview}
          />
        ) : null}
      </div>
    </>
  );
}

function CandidateCard({
  candidate,
  onReview,
  onEdit,
  actionsDisabled = false,
  describedBy,
  pendingReview,
}: {
  readonly candidate: QualityIntelligenceUiCandidate;
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
  readonly onEdit?: QiCandidateEdit | undefined;
  readonly actionsDisabled?: boolean;
  readonly describedBy?: string | undefined;
  readonly pendingReview?: QiPendingReview | null | undefined;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // Return focus to the Edit trigger when the form closes (Save / Cancel / Escape) so a keyboard
  // user is never dropped to <body>. Skip the initial mount, where editing was never true.
  useEffect(() => {
    if (wasEditing.current && !editing) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const handleSave = async (edited: QualityIntelligenceCandidateEditableFields): Promise<void> => {
    if (onEdit !== undefined) await onEdit(candidate.id, edited);
    setEditing(false);
  };
  return (
    <li className={editing ? "qi-cand-card qi-cand-card-editing" : "qi-cand-card"}>
      {editing && onEdit !== undefined ? (
        <CandidateEditForm
          candidate={candidate}
          onSave={handleSave}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <CandidateView
          candidate={candidate}
          onReview={onReview}
          actionsDisabled={actionsDisabled}
          describedBy={describedBy}
          pendingReview={pendingReview}
          editButtonRef={editButtonRef}
          onStartEdit={
            onEdit !== undefined
              ? () => {
                  setEditing(true);
                }
              : undefined
          }
        />
      )}
    </li>
  );
}

export interface CandidatesPaneProps {
  readonly candidates: readonly QualityIntelligenceUiCandidate[];
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
  readonly onEdit?: QiCandidateEdit | undefined;
  readonly actionsDisabled?: boolean;
  readonly actionsDisabledReason?: string | undefined;
  /** Review request currently in flight — locks the review controls and labels it "Saving…". */
  readonly pendingReview?: QiPendingReview | null | undefined;
}

export function CandidatesPane({
  candidates,
  onReview,
  onEdit,
  actionsDisabled = false,
  actionsDisabledReason,
  pendingReview,
}: CandidatesPaneProps): ReactNode {
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const governanceNoteId = useId();
  const showGovernanceNote = actionsDisabled && actionsDisabledReason !== undefined;
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
      {showGovernanceNote ? (
        <p id={governanceNoteId} className="qi-cand-governance-note" role="note">
          {actionsDisabledReason}
        </p>
      ) : null}
      <ul className="qi-cand-cards" aria-label="Generated test cases">
        {shown.map((c) => (
          <CandidateCard
            key={c.id}
            candidate={c}
            onReview={onReview}
            onEdit={onEdit}
            actionsDisabled={actionsDisabled}
            describedBy={showGovernanceNote ? governanceNoteId : undefined}
            pendingReview={pendingReview}
          />
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
