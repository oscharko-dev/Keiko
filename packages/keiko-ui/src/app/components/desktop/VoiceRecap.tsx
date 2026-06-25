"use client";

// Issue #504, Epic #491 (ADR-0067) — presentational Voice session recap controls (Artifact C surface).
//
// Two surfaces render the user-triggered recap flow driven by `createVoiceSessionRecapBinding`:
//   - VoiceRecapButton: a composer affordance that asks the server to derive memory candidates from the
//     COMMITTED voice transcript. It is rendered ONLY when the deployment captures a user transcript
//     (the caller gates this via `supportsVoiceRecap`) AND there is committed content to review, so a
//     no-voice / playback-only deployment shows nothing and a session with nothing committed shows an
//     inert button (AC1). Pressing it never stores anything by itself: it only proposes candidates that
//     the user must then explicitly review.
//   - VoiceRecapPanel: a review surface listing the proposed candidates with the EXISTING governed
//     actions — Approve / Edit / Reject / Forget — each delegating to `memory-api.ts`. It announces the
//     loading / empty / ready states to assistive tech. No new modal, no new governance surface.
//
// The recap NEVER stores raw audio or unreviewed transcript text: candidates flow through the existing
// review queue as `"proposed"` and require an explicit user decision. Reuses the existing `cmp-voice*`
// CSS classes so globals.css is NOT modified (SHA-pinned by tests).

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { Icons } from "./Icons";

const RECAP_PRIVACY_HINT_ID = "cmp-voice-recap-privacy-hint";

const RECAP_PRIVACY_MESSAGE =
  "Reviewing a session proposes memory candidates from your committed voice transcript. Nothing is " +
  "saved until you approve it. Raw audio is never stored.";

interface VoiceRecapButtonProps {
  readonly committedSegmentCount: number;
  readonly busy: boolean;
  readonly onTrigger: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly compact?: boolean | undefined;
}

export function VoiceRecapButton({
  committedSegmentCount,
  busy,
  onTrigger,
  buttonRef,
  compact = false,
}: VoiceRecapButtonProps): ReactNode {
  // Inert when there is nothing committed to review (AC1) or while a recap build is in flight. Uses
  // aria-disabled (not native disabled) so the control keeps focus and the panel's focus handoff works.
  const inert = committedSegmentCount === 0 || busy;
  const label = busy
    ? "Reviewing your voice session…"
    : `Review voice session (${committedSegmentCount.toString()} committed)`;
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cmp-icon cmp-voice ui-tip${compact ? " cmp-mode-compact" : ""}`}
      data-tip={label}
      aria-label={label}
      aria-busy={busy}
      aria-disabled={inert}
      aria-describedby={RECAP_PRIVACY_HINT_ID}
      onClick={() => {
        if (inert) return;
        onTrigger();
      }}
    >
      <Icons.brain size={16} />
      <span id={RECAP_PRIVACY_HINT_ID} className="sr-only">
        {RECAP_PRIVACY_MESSAGE}
      </span>
    </button>
  );
}

export interface VoiceRecapReviewHandlers {
  readonly onApprove: (id: string) => void;
  readonly onEdit: (id: string, body: string) => void;
  readonly onReject: (id: string) => void;
  readonly onForget: (id: string) => void;
}

interface VoiceRecapCandidateProps extends VoiceRecapReviewHandlers {
  readonly candidate: MemoryRecord;
}

function VoiceRecapCandidate({
  candidate,
  onApprove,
  onEdit,
  onReject,
  onForget,
}: VoiceRecapCandidateProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(candidate.body);

  if (editing) {
    return (
      <li className="cmp-voice-preview" aria-label="Edit recap candidate">
        <label className="cmp-voice-label" htmlFor={`cmp-voice-recap-edit-${candidate.id}`}>
          Edit candidate
        </label>
        <textarea
          id={`cmp-voice-recap-edit-${candidate.id}`}
          className="cmp-voice-transcript"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="cmp-voice-actions">
          <button
            type="button"
            className="cmp-voice-btn cmp-voice-btn-primary"
            aria-label="Save edited candidate"
            disabled={draft.trim().length === 0}
            onClick={() => {
              onEdit(candidate.id, draft.trim());
              setEditing(false);
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="cmp-voice-btn"
            aria-label="Cancel editing candidate"
            onClick={() => {
              setDraft(candidate.body);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="cmp-voice-preview" aria-label="Recap candidate">
      <p>{candidate.body}</p>
      <div className="cmp-voice-actions">
        <button
          type="button"
          className="cmp-voice-btn cmp-voice-btn-primary"
          aria-label="Approve candidate"
          onClick={() => onApprove(candidate.id)}
        >
          Approve
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label="Edit candidate"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label="Reject candidate"
          onClick={() => onReject(candidate.id)}
        >
          Reject
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label="Forget candidate"
          onClick={() => onForget(candidate.id)}
        >
          Forget
        </button>
      </div>
    </li>
  );
}

interface VoiceRecapPanelProps extends VoiceRecapReviewHandlers {
  readonly loading: boolean;
  readonly candidates: readonly MemoryRecord[];
}

export function VoiceRecapPanel({
  loading,
  candidates,
  onApprove,
  onEdit,
  onReject,
  onForget,
}: VoiceRecapPanelProps): ReactNode {
  const headingRef = useRef<HTMLParagraphElement>(null);

  // Focus handoff (WCAG 2.4.3): when candidates first appear, move focus to the panel heading so a
  // keyboard or screen-reader user lands on the review surface.
  const hasCandidates = candidates.length > 0;
  useEffect(() => {
    if (hasCandidates) {
      headingRef.current?.focus();
    }
  }, [hasCandidates]);

  if (loading) {
    return (
      <div className="cmp-voice-preview" role="status" aria-live="polite">
        <span className="cmp-loading-dot" aria-hidden="true" />
        Reviewing your voice session…
      </div>
    );
  }

  if (!hasCandidates) {
    return null;
  }

  return (
    <div className="cmp-voice-preview" role="group" aria-label="Voice session recap candidates">
      <p className="cmp-voice-label" ref={headingRef} tabIndex={-1}>
        {`${candidates.length.toString()} memory candidate${
          candidates.length === 1 ? "" : "s"
        } from your voice session`}
      </p>
      <ul className="cmp-voice-actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
        {candidates.map((candidate) => (
          <VoiceRecapCandidate
            key={candidate.id}
            candidate={candidate}
            onApprove={onApprove}
            onEdit={onEdit}
            onReject={onReject}
            onForget={onForget}
          />
        ))}
      </ul>
    </div>
  );
}
