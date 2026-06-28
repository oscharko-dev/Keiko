"use client";

// Issue #1559, Epic #1556 — presentational dialog-mode controls.
//
// Four surfaces compose the spoken-dialogue UX over the existing voice hooks. None of them owns
// transport or capability gating — the caller renders them only when `useVoiceDialogMode` reports the
// deployment can hold a realtime dialogue, so a no-voice / STT-only / speech-output-only deployment
// shows nothing new and the composer stays clean and fully text-capable (AC1/AC3):
//   - VoiceDialogModeSwitch: a role="switch" that enters / leaves spoken dialogue.
//   - VoiceProfileSelect: a male / female / neutral persona selector with a visible active-voice label.
//   - VoiceDialogSessionStatus: a live-region status strip announcing the session state.
//   - VoiceDialogControls: the active-session cluster (mute reuse + Stop + Leave + persona selector).
//
// Reuses the existing `.auto-toggle`, `.cmp-voice*`, `.ksel-*`, and `.sr-only` classes so globals.css is
// NOT modified (its SHA is pinned by tests). Decorative glyphs are `aria-hidden`; the accessible name
// always comes from the control's label.

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import KeikoSelect from "./KeikoSelect";
import { VoicePlaybackMuteButton } from "./VoicePlayback";
import {
  voiceDialogStateHeadline,
  voiceDialogStateIsLive,
  type VoiceDialogState,
} from "./hooks/voice-dialog-state";

// Professional-English display label per persona. Content-free: the label describes the product persona
// the user picks, never an underlying voice id (which the server resolves and the browser never sees).
const PERSONA_LABEL: Record<VoicePersona, string> = {
  male: "Male voice",
  female: "Female voice",
  neutral: "Neutral voice",
};

export function personaLabel(persona: VoicePersona): string {
  return PERSONA_LABEL[persona];
}

// Decorative Keiko logo for the dialogue switch; `aria-hidden` so the accessible name comes from the
// switch's `aria-label`.
function KeikoLogoGlyph(): ReactNode {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- this matches the header logo treatment and keeps the icon unwrapped inside the fixed-size button.
    <img
      src="/assets/keiko-logo.svg"
      alt=""
      width={34}
      height={34}
      aria-hidden="true"
      decoding="async"
    />
  );
}

interface VoiceDialogModeSwitchProps {
  readonly active: boolean;
  readonly onToggle: () => void;
  readonly disabled?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
}

const SWITCH_LABEL = "Voice dialogue mode";

export function VoiceDialogModeSwitch({
  active,
  onToggle,
  disabled = false,
  compact = false,
  buttonRef,
}: VoiceDialogModeSwitchProps): ReactNode {
  // role="switch" + aria-checked mirrors the shared Toggle but carries the Keiko logo and tooltip,
  // so screen-reader users hear an on/off control with a stable accessible name (AC4).
  return (
    <button
      type="button"
      ref={buttonRef}
      role="switch"
      aria-checked={active}
      aria-label={SWITCH_LABEL}
      data-tip={SWITCH_LABEL}
      data-active={active ? "true" : "false"}
      disabled={disabled}
      className={`cmp-icon cmp-voice cmp-voice-dialog-logo ui-tip${compact ? " cmp-mode-compact" : ""}`}
      onClick={onToggle}
    >
      <KeikoLogoGlyph />
    </button>
  );
}

interface VoiceProfileSelectProps {
  readonly personas: readonly VoicePersona[];
  readonly selected: VoicePersona;
  readonly onSelect: (persona: VoicePersona) => void;
  readonly disabled?: boolean | undefined;
  readonly compact?: boolean | undefined;
}

// Stable id for the visible active-voice label that names the selector (AC2/AC4).
export const VOICE_PROFILE_LABEL_ID = "cmp-voice-dialog-profile-label";

export function VoiceProfileSelect({
  personas,
  selected,
  onSelect,
  disabled = false,
  compact = false,
}: VoiceProfileSelectProps): ReactNode {
  // Render nothing when there is nothing to choose; the caller already gates on availability, but this
  // keeps the component honest in isolation (no empty combobox).
  if (personas.length === 0) {
    return null;
  }
  return (
    <div className={`cmp-model mono${compact ? " cmp-model-compact" : ""}`}>
      <span id={VOICE_PROFILE_LABEL_ID} className="sr-only">
        {`Voice profile: ${personaLabel(selected)}`}
      </span>
      <KeikoSelect
        value={selected}
        ariaLabelledBy={VOICE_PROFILE_LABEL_ID}
        disabled={disabled}
        menuTitle="Voice profile"
        onValueChange={(next) => {
          // KeikoSelect is string-typed; the options are persona enums, so the value is always a valid
          // persona. Guard anyway so a future option never widens the call.
          if ((personas as readonly string[]).includes(next)) {
            onSelect(next as VoicePersona);
          }
        }}
        sections={[
          {
            options: personas.map((persona) => ({
              value: persona,
              label: personaLabel(persona),
            })),
          },
        ]}
      />
    </div>
  );
}

interface VoiceDialogSessionStatusProps {
  readonly state: VoiceDialogState;
}

const TEXT_FALLBACK_MESSAGE =
  "Voice dialogue is optional. You can keep chatting with the assistant in text.";

export function VoiceDialogSessionStatus({ state }: VoiceDialogSessionStatusProps): ReactNode {
  const isError = state === "error";
  const isLive = voiceDialogStateIsLive(state);
  return (
    <div
      className={`cmp-voice-preview${isError ? " cmp-voice-error" : ""}`}
      role={isError ? "alert" : "status"}
      aria-live={isError ? undefined : "polite"}
      aria-atomic="true"
      data-dialog-state={state}
    >
      <p className={isError ? "cmp-voice-error-text" : undefined}>
        {isLive ? <span className="cmp-voice-dot" aria-hidden="true" /> : null}
        {voiceDialogStateHeadline(state)}
      </p>
      <span className="sr-only">{TEXT_FALLBACK_MESSAGE}</span>
    </div>
  );
}

interface VoiceDialogControlsProps {
  readonly state: VoiceDialogState;
  readonly muted: boolean;
  readonly onToggleMute: () => void;
  readonly canInterrupt?: boolean | undefined;
  readonly onInterrupt?: (() => void) | undefined;
  readonly onStop: () => void;
  readonly onLeave: () => void;
  readonly personas: readonly VoicePersona[];
  readonly selectedPersona: VoicePersona;
  readonly onSelectPersona: (persona: VoicePersona) => void;
  readonly compact?: boolean | undefined;
  readonly muteButtonRef?: Ref<HTMLButtonElement> | undefined;
}

export function VoiceDialogControls({
  state,
  muted,
  onToggleMute,
  canInterrupt = false,
  onInterrupt,
  onStop,
  onLeave,
  personas,
  selectedPersona,
  onSelectPersona,
  compact = false,
  muteButtonRef,
}: VoiceDialogControlsProps): ReactNode {
  const leaveRef = useRef<HTMLButtonElement>(null);

  // Focus handoff (WCAG 2.4.3): when the session errors out, move focus to the Leave control so the
  // recovery path is immediately reachable — mirrors VoicePlaybackStatus's failed-state handoff.
  useEffect(() => {
    if (state === "error") {
      leaveRef.current?.focus();
    }
  }, [state]);

  return (
    <div className="cmp-voice-actions" data-dialog-state={state}>
      <VoiceProfileSelect
        personas={personas}
        selected={selectedPersona}
        onSelect={onSelectPersona}
        compact={compact}
      />
      <VoicePlaybackMuteButton
        muted={muted}
        onToggle={onToggleMute}
        buttonRef={muteButtonRef}
        compact={compact}
      />
      {onInterrupt !== undefined ? (
        <button
          type="button"
          className="cmp-voice-btn"
          aria-label="Interrupt the assistant"
          disabled={!canInterrupt}
          onClick={onInterrupt}
        >
          Interrupt
        </button>
      ) : null}
      <button
        type="button"
        className="cmp-voice-btn"
        aria-label="Stop voice dialogue"
        onClick={onStop}
      >
        Stop
      </button>
      <button type="button" ref={leaveRef} className="cmp-voice-btn" onClick={onLeave}>
        Leave voice dialogue
      </button>
    </div>
  );
}

export interface VoiceDialogTurnControlsProps {
  // True while the dialogue mic is capturing the user's spoken turn (recording).
  readonly listening: boolean;
  // True while the assistant holds the floor and its answer is being spoken.
  readonly speaking: boolean;
  // True only when a barge-in is currently meaningful (the assistant holds the floor).
  readonly canInterrupt: boolean;
  // Toggle: start capturing when idle; stop-and-send (end the user turn) while listening.
  readonly onListen: () => void;
  // Barge-in: take the floor from the speaking assistant.
  readonly onInterrupt: () => void;
  readonly compact?: boolean | undefined;
}

// Issue #1560, Epic #1556 (ADR-0096) — the per-turn dialogue controls the user drives to actually
// speak. Separate from VoiceDialogControls (whose signature #1559 tests pin) so this issue adds the
// turn loop without disturbing the session cluster. Both buttons are plain, keyboard-operable buttons
// with a stable accessible name (WCAG 2.2 AA, AC4); the mic exposes its on/off state via aria-pressed,
// and the decorative glyphs are aria-hidden so the label is the accessible name.
export function VoiceDialogTurnControls({
  listening,
  speaking,
  canInterrupt,
  onListen,
  onInterrupt,
  compact = false,
}: VoiceDialogTurnControlsProps): ReactNode {
  // The mic label changes with capture state so a screen-reader user always hears what the next press
  // does: begin a turn, or end it and send. `speaking` is reflected in the data attribute for styling
  // only; it never widens the accessible name.
  const micLabel = listening ? "Stop speaking and send" : "Start speaking";
  // Reuse the existing `.cmp-voice-actions` cluster class (globals.css is SHA-pinned, #1300 proof gate);
  // capture / floor state rides on data-* attributes, so no new selector is introduced.
  return (
    <div
      className="cmp-voice-actions"
      data-voice-turn="true"
      data-compact={compact ? "true" : "false"}
    >
      <button
        type="button"
        className="cmp-voice-btn"
        aria-pressed={listening}
        aria-label={micLabel}
        data-tip={micLabel}
        data-listening={listening ? "true" : "false"}
        data-speaking={speaking ? "true" : "false"}
        onClick={onListen}
      >
        <span aria-hidden="true">{listening ? "Stop" : "Speak"}</span>
      </button>
      <button
        type="button"
        className="cmp-voice-btn"
        aria-label="Interrupt the assistant"
        data-tip="Interrupt the assistant"
        disabled={!canInterrupt}
        onClick={onInterrupt}
      >
        <span aria-hidden="true">Interrupt</span>
      </button>
    </div>
  );
}
