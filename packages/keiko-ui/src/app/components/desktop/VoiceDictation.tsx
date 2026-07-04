"use client";

// Issue #495, Epic #491 — presentational composer dictation controls.
//
// Two pure, phase-driven components render the dictation flow owned by `useDictation`:
//   - VoiceDictationButton: the microphone affordance that lives in the composer bar. It flips
//     between "start dictation" and "stop recording", and reflects the requesting / transcribing
//     busy states. It is rendered ONLY when the deployment advertises speech-to-text and the browser
//     can capture audio (the caller gates this), so a no-voice deployment shows no affordance at all.
//   - VoiceDictationPreview: the review surface that lives in the composer input stack. It announces
//     the transcribing / ready / error states to assistive tech, shows the editable transcript with
//     insert / discard / retry actions, and carries the local-only privacy disclosure.
//
// The copy is deliberately scoped to controlled dictation — "dictate", "transcript", "insert" — and
// never implies a full Voice Digital Twin conversation, speech playback, or realtime interaction
// (AC5). Insertion places reviewed text into the composer; it never sends or plays audio.

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { Icons } from "./Icons";
import type {
  DictationController,
  DictationErrorReason,
  DictationPhase,
} from "./hooks/useDictation";

// Stable id for the local-only privacy disclosure so the mic button can reference it via
// aria-describedby — the disclosure is discoverable to screen-reader users without opening anything.
export const VOICE_PRIVACY_HINT_ID = "cmp-voice-privacy-hint";

// Separate id for the visible privacy note in the preview so it never collides with the button's
// sr-only hint (both can be in the DOM during the preview phase).
const VOICE_PRIVACY_NOTE_ID = "cmp-voice-privacy-note";

const PRIVACY_MESSAGE =
  "Audio is sent only to your configured speech-to-text endpoint and is not stored.";

function micLabel(phase: DictationPhase): string {
  switch (phase) {
    case "requesting":
      return "Starting microphone…";
    case "recording":
      return "Stop dictation";
    case "finalizing":
      return "Finishing dictation…";
    case "transcribing":
      return "Transcribing your dictation…";
    default:
      // idle | preview | error — the affordance starts (or restarts) dictation.
      return "Dictate a message";
  }
}

interface VoiceDictationButtonProps {
  readonly phase: DictationPhase;
  readonly audioLevel?: number | undefined;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly compact?: boolean | undefined;
}

export function VoiceDictationButton({
  phase,
  audioLevel = 0,
  onStart,
  onStop,
  buttonRef,
  compact = false,
}: VoiceDictationButtonProps): ReactNode {
  const recording = phase === "recording";
  const live = recording || phase === "finalizing";
  // Interactive only when there is a clear action: start from idle/preview/error, stop while
  // recording. The transient requesting / transcribing states are announced but not clickable.
  const busy = phase === "requesting" || phase === "finalizing" || phase === "transcribing";
  const label = micLabel(phase);
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cmp-icon cmp-voice ui-tip${compact ? " cmp-mode-compact" : ""}`}
      data-recording={live ? "true" : "false"}
      data-tip={label}
      aria-label={label}
      aria-pressed={live}
      aria-busy={busy}
      aria-describedby={VOICE_PRIVACY_HINT_ID}
      // `aria-disabled` (not the native `disabled` attribute) for the transient busy states, so the
      // button keeps focus while transcription runs and the preview's focus handoff can take over —
      // a native `disabled` would blur the just-clicked control. This matches the composer's existing
      // focusable-but-inert send button. The onClick guard below enforces the inert behaviour.
      aria-disabled={busy}
      onClick={() => {
        if (busy) return;
        if (recording) {
          onStop();
        } else {
          onStart();
        }
      }}
    >
      {live ? (
        <span className="cmp-voice-recording" aria-hidden="true">
          <span className="cmp-voice-dot" />
          <VoiceLevelMeter level={audioLevel} compact />
          <Icons.close size={14} />
        </span>
      ) : (
        <Icons.mic size={16} />
      )}
      <span id={VOICE_PRIVACY_HINT_ID} className="sr-only">
        {PRIVACY_MESSAGE}
      </span>
    </button>
  );
}

function VoiceLevelMeter({
  level,
  compact = false,
}: {
  readonly level: number;
  readonly compact?: boolean | undefined;
}): ReactNode {
  const safeLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const bars = compact ? [0.22, 0.44, 0.66] : [0.18, 0.34, 0.5, 0.66, 0.82];
  return (
    <span className="cmp-voice-level" aria-hidden="true">
      {bars.map((threshold, index) => (
        <span
          key={threshold}
          className="cmp-voice-level-bar"
          data-active={safeLevel >= threshold || (safeLevel > 0 && index === 0) ? "true" : "false"}
        />
      ))}
    </span>
  );
}

function errorHeadline(reason: DictationErrorReason): string {
  switch (reason) {
    case "permission-denied":
      return "Microphone access was denied. Allow microphone access in your browser to dictate.";
    case "no-microphone":
      return "No microphone was found. Connect a microphone and try again.";
    case "unsupported":
      return "This browser does not support microphone dictation.";
    case "unavailable":
      return "Speech-to-text dictation is not available right now.";
    case "transcribe-failed":
    case "capture-failed":
      return "Dictation could not be completed.";
  }
}

interface VoiceDictationPreviewProps {
  readonly phase: DictationPhase;
  readonly transcript: string;
  readonly liveTranscript?: string | undefined;
  readonly finalizationNote?: string | undefined;
  readonly audioLevel?: number | undefined;
  readonly heardSpeech?: boolean | undefined;
  readonly micReady?: boolean | undefined;
  readonly error: { readonly reason: DictationErrorReason; readonly message: string } | undefined;
  readonly onTranscriptChange: (value: string) => void;
  readonly onInsert: () => void;
  readonly onDiscard: () => void;
  readonly onRetry: () => void;
}

export function VoiceDictationPreview({
  phase,
  transcript,
  liveTranscript = "",
  finalizationNote,
  audioLevel = 0,
  heardSpeech = false,
  micReady = false,
  error,
  onTranscriptChange,
  onInsert,
  onDiscard,
  onRetry,
}: VoiceDictationPreviewProps): ReactNode {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  // Focus handoff (WCAG 2.4.3): when the editable transcript appears, move focus to it so a keyboard
  // or screen-reader user lands on the review field; when an error appears, move focus to its retry
  // action so the alert and its recovery are immediately reachable.
  useEffect(() => {
    if (phase === "preview") {
      textareaRef.current?.focus();
    } else if (phase === "error") {
      retryRef.current?.focus();
    }
  }, [phase]);

  if (phase === "recording") {
    // "Preparing mic" until capture is verified live, so the user is only invited to speak once audio is
    // actually flowing; then "Listening" / "Capturing speech" as the level crosses the speech gate.
    const recordingLabel = !micReady
      ? "Preparing mic…"
      : heardSpeech
        ? "Capturing speech…"
        : "Listening…";
    return (
      <div className="cmp-voice-preview cmp-voice-live" role="status" aria-live="polite">
        <VoiceLevelMeter level={micReady ? audioLevel : 0} />
        <span>{recordingLabel}</span>
        {liveTranscript.trim().length > 0 ? (
          <span className="cmp-voice-label">{liveTranscript}</span>
        ) : null}
      </div>
    );
  }

  if (phase === "finalizing") {
    return (
      <div className="cmp-voice-preview cmp-voice-live" role="status" aria-live="polite">
        <VoiceLevelMeter level={0} />
        <span>Finishing dictation…</span>
        {liveTranscript.trim().length > 0 ? (
          <span className="cmp-voice-label">{liveTranscript}</span>
        ) : null}
      </div>
    );
  }

  if (phase === "transcribing") {
    return (
      <div className="cmp-voice-preview" role="status" aria-live="polite">
        <span className="cmp-loading-dot" aria-hidden="true" />
        Transcribing your dictation…
      </div>
    );
  }

  if (phase === "error" && error !== undefined) {
    return (
      <div className="cmp-voice-preview cmp-voice-error" role="alert" aria-atomic="true">
        <p className="cmp-voice-error-text">{errorHeadline(error.reason)}</p>
        <div className="cmp-voice-actions">
          <button type="button" ref={retryRef} className="cmp-voice-btn" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="cmp-voice-btn" onClick={onDiscard}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (phase !== "preview") {
    return null;
  }

  return (
    <div className="cmp-voice-preview" role="group" aria-label="Dictation transcript preview">
      <span role="status" aria-live="polite" className="sr-only">
        Transcript ready for review.
      </span>
      <label className="cmp-voice-label" htmlFor="cmp-voice-transcript">
        Review your dictation
      </label>
      <textarea
        id="cmp-voice-transcript"
        ref={textareaRef}
        className="cmp-voice-transcript"
        rows={3}
        value={transcript}
        aria-describedby={VOICE_PRIVACY_NOTE_ID}
        onChange={(event) => onTranscriptChange(event.target.value)}
      />
      <p id={VOICE_PRIVACY_NOTE_ID} className="cmp-voice-privacy">
        {PRIVACY_MESSAGE}
      </p>
      {finalizationNote !== undefined ? (
        <p className="cmp-voice-privacy">{finalizationNote}</p>
      ) : null}
      <div className="cmp-voice-actions">
        <button
          type="button"
          className="cmp-voice-btn cmp-voice-btn-primary"
          aria-label="Insert transcript into the message"
          disabled={transcript.trim().length === 0}
          onClick={onInsert}
        >
          Insert
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label="Re-record the dictation"
          onClick={onRetry}
        >
          Re-record
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label="Discard the dictation"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

// Convenience wrapper binding a DictationController to the preview surface, so the composer can render
// `<VoiceDictationPreviewFromController controller={…} onAfterDiscard={…} />` without threading every
// callback. Insertion focus is handled by the controller's onInsert; discard returns focus via the
// onAfterDiscard hook (typically refocusing the mic button).
export function VoiceDictationPreviewFromController({
  controller,
  onAfterDiscard,
}: {
  readonly controller: DictationController;
  readonly onAfterDiscard: () => void;
}): ReactNode {
  return (
    <VoiceDictationPreview
      phase={controller.phase}
      transcript={controller.transcript}
      liveTranscript={controller.liveTranscript}
      finalizationNote={controller.finalizationNote}
      audioLevel={controller.audioLevel}
      heardSpeech={controller.heardSpeech}
      micReady={controller.micReady}
      error={controller.error}
      onTranscriptChange={controller.setTranscript}
      onInsert={controller.insert}
      onRetry={controller.retry}
      onDiscard={() => {
        controller.discard();
        onAfterDiscard();
      }}
    />
  );
}
