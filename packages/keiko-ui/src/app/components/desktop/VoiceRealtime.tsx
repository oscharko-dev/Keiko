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

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useVoiceTranslate as useTranslate, type I18nTranslate } from "./voice-i18n";
import { Icons } from "./Icons";
import type {
  RealtimeVoiceController,
  RealtimeVoiceErrorReason,
  RealtimeVoicePhase,
} from "./hooks/useRealtimeVoice";
import type { ConversationMemoryActionWire } from "@/lib/types";

// Stable id for the local-only privacy disclosure on the realtime button.
export const REALTIME_PRIVACY_HINT_ID = "cmp-voice-rt-privacy-hint";

function realtimeLabel(phase: RealtimeVoicePhase, t: I18nTranslate): string {
  switch (phase) {
    case "requesting":
      return t("voice.realtime.starting");
    case "negotiating":
      return t("voice.realtime.connecting");
    case "connected":
      return t("voice.realtime.stop");
    default:
      // idle | error — the affordance starts (or restarts) the realtime session.
      return t("voice.realtime.start");
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
  const t = useTranslate();
  const connected = phase === "connected";
  const negotiating = phase === "negotiating";
  // Busy during transient states; these are announced but the button stays focusable (aria-disabled
  // not native disabled — preserves focus retention, matching VoiceDictationButton pattern).
  const busy = phase === "requesting" || negotiating;
  const label = realtimeLabel(phase, t);

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
        {t("voice.realtime.privacy")}
      </span>
    </button>
  );
}

function realtimeErrorHeadline(reason: RealtimeVoiceErrorReason, t: I18nTranslate): string {
  switch (reason) {
    case "permission-denied":
      return t("voice.realtime.error.permission");
    case "no-microphone":
      return t("voice.error.noMicrophone");
    case "unsupported":
      return t("voice.realtime.error.unsupported");
    case "unavailable":
      return t("voice.realtime.error.unavailable");
    case "negotiation-failed":
      return t("voice.realtime.error.negotiationFailed");
    case "connection-failed":
      return t("voice.realtime.error.connectionFailed");
  }
}

interface VoiceRealtimeStatusProps {
  readonly phase: RealtimeVoicePhase;
  readonly error:
    { readonly reason: RealtimeVoiceErrorReason; readonly message: string } | undefined;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly memoryContextText?: string | undefined;
  readonly memoryContextCount?: number | undefined;
  readonly memoryActions?: readonly ConversationMemoryActionWire[] | undefined;
  readonly onAcceptMemoryCandidate?: ((proposalId: string) => Promise<void>) | undefined;
  readonly onRejectMemoryCandidate?: ((proposalId: string) => Promise<void>) | undefined;
}

type CandidateMemoryAction = Extract<ConversationMemoryActionWire, { readonly kind: "candidate" }>;

function candidateActions(
  actions: readonly ConversationMemoryActionWire[] | undefined,
): readonly CandidateMemoryAction[] {
  return (
    actions?.filter((action): action is CandidateMemoryAction => action.kind === "candidate") ?? []
  );
}

function memoryActivityLabel(
  count: number | undefined,
  hasMemoryContext: boolean,
  t: I18nTranslate,
): string | null {
  if (count !== undefined && count > 0) {
    return t(count === 1 ? "voice.realtime.memory.one" : "voice.realtime.memory.many", {
      count,
    });
  }
  return hasMemoryContext ? t("voice.realtime.memory.contextActive") : null;
}

function VoiceMemoryCandidate({
  action,
  onAccept,
  onReject,
}: {
  readonly action: CandidateMemoryAction;
  readonly onAccept: ((proposalId: string) => Promise<void>) | undefined;
  readonly onReject: ((proposalId: string) => Promise<void>) | undefined;
}): ReactNode {
  const t = useTranslate();
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | undefined>();
  const run = useCallback(
    (kind: "accept" | "reject", callback: ((proposalId: string) => Promise<void>) | undefined) => {
      if (callback === undefined || busy !== null) return;
      setBusy(kind);
      setError(undefined);
      void callback(action.proposalId)
        .catch((caught) => {
          setError(
            caught instanceof Error ? caught.message : t("voice.realtime.memory.updateFailed"),
          );
        })
        .finally(() => setBusy(null));
    },
    [action.proposalId, busy, t],
  );
  return (
    <div className="cmp-voice-memory-candidate">
      <span className="cmp-voice-memory-candidate-text">{action.body}</span>
      <div className="cmp-voice-memory-actions">
        <button
          type="button"
          className="cmp-voice-btn cmp-voice-btn-primary"
          aria-busy={busy === "accept"}
          aria-disabled={busy !== null || onAccept === undefined}
          onClick={() => run("accept", onAccept)}
        >
          {t("memoria.approve")}
        </button>
        <button
          type="button"
          className="cmp-voice-btn"
          aria-busy={busy === "reject"}
          aria-disabled={busy !== null || onReject === undefined}
          onClick={() => run("reject", onReject)}
        >
          {t("memoria.reject")}
        </button>
      </div>
      {error !== undefined ? <span className="cmp-voice-memory-error">{error}</span> : null}
    </div>
  );
}

function VoiceMemoryActivity({
  memoryContextText,
  memoryContextCount,
  memoryActions,
  onAcceptMemoryCandidate,
  onRejectMemoryCandidate,
}: {
  readonly memoryContextText?: string | undefined;
  readonly memoryContextCount?: number | undefined;
  readonly memoryActions?: readonly ConversationMemoryActionWire[] | undefined;
  readonly onAcceptMemoryCandidate?: ((proposalId: string) => Promise<void>) | undefined;
  readonly onRejectMemoryCandidate?: ((proposalId: string) => Promise<void>) | undefined;
}): ReactNode {
  const t = useTranslate();
  const hasMemoryContext = memoryContextText !== undefined && memoryContextText.trim().length > 0;
  const label = memoryActivityLabel(memoryContextCount, hasMemoryContext, t);
  const candidates = candidateActions(memoryActions);
  if (label === null && candidates.length === 0) {
    return null;
  }
  return (
    <div className="cmp-voice-memory" aria-label={t("voice.realtime.memory.region")}>
      {label !== null ? <span className="cmp-voice-memory-summary">{label}</span> : null}
      {candidates.map((action) => (
        <VoiceMemoryCandidate
          key={action.proposalId}
          action={action}
          onAccept={onAcceptMemoryCandidate}
          onReject={onRejectMemoryCandidate}
        />
      ))}
    </div>
  );
}

export function VoiceRealtimeStatus({
  phase,
  error,
  onRetry,
  onDismiss,
  memoryContextText,
  memoryContextCount,
  memoryActions,
  onAcceptMemoryCandidate,
  onRejectMemoryCandidate,
}: VoiceRealtimeStatusProps): ReactNode {
  const t = useTranslate();
  const retryRef = useRef<HTMLButtonElement>(null);

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
        {t("voice.realtime.connecting")}
      </div>
    );
  }

  if (phase === "connected") {
    return (
      <div className="cmp-voice-preview" role="group" aria-label={t("voice.realtime.status")}>
        <div className="cmp-voice-connected-line" role="status" aria-live="polite">
          <span className="cmp-voice-dot" aria-hidden="true" />
          {t("voice.realtime.connected")}
        </div>
        <VoiceMemoryActivity
          memoryContextText={memoryContextText}
          memoryContextCount={memoryContextCount}
          memoryActions={memoryActions}
          onAcceptMemoryCandidate={onAcceptMemoryCandidate}
          onRejectMemoryCandidate={onRejectMemoryCandidate}
        />
      </div>
    );
  }

  if (phase === "error" && error !== undefined) {
    return (
      <div className="cmp-voice-preview cmp-voice-error" role="alert" aria-atomic="true">
        <p className="cmp-voice-error-text">{realtimeErrorHeadline(error.reason, t)}</p>
        <div className="cmp-voice-actions">
          <button type="button" ref={retryRef} className="cmp-voice-btn" onClick={onRetry}>
            {t("common.tryAgain")}
          </button>
          <button type="button" className="cmp-voice-btn" onClick={onDismiss}>
            {t("common.dismiss")}
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
  memoryContextCount,
  memoryActions,
  onAcceptMemoryCandidate,
  onRejectMemoryCandidate,
}: {
  readonly controller: RealtimeVoiceController;
  readonly onAfterDismiss: () => void;
  readonly memoryContextText?: string | undefined;
  readonly memoryContextCount?: number | undefined;
  readonly memoryActions?: readonly ConversationMemoryActionWire[] | undefined;
  readonly onAcceptMemoryCandidate?: ((proposalId: string) => Promise<void>) | undefined;
  readonly onRejectMemoryCandidate?: ((proposalId: string) => Promise<void>) | undefined;
}): ReactNode {
  return (
    <VoiceRealtimeStatus
      phase={controller.phase}
      error={controller.error}
      onRetry={controller.retry}
      memoryContextText={memoryContextText}
      memoryContextCount={memoryContextCount}
      memoryActions={memoryActions}
      onAcceptMemoryCandidate={onAcceptMemoryCandidate}
      onRejectMemoryCandidate={onRejectMemoryCandidate}
      onDismiss={() => {
        controller.stop();
        onAfterDismiss();
      }}
    />
  );
}
