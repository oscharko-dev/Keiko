"use client";

// Issue #497, Epic #491 — presentational composer realtime-voice controls.
//
// Two components render the realtime Voice Digital Twin flow owned by `useRealtimeVoice`:
//   - VoiceRealtimeButton: the conversation affordance that lives in the composer bar. It flips
//     between "start realtime voice" / "stop" and reflects the requesting / negotiating busy states.
//     Rendered ONLY when the deployment advertises full-realtime and the browser can open a WebRTC
//     peer connection (the caller gates this), so a no-voice / STT-only deployment shows nothing.
//   - VoiceRealtimeStatus: an adjacent status/alert surface that announces connection state and any
//     error to assistive tech.
//
// The copy is deliberately scoped to realtime conversation — never implies dictation/transcription.
// Reuses the existing `cmp-voice*` CSS classes so globals.css is NOT modified (SHA-pinned by tests).

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { Icons } from "./Icons";
import type {
  RealtimeVoiceController,
  RealtimeVoiceErrorReason,
  RealtimeVoicePhase,
} from "./hooks/useRealtimeVoice";

// Stable id for the local-only privacy disclosure on the realtime button.
export const REALTIME_PRIVACY_HINT_ID = "cmp-voice-rt-privacy-hint";

const REALTIME_PRIVACY_MESSAGE =
  "Your audio is streamed directly to your configured realtime provider and is not stored.";

function realtimeLabel(phase: RealtimeVoicePhase): string {
  switch (phase) {
    case "requesting":
      return "Starting microphone…";
    case "negotiating":
      return "Connecting realtime voice…";
    case "connected":
      return "Stop realtime voice";
    default:
      // idle | error — the affordance starts (or restarts) the realtime session.
      return "Start realtime voice";
  }
}

interface VoiceRealtimeButtonProps {
  readonly phase: RealtimeVoicePhase;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly compact?: boolean | undefined;
}

export function VoiceRealtimeButton({
  phase,
  onStart,
  onStop,
  buttonRef,
  compact = false,
}: VoiceRealtimeButtonProps): ReactNode {
  const connected = phase === "connected";
  const negotiating = phase === "negotiating";
  // Busy during transient states; these are announced but the button stays focusable (aria-disabled
  // not native disabled — preserves focus retention, matching VoiceDictationButton pattern).
  const busy = phase === "requesting" || negotiating;
  const label = realtimeLabel(phase);

  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cmp-icon cmp-voice ui-tip${compact ? " cmp-mode-compact" : ""}`}
      data-recording={connected || negotiating ? "true" : "false"}
      data-tip={label}
      aria-label={label}
      aria-pressed={connected || negotiating}
      aria-busy={busy}
      aria-describedby={REALTIME_PRIVACY_HINT_ID}
      // `aria-disabled` (not native `disabled`) so the button keeps focus during transient states.
      aria-disabled={busy}
      onClick={() => {
        if (busy) return;
        if (connected) {
          onStop();
        } else {
          onStart();
        }
      }}
    >
      {connected || negotiating ? (
        <span className="cmp-voice-recording" aria-hidden="true">
          <span className="cmp-voice-dot" />
          <Icons.close size={14} />
        </span>
      ) : (
        <Icons.mic size={16} />
      )}
      <span id={REALTIME_PRIVACY_HINT_ID} className="sr-only">
        {REALTIME_PRIVACY_MESSAGE}
      </span>
    </button>
  );
}

function realtimeErrorHeadline(reason: RealtimeVoiceErrorReason): string {
  switch (reason) {
    case "permission-denied":
      return "Microphone access was denied. Allow microphone access in your browser to use realtime voice.";
    case "no-microphone":
      return "No microphone was found. Connect a microphone and try again.";
    case "unsupported":
      return "This browser does not support realtime voice.";
    case "unavailable":
      return "Realtime voice is not available right now.";
    case "negotiation-failed":
      return "Realtime voice connection could not be established.";
    case "connection-failed":
      return "Realtime voice connection was lost.";
  }
}

interface VoiceRealtimeStatusProps {
  readonly phase: RealtimeVoicePhase;
  readonly error:
    { readonly reason: RealtimeVoiceErrorReason; readonly message: string } | undefined;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly memoryContextText?: string | undefined;
}

export function VoiceRealtimeStatus({
  phase,
  error,
  onRetry,
  onDismiss,
  memoryContextText,
}: VoiceRealtimeStatusProps): ReactNode {
  const retryRef = useRef<HTMLButtonElement>(null);
  const hasMemoryContext = memoryContextText !== undefined && memoryContextText.trim().length > 0;

  // Focus handoff (WCAG 2.4.3): when an error appears, move focus to its retry button so the alert
  // and its recovery are immediately reachable (mirrors VoiceDictationPreview focus handoff).
  useEffect(() => {
    if (phase === "error") {
      retryRef.current?.focus();
    }
  }, [phase]);

  if (phase === "negotiating") {
    return (
      <div className="cmp-voice-preview" role="status" aria-live="polite">
        <span className="cmp-loading-dot" aria-hidden="true" />
        Connecting realtime voice…
      </div>
    );
  }

  if (phase === "connected") {
    return (
      <div className="cmp-voice-preview" role="status" aria-live="polite">
        <span className="cmp-voice-dot" aria-hidden="true" />
        Realtime voice connected.
        {hasMemoryContext ? (
          <span className="cmp-voice-memory"> MemoriaViva context active.</span>
        ) : null}
      </div>
    );
  }

  if (phase === "error" && error !== undefined) {
    return (
      <div className="cmp-voice-preview cmp-voice-error" role="alert" aria-atomic="true">
        <p className="cmp-voice-error-text">{realtimeErrorHeadline(error.reason)}</p>
        <div className="cmp-voice-actions">
          <button type="button" ref={retryRef} className="cmp-voice-btn" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="cmp-voice-btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// Convenience wrapper binding a RealtimeVoiceController to the status surface, so the composer can
// render `<VoiceRealtimeStatusFromController controller={…} onAfterDismiss={…} />` without threading
// every callback individually.
export function VoiceRealtimeStatusFromController({
  controller,
  onAfterDismiss,
  memoryContextText,
}: {
  readonly controller: RealtimeVoiceController;
  readonly onAfterDismiss: () => void;
  readonly memoryContextText?: string | undefined;
}): ReactNode {
  return (
    <VoiceRealtimeStatus
      phase={controller.phase}
      error={controller.error}
      onRetry={controller.retry}
      memoryContextText={memoryContextText}
      onDismiss={() => {
        controller.stop();
        onAfterDismiss();
      }}
    />
  );
}
