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

import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from "react";
import { useVoiceTranslate as useTranslate, type I18nTranslate } from "./voice-i18n";
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

function micLabel(phase: DictationPhase, t: I18nTranslate): string {
  switch (phase) {
    case "requesting":
      return t("voice.dictation.starting");
    case "recording":
      return t("voice.dictation.stop");
    case "finalizing":
      return t("voice.dictation.finishing");
    case "transcribing":
      return t("voice.dictation.transcribing");
    default:
      // idle | preview | error — the affordance starts (or restarts) dictation.
      return t("voice.dictation.start");
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
  const t = useTranslate();
  const recording = phase === "recording";
  const live = recording || phase === "finalizing";
  // Interactive only when there is a clear action: start from idle/preview/error, stop while
  // recording. The transient requesting / transcribing states are announced but not clickable.
  const busy = phase === "requesting" || phase === "finalizing" || phase === "transcribing";
  const label = micLabel(phase, t);
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
        {t("voice.dictation.privacy")}
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

function errorHeadline(reason: DictationErrorReason, t: I18nTranslate): string {
  switch (reason) {
    case "permission-denied":
      return t("voice.dictation.error.permission");
    case "no-microphone":
      return t("voice.error.noMicrophone");
    case "unsupported":
      return t("voice.dictation.error.unsupported");
    case "unavailable":
      return t("voice.dictation.error.unavailable");
    case "transcribe-failed":
    case "capture-failed":
      return t("voice.dictation.error.failed");
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

// "Preparing mic" until capture is verified live, so the user is only invited to speak once audio is
// actually flowing; then "Listening" / "Capturing speech" as the level crosses the speech gate.
function recordingStatusLabel(micReady: boolean, heardSpeech: boolean, t: I18nTranslate): string {
  if (!micReady) {
    return t("voice.dictation.preparingMic");
  }
  if (heardSpeech) {
    return t("voice.dictation.capturing");
  }
  return t("voice.dictation.listening");
}

// Focus handoff (WCAG 2.4.3): when the editable transcript appears, move focus to it so a keyboard
// or screen-reader user lands on the review field; when an error appears, move focus to its retry
// action so the alert and its recovery are immediately reachable.
function focusForPhase(
  phase: DictationPhase,
  textareaRef: RefObject<HTMLTextAreaElement>,
  retryRef: RefObject<HTMLButtonElement>,
): void {
  if (phase === "preview") {
    textareaRef.current?.focus();
  } else if (phase === "error") {
    retryRef.current?.focus();
  }
}

interface RecordingPreviewProps {
  readonly liveTranscript: string;
  readonly audioLevel: number;
  readonly micReady: boolean;
  readonly heardSpeech: boolean;
  readonly t: I18nTranslate;
}

function RecordingPreview({
  liveTranscript,
  audioLevel,
  micReady,
  heardSpeech,
  t,
}: RecordingPreviewProps): ReactNode {
  const recordingLabel = recordingStatusLabel(micReady, heardSpeech, t);
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

function FinalizingPreview({
  liveTranscript,
  t,
}: {
  readonly liveTranscript: string;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div className="cmp-voice-preview cmp-voice-live" role="status" aria-live="polite">
      <VoiceLevelMeter level={0} />
      <span>{t("voice.dictation.finishing")}</span>
      {liveTranscript.trim().length > 0 ? (
        <span className="cmp-voice-label">{liveTranscript}</span>
      ) : null}
    </div>
  );
}

function TranscribingPreview({ t }: { readonly t: I18nTranslate }): ReactNode {
  return (
    <div className="cmp-voice-preview" role="status" aria-live="polite">
      <span className="cmp-loading-dot" aria-hidden="true" />
      {t("voice.dictation.transcribing")}
    </div>
  );
}

interface ErrorPreviewProps {
  readonly error: { readonly reason: DictationErrorReason; readonly message: string };
  readonly retryRef: Ref<HTMLButtonElement>;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
  readonly t: I18nTranslate;
}

function ErrorPreview({ error, retryRef, onRetry, onDiscard, t }: ErrorPreviewProps): ReactNode {
  return (
    <div className="cmp-voice-preview cmp-voice-error" role="alert" aria-atomic="true">
      <p className="cmp-voice-error-text">{errorHeadline(error.reason, t)}</p>
      <div className="cmp-voice-actions">
        <button type="button" ref={retryRef} className="cmp-voice-btn" onClick={onRetry}>
          {t("common.tryAgain")}
        </button>
        <button type="button" className="cmp-voice-btn" onClick={onDiscard}>
          {t("common.dismiss")}
        </button>
      </div>
    </div>
  );
}

interface ReadyPreviewProps {
  readonly transcript: string;
  readonly finalizationNote: string | undefined;
  readonly textareaRef: Ref<HTMLTextAreaElement>;
  readonly onTranscriptChange: (value: string) => void;
  readonly onInsert: () => void;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
  readonly t: I18nTranslate;
}

function ReadyPreview({
  transcript,
  finalizationNote,
  textareaRef,
  onTranscriptChange,
  onInsert,
  onRetry,
  onDiscard,
  t,
}: ReadyPreviewProps): ReactNode {
  return (
    <div className="cmp-voice-preview" role="group" aria-label={t("voice.dictation.preview")}>
      <span role="status" aria-live="polite" className="sr-only">
        {t("voice.dictation.ready")}
      </span>
      <label className="cmp-voice-label" htmlFor="cmp-voice-transcript">
        {t("voice.dictation.review")}
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
        {t("voice.dictation.privacy")}
      </p>
      {finalizationNote !== undefined ? (
        <p className="cmp-voice-privacy">{finalizationNote}</p>
      ) : null}
      <div className="cmp-voice-actions">
        <button
          type="button"
          className="cmp-voice-btn cmp-voice-btn-primary"
          aria-label={t("voice.dictation.insertAria")}
          disabled={transcript.trim().length === 0}
          onClick={onInsert}
        >
          {t("voice.dictation.insert")}
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label={t("voice.dictation.rerecordAria")}
          onClick={onRetry}
        >
          {t("voice.dictation.rerecord")}
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label={t("voice.dictation.discardAria")}
          onClick={onDiscard}
        >
          {t("voice.dictation.discard")}
        </button>
      </div>
    </div>
  );
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
  const t = useTranslate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    focusForPhase(phase, textareaRef, retryRef);
  }, [phase]);

  if (phase === "recording") {
    return (
      <RecordingPreview
        liveTranscript={liveTranscript}
        audioLevel={audioLevel}
        micReady={micReady}
        heardSpeech={heardSpeech}
        t={t}
      />
    );
  }

  if (phase === "finalizing") {
    return <FinalizingPreview liveTranscript={liveTranscript} t={t} />;
  }

  if (phase === "transcribing") {
    return <TranscribingPreview t={t} />;
  }

  if (phase === "error" && error !== undefined) {
    return (
      <ErrorPreview
        error={error}
        retryRef={retryRef}
        onRetry={onRetry}
        onDiscard={onDiscard}
        t={t}
      />
    );
  }

  if (phase !== "preview") {
    return null;
  }

  return (
    <ReadyPreview
      transcript={transcript}
      finalizationNote={finalizationNote}
      textareaRef={textareaRef}
      onTranscriptChange={onTranscriptChange}
      onInsert={onInsert}
      onRetry={onRetry}
      onDiscard={onDiscard}
      t={t}
    />
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
