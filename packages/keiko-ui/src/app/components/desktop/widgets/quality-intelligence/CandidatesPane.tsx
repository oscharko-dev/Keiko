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
  QualityIntelligenceReviewAction,
} from "@oscharko-dev/keiko-contracts";
import { isTerminalReviewState } from "@oscharko-dev/keiko-contracts";
import { useQiTranslate as useTranslate } from "./qi-i18n";
import { CandidateEditForm } from "./CandidateEditForm";
import {
  CandidateQualityVerdictNote,
  ReviewBadge,
  WeakTestFlag,
  type CandidateQualityVerdict,
} from "./qiShared";

const INITIAL_VISIBLE = 25;

// The persisted QI run lists candidates as [...deterministic-baseline, ...model-delta] — the
// determinism floor leads the manifest (contractually pinned by #763). For display we surface the
// judged model candidates first and trail the generic determinism-floor stubs, WITHOUT mutating the
// persisted order. Baseline candidates carry the explicit provenance tag
// `source:deterministic-baseline` (a null qualityVerdict is not a stable discriminator — it is also
// null whenever the judge stage was skipped). Array.prototype.sort is stable in V8, so keying on a
// 0/1 baseline flag moves baselines to the end while preserving the relative order of every other
// candidate.
const DETERMINISTIC_BASELINE_PROVENANCE_TAG = "source:deterministic-baseline";

const isBaselineCandidate = (candidate: QualityIntelligenceUiCandidate): boolean =>
  candidate.tags.includes(DETERMINISTIC_BASELINE_PROVENANCE_TAG);

const orderForDisplay = (
  candidates: readonly QualityIntelligenceUiCandidate[],
): readonly QualityIntelligenceUiCandidate[] =>
  [...candidates].sort(
    (left, right) => (isBaselineCandidate(left) ? 1 : 0) - (isBaselineCandidate(right) ? 1 : 0),
  );

type CandidateWithQualityVerdict = QualityIntelligenceUiCandidate & {
  readonly qualityVerdict?: CandidateQualityVerdict;
};

export type QiReviewAction = QualityIntelligenceReviewAction;

export type QiCandidateEdit = (
  candidateId: string,
  edited: QualityIntelligenceCandidateEditableFields,
) => Promise<void> | void;

/** A review request currently in flight (no second request may start until it settles). */
export interface QiPendingReview {
  readonly candidateId: string;
  readonly action: QiReviewAction;
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

function CandidateMeta({
  candidate,
}: {
  readonly candidate: CandidateWithQualityVerdict;
}): ReactNode {
  const t = useTranslate();
  return (
    <dl className="qi-cand-meta" aria-label={t("qi.candidate.metadata")}>
      <div>
        <dt>{t("qi.candidate.steps")}</dt>
        <dd>{candidate.steps.length.toString()}</dd>
      </div>
      <div>
        <dt>{t("qi.candidate.expected")}</dt>
        <dd>{candidate.expectedResults.length.toString()}</dd>
      </div>
      {candidate.qualityVerdict !== undefined ? (
        <div>
          <dt>{t("qi.candidate.quality")}</dt>
          <dd>{Math.round(candidate.qualityVerdict.score).toString()}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function CandidateAccordion({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details className="qi-cand-accordion">
      <summary className="qi-cand-accordion-summary">
        <span>{title}</span>
      </summary>
      <div className="qi-cand-accordion-body">{children}</div>
    </details>
  );
}

function CandidateScenario({
  candidate,
}: {
  readonly candidate: QualityIntelligenceUiCandidate;
}): ReactNode {
  const t = useTranslate();
  return (
    <CandidateAccordion title={t("qi.candidate.scenario")}>
      <StringList items={candidate.preconditions} label={t("qi.candidate.preconditions")} />
      <StringList items={candidate.steps} label={t("qi.candidate.steps")} />
      <StringList items={candidate.expectedResults} label={t("qi.candidate.expectedResults")} />
    </CandidateAccordion>
  );
}

function CandidateEvidence({
  candidate,
}: {
  readonly candidate: CandidateWithQualityVerdict;
}): ReactNode {
  const t = useTranslate();
  if (
    candidate.tags.length === 0 &&
    candidate.qualityVerdict === undefined &&
    candidate.weakTestFlag === undefined
  ) {
    return null;
  }
  return (
    <CandidateAccordion title={t("qi.candidate.evidence")}>
      {candidate.weakTestFlag !== undefined ? <WeakTestFlag flag={candidate.weakTestFlag} /> : null}
      {candidate.qualityVerdict !== undefined ? (
        <CandidateQualityVerdictNote verdict={candidate.qualityVerdict} />
      ) : null}
      {candidate.tags.length > 0 ? (
        <ul className="qi-cand-tags" aria-label={t("qi.candidate.tags")}>
          {candidate.tags.map((t) => (
            <li key={t} className="qi-cand-tag">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
    </CandidateAccordion>
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
  const t = useTranslate();
  // While any review request is in flight, every review button is locked (aria-disabled keeps them
  // focusable) and the clicked one is relabelled "Saving…" so the round-trip has visible feedback.
  const reviewBusy = pendingReview !== null && pendingReview !== undefined;
  const isSaving = (action: QiReviewAction): boolean =>
    reviewBusy && pendingReview.candidateId === candidateId && pendingReview.action === action;

  // Terminal states (approved/rejected/withdrawn, per the shared contracts predicate): once a
  // candidate reaches one, Approve/Reject/Request-changes are governance-illegal and only Reopen is
  // legal. The server enforces this with 409 QI_REVIEW_TRANSITION_NOT_ALLOWED; the UI pre-empts the
  // error by disabling those buttons and rendering a final-note that explains WHY so keyboard/SR
  // users can understand via aria-describedby (Issue #282 FIX A-UI / A11y-4).
  const isTerminal = isTerminalReviewState(state);
  const finalNoteId = useId();

  // Compose the describedBy for the three primary buttons: terminal reason takes precedence when
  // in a terminal state; otherwise fall back to the outer governance describedBy (reviewer label).
  const primaryDescribedBy = isTerminal ? finalNoteId : describedBy;

  return (
    <div className="qi-cand-actions" role="group" aria-label={t("qi.review.decision")}>
      {/* Final-state note: always mounted when terminal so aria-describedby resolves reliably.
          Visually reuses the governance-note style (same role="note", same padding/colour token). */}
      {isTerminal ? (
        <p id={finalNoteId} className="qi-cand-governance-note" role="note">
          {t("qi.review.finalNote")}
        </p>
      ) : null}
      <GovernedActionButton
        className="qi-btn qi-btn-approve"
        label={isSaving("approve") ? t("common.saving") : t("qi.review.approve")}
        pressed={state === "approved"}
        disabled={disabled || reviewBusy || isTerminal}
        describedBy={primaryDescribedBy}
        onActivate={() => {
          onReview(candidateId, "approve");
        }}
      />
      <GovernedActionButton
        className="qi-btn qi-btn-reject"
        label={isSaving("reject") ? t("common.saving") : t("qi.review.reject")}
        pressed={state === "rejected"}
        disabled={disabled || reviewBusy || isTerminal}
        describedBy={primaryDescribedBy}
        onActivate={() => {
          onReview(candidateId, "reject");
        }}
      />
      <GovernedActionButton
        className="qi-btn qi-btn-secondary"
        label={isSaving("request-changes") ? t("common.saving") : t("qi.review.requestChanges")}
        pressed={state === "changes-requested"}
        disabled={disabled || reviewBusy || isTerminal}
        describedBy={primaryDescribedBy}
        onActivate={() => {
          onReview(candidateId, "request-changes");
        }}
      />
      <GovernedActionButton
        className="qi-btn qi-btn-secondary"
        label={isSaving("withdraw") ? t("common.saving") : t("qi.review.withdraw")}
        pressed={state === "withdrawn"}
        disabled={disabled || reviewBusy || isTerminal}
        describedBy={primaryDescribedBy}
        onActivate={() => {
          onReview(candidateId, "withdraw");
        }}
      />
      {/* Reopen: rendered only in terminal states — the one legal action to return to "open".
          It is NOT disabled by isTerminal (that's the whole point). Still respects the outer
          governance gate (disabled) and the in-flight busy lock (reviewBusy). */}
      {isTerminal ? (
        <GovernedActionButton
          className="qi-btn qi-btn-secondary"
          label={isSaving("reopen") ? t("common.saving") : t("qi.review.reopen")}
          disabled={disabled || reviewBusy}
          describedBy={disabled ? describedBy : undefined}
          onActivate={() => {
            onReview(candidateId, "reopen");
          }}
        />
      ) : null}
    </div>
  );
}

function CandidateView({
  candidate,
  onReview,
  onStartEdit,
  actionsDisabled = false,
  actionsDisabledReason,
  describedBy,
  editButtonRef,
  pendingReview,
}: {
  readonly candidate: CandidateWithQualityVerdict;
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
  readonly onStartEdit?: (() => void) | undefined;
  readonly actionsDisabled?: boolean;
  readonly actionsDisabledReason?: string | undefined;
  readonly describedBy?: string | undefined;
  readonly editButtonRef?: Ref<HTMLButtonElement> | undefined;
  readonly pendingReview?: QiPendingReview | null | undefined;
}): ReactNode {
  const t = useTranslate();
  const localDisabledReasonId = useId();
  const actionDescribedBy =
    actionsDisabled && actionsDisabledReason !== undefined
      ? [describedBy, localDisabledReasonId].filter(Boolean).join(" ")
      : describedBy;
  return (
    <>
      <div className="qi-cand-header">
        <div className="qi-cand-title-wrap">
          <h3 className="qi-cand-title">{candidate.title}</h3>
        </div>
        <div className="qi-cand-status">
          <div className="qi-cand-badges">
            <span className="qi-cand-risk">{candidate.riskClass}</span>
            {candidate.reviewState !== "open" ? (
              <ReviewBadge state={candidate.reviewState} />
            ) : null}
          </div>
          <CandidateMeta candidate={candidate} />
        </div>
      </div>
      <div className="qi-cand-accordion-stack">
        <CandidateScenario candidate={candidate} />
        <CandidateEvidence candidate={candidate} />
      </div>
      <div className="qi-cand-actions-row">
        {actionsDisabled && actionsDisabledReason !== undefined ? (
          <p id={localDisabledReasonId} className="qi-cand-action-note" role="note">
            {actionsDisabledReason}
          </p>
        ) : null}
        <div className="qi-cand-action-buttons">
          {onStartEdit !== undefined ? (
            <button
              ref={editButtonRef}
              type="button"
              className="qi-btn qi-btn-secondary qi-cand-edit"
              aria-disabled={actionsDisabled || undefined}
              aria-describedby={actionsDisabled ? actionDescribedBy : undefined}
              onClick={() => {
                if (actionsDisabled) return;
                onStartEdit();
              }}
            >
              {t("common.edit")}
            </button>
          ) : null}
          {onReview !== undefined ? (
            <ReviewControls
              candidateId={candidate.id}
              state={candidate.reviewState}
              onReview={onReview}
              disabled={actionsDisabled}
              describedBy={actionDescribedBy}
              pendingReview={pendingReview}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function CandidateCard({
  candidate,
  onReview,
  onEdit,
  actionsDisabled = false,
  actionsDisabledReason,
  describedBy,
  pendingReview,
}: {
  readonly candidate: CandidateWithQualityVerdict;
  readonly onReview?: ((candidateId: string, action: QiReviewAction) => void) | undefined;
  readonly onEdit?: QiCandidateEdit | undefined;
  readonly actionsDisabled?: boolean;
  readonly actionsDisabledReason?: string | undefined;
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
          actionsDisabledReason={actionsDisabledReason}
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
  const t = useTranslate();
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const governanceNoteId = useId();
  const showGovernanceNote = actionsDisabled && actionsDisabledReason !== undefined;
  if (candidates.length === 0) {
    return (
      <div className="lk-empty">
        <p className="lk-empty-title">{t("qi.candidate.empty.title")}</p>
        <p className="lk-empty-body">{t("qi.candidate.empty.body")}</p>
      </div>
    );
  }
  // Render order only: judged model candidates first, deterministic-baseline stubs last. The
  // persisted candidate order (and `candidates.length` used by the "show more" control) is untouched.
  const shown = orderForDisplay(candidates).slice(0, visible);
  return (
    <div className="qi-cand-pane">
      {showGovernanceNote ? (
        <p id={governanceNoteId} className="qi-cand-governance-note" role="note">
          {actionsDisabledReason}
        </p>
      ) : null}
      {/* a11y m-04: the wrapping <section> in QiRunCard already names this "Generated test cases";
          a more specific list label avoids AT announcing the same name twice. */}
      <ul className="qi-cand-cards" aria-label={t("qi.candidate.list")}>
        {shown.map((c) => (
          <CandidateCard
            key={c.id}
            candidate={c}
            onReview={onReview}
            onEdit={onEdit}
            actionsDisabled={actionsDisabled}
            actionsDisabledReason={actionsDisabledReason}
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
          {t("qi.candidate.showMore", { count: candidates.length - visible })}
        </button>
      ) : null}
    </div>
  );
}
