"use client";

// Issue #501, Epic #491 — presentational assistant speech-output playback controls.
//
// Two surfaces render the optional spoken-assistant flow driven by `useVoicePlayback`:
//   - VoicePlaybackMuteButton: a persistent composer affordance to mute / unmute the assistant's voice.
//     It is rendered ONLY when the deployment advertises speech output (the caller gates this via
//     `supportsSpeechOutput`), so a no-voice / STT-only deployment shows nothing and Keiko answers in
//     text with no playback control (AC1). Muting is meaningful even before any audio plays: it records
//     the user's preference for when a spoken response begins.
//   - VoicePlaybackStatus: a transient status / alert strip that announces the speaking state to
//     assistive technology and offers pause, resume, stop, and replay-if-permitted. It renders only
//     while a spoken response is active or freshly settled; between turns it is absent.
//
// The assistant's full reply is ALWAYS present as text in the conversation — these controls govern the
// optional spoken layer only and never gate the text. The copy is scoped to assistant speech output and
// never implies dictation. Reuses the existing `cmp-voice*` CSS classes so globals.css is NOT modified
// (SHA-pinned by tests). The decorative speaker glyph is inline and `aria-hidden`; the accessible name
// always comes from the button's `aria-label`.

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { useVoiceTranslate as useTranslate, type I18nTranslate } from "./voice-i18n";
import type { VoicePlaybackSnapshot } from "./hooks/voice-playback-state";

// Stable id for the local-only disclosure on the mute button.
export const PLAYBACK_PRIVACY_HINT_ID = "cmp-voice-playback-privacy-hint";

// Decorative speaker glyph; `aria-hidden` so the accessible name comes from the button label. A muted
// glyph adds a slash. Kept inline so the component depends on no audio-specific icon asset.
function SpeakerGlyph({ muted }: { readonly muted: boolean }): ReactNode {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 9v6h4l5 4V5L8 9H4z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {muted ? (
        <path
          d="M16 9l5 6M21 9l-5 6"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M16 9.5a3.5 3.5 0 010 5M18.5 7a7 7 0 010 10"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

interface VoicePlaybackMuteButtonProps {
  readonly muted: boolean;
  readonly onToggle: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly compact?: boolean | undefined;
}

export function VoicePlaybackMuteButton({
  muted,
  onToggle,
  buttonRef,
  compact = false,
}: VoicePlaybackMuteButtonProps): ReactNode {
  const t = useTranslate();
  const label = muted ? t("voice.playback.unmute") : t("voice.playback.mute");
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cmp-icon cmp-voice ui-tip${compact ? " cmp-mode-compact" : ""}`}
      data-muted={muted ? "true" : "false"}
      data-tip={label}
      aria-label={label}
      aria-pressed={muted}
      aria-describedby={PLAYBACK_PRIVACY_HINT_ID}
      onClick={onToggle}
    >
      <SpeakerGlyph muted={muted} />
      <span id={PLAYBACK_PRIVACY_HINT_ID} className="sr-only">
        {t("voice.playback.privacy")}
      </span>
    </button>
  );
}

// The announced headline for each playback phase. `unavailable` is never announced (the strip is absent).
function playbackHeadline(phase: VoicePlaybackSnapshot["phase"], t: I18nTranslate): string {
  switch (phase) {
    case "preparing":
      return t("voice.playback.preparing");
    case "speaking":
      return t("voice.playback.speaking");
    case "paused":
      return t("voice.playback.paused");
    case "interrupted":
      return t("voice.playback.interrupted");
    case "canceled":
      return t("voice.playback.stopped");
    case "failed":
      return t("voice.playback.failed");
    case "complete":
      return t("voice.playback.finished");
    case "unavailable":
      return "";
  }
}

interface VoicePlaybackStatusProps {
  readonly snapshot: VoicePlaybackSnapshot;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onReplay: () => void;
}

export function VoicePlaybackStatus({
  snapshot,
  onPause,
  onResume,
  onStop,
  onReplay,
}: VoicePlaybackStatusProps): ReactNode {
  const t = useTranslate();
  const { available, phase } = snapshot;
  const replayRef = useRef<HTMLButtonElement>(null);

  // Focus handoff (WCAG 2.4.3): when a spoken response fails, move focus to the replay control if it is
  // offered, so the recovery path is immediately reachable (mirrors VoiceRealtimeStatus).
  const failedWithReplay = phase === "failed" && available && snapshot.replayAllowed;
  useEffect(() => {
    if (failedWithReplay) {
      replayRef.current?.focus();
    }
  }, [failedWithReplay]);

  // No playback capability, or no active/settled spoken turn → render nothing (AC1: no broken UI).
  if (!available || phase === "unavailable") {
    return null;
  }

  const headline = playbackHeadline(phase, t);
  const isFailure = phase === "failed";
  const showPause = phase === "speaking";
  const showResume = phase === "paused";
  const showStop = phase === "speaking" || phase === "paused";
  const showReplay = snapshot.settled && snapshot.replayAllowed;

  return (
    <div
      className={`cmp-voice-preview${isFailure ? " cmp-voice-error" : ""}`}
      role={isFailure ? "alert" : "status"}
      aria-live={isFailure ? undefined : "polite"}
      aria-atomic="true"
      data-phase={phase}
    >
      <p className={isFailure ? "cmp-voice-error-text" : undefined}>
        {phase === "preparing" ? (
          <span className="cmp-loading-dot" aria-hidden="true" />
        ) : phase === "speaking" ? (
          <span className="cmp-voice-dot" aria-hidden="true" />
        ) : null}
        {headline}
      </p>
      <div className="cmp-voice-actions">
        {showPause ? (
          <button type="button" className="cmp-voice-btn" onClick={onPause}>
            {t("voice.playback.pause")}
          </button>
        ) : null}
        {showResume ? (
          <button type="button" className="cmp-voice-btn" onClick={onResume}>
            {t("voice.playback.resume")}
          </button>
        ) : null}
        {showStop ? (
          <button type="button" className="cmp-voice-btn" onClick={onStop}>
            {t("voice.playback.stop")}
          </button>
        ) : null}
        {showReplay ? (
          <button type="button" ref={replayRef} className="cmp-voice-btn" onClick={onReplay}>
            {t("voice.playback.replay")}
          </button>
        ) : null}
      </div>
      <span className="sr-only">{t("voice.playback.textFallback")}</span>
    </div>
  );
}

// Convenience wrapper binding a `useVoicePlayback` result to the status surface, so the composer can
// render `<VoicePlaybackStatusFromBinding binding={…} />` without threading every callback.
export function VoicePlaybackStatusFromBinding({
  binding,
}: {
  readonly binding: {
    readonly snapshot: VoicePlaybackSnapshot;
    readonly pause: () => void;
    readonly resume: () => void;
    readonly stop: () => void;
    readonly replay: () => void;
  };
}): ReactNode {
  return (
    <VoicePlaybackStatus
      snapshot={binding.snapshot}
      onPause={binding.pause}
      onResume={binding.resume}
      onStop={binding.stop}
      onReplay={binding.replay}
    />
  );
}
