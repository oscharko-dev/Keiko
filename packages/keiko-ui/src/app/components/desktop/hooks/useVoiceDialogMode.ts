// Issue #1559, Epic #1556 — the UI state hook behind the chat dialog-mode switch and voice-profile
// selection. It owns NO transport and NO orchestration: it gates availability off the existing
// capability probe, persists a content-free persona preference, and exposes the active flag plus
// enter / leave intents. The actual realtime session is started / stopped by the existing
// `useRealtimeVoice` controller in ChatWindow; this hook only records the user's intent so the two
// stay decoupled (a no-op enter on an unavailable deployment can never start a session).
//
// Fail-closed everywhere: an undefined / unavailable capability, an empty persona list, a stale or
// corrupt localStorage value, or a missing `window` (SSR) all resolve to "no dialogue offered" or the
// first available persona. The persisted value is the persona ENUM only ("male" | "female" | "neutral")
// — never a voice id — so nothing content-bearing is written to disk.

import { useCallback, useEffect, useMemo, useState } from "react";
import { VOICE_PERSONAS, type VoicePersona } from "@oscharko-dev/keiko-contracts";
import type { VoiceCapabilityResolution } from "@/lib/types";
import { supportsRealtimeVoice } from "./useVoiceCapability";
import { realtimeVoiceTransportSupported } from "./voice-rtc-transport";

const PERSONA_STORAGE_KEY = "keiko.voice.dialog.persona";

const VALID_PERSONAS: ReadonlySet<string> = new Set(VOICE_PERSONAS);

export interface UseVoiceDialogModeOptions {
  readonly capability: VoiceCapabilityResolution | undefined;
}

export interface VoiceDialogMode {
  // True only when the deployment can hold a realtime spoken dialogue AND offers at least one persona.
  readonly available: boolean;
  // The personas the deployment offers, in canonical VOICE_PERSONAS order. Empty when unavailable.
  readonly availablePersonas: readonly VoicePersona[];
  // The selected persona (always one of availablePersonas while available; the first otherwise).
  readonly persona: VoicePersona;
  readonly selectPersona: (persona: VoicePersona) => void;
  // Whether the user has entered spoken dialogue. Always false while unavailable.
  readonly active: boolean;
  readonly enter: () => void;
  readonly leave: () => void;
}

// Read the persisted persona, re-validated against the personas this deployment currently offers. A
// value that is absent, malformed, or no longer offered (deployment changed) falls back to the first
// available persona, so the selection is never stale or invalid (fail-closed). Never throws: a missing
// or sandboxed localStorage (SSR, privacy mode) is caught and treated as "no stored preference".
function readStoredPersona(available: readonly VoicePersona[]): VoicePersona | undefined {
  if (available.length === 0) {
    return undefined;
  }
  let stored: string | null = null;
  try {
    stored =
      typeof window === "undefined" ? null : window.localStorage.getItem(PERSONA_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored !== null && VALID_PERSONAS.has(stored) && available.includes(stored as VoicePersona)) {
    return stored as VoicePersona;
  }
  return available[0];
}

// Persist the persona enum. Swallows storage failures (quota, privacy mode, SSR) so a chat that cannot
// persist a preference still works for the current session.
function writeStoredPersona(persona: VoicePersona): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PERSONA_STORAGE_KEY, persona);
    }
  } catch {
    // best-effort: a non-persisted preference is acceptable; the in-memory selection still applies.
  }
}

export function useVoiceDialogMode(options: UseVoiceDialogModeOptions): VoiceDialogMode {
  const { capability } = options;

  // The personas are taken straight from the capability (already sorted canonically by the contract).
  // Joined into a stable string so the memo key does not churn on a new-but-equal array each render.
  const personaKey = (capability?.availableVoicePersonas ?? []).join(",");
  const availablePersonas = useMemo<readonly VoicePersona[]>(
    () => capability?.availableVoicePersonas ?? [],
    // personaKey captures the content; capability identity is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [personaKey],
  );

  // Voice Dialogue is the product conversation surface, and the productive path is Realtime WebRTC.
  // STT-only and STT+TTS deployments remain available as dictation/read-aloud surfaces elsewhere; they
  // do not light up this dialogue switch. The persona list remains required so the server can resolve
  // the selected product persona to a provider voice without exposing provider ids to the browser.
  const available =
    supportsRealtimeVoice(capability) &&
    realtimeVoiceTransportSupported() &&
    availablePersonas.length > 0;

  const [persona, setPersona] = useState<VoicePersona>(
    () => readStoredPersona(availablePersonas) ?? VOICE_PERSONAS[0]!,
  );
  const [active, setActive] = useState(false);

  // Re-validate the selection whenever the offered personas change (deployment switch, late probe). A
  // selection no longer offered snaps to the first available persona; this never runs while the list is
  // empty (the selection is meaningless there).
  useEffect(() => {
    if (availablePersonas.length === 0) {
      return;
    }
    setPersona((current) =>
      availablePersonas.includes(current)
        ? current
        : (readStoredPersona(availablePersonas) ?? availablePersonas[0]!),
    );
  }, [availablePersonas]);

  // Leaving is forced the moment the deployment stops offering dialogue, so a capability that flips to
  // unavailable mid-session can never leave the controls stranded in an active state (AC3).
  useEffect(() => {
    if (!available) {
      setActive(false);
    }
  }, [available]);

  const selectPersona = useCallback(
    (next: VoicePersona) => {
      if (!availablePersonas.includes(next)) {
        return;
      }
      setPersona(next);
      writeStoredPersona(next);
    },
    [availablePersonas],
  );

  const enter = useCallback(() => {
    // Fail-closed: entering is a no-op when no dialogue is offered, so the switch can never start a
    // session the deployment cannot hold.
    if (available) {
      setActive(true);
    }
  }, [available]);

  const leave = useCallback(() => {
    setActive(false);
  }, []);

  return {
    available,
    availablePersonas,
    persona,
    selectPersona,
    active: active && available,
    enter,
    leave,
  };
}
