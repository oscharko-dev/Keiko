// Pure, React-free availability matrix for Voice Dialogue. Turn signals, recovery, barge-in, and
// persistence are owned by the live `useRealtimeVoice` hook and its `createVoiceTurnManager` instance.
// Keeping this module small avoids a second, misleading dialogue-session layer.

import type { VoiceCapabilityResolution } from "@/lib/types";
import { supportsRealtimeVoice } from "./useVoiceCapability";

// ─── Fallback matrix (D2) ────────────────────────────────────────────────────────
// The capture strategy the offered session uses. `"none"` is the fail-closed default for every
// not-offered case; `"webrtc"` is the only Voice Dialogue path. STT dictation stays a separate
// composer feature and must never be treated as spoken dialogue.
export type VoiceDialogueCapture = "none" | "webrtc";

// The total description the matrix returns for a resolution. `offered` gates the dialogue switch; the
// remaining fields describe what an offered session can do. Every field is deterministically derived,
// so the whole object is one pure function of the inputs.
export interface VoiceDialogueMode {
  readonly offered: boolean;
  readonly capture: VoiceDialogueCapture;
  readonly speaks: boolean;
  readonly canInterrupt: boolean;
}

const DIALOGUE_DORMANT: VoiceDialogueMode = {
  offered: false,
  capture: "none",
  speaks: false,
  canInterrupt: false,
};

// Dialogue is offered IFF the deployment advertises full realtime voice, the media posture includes
// WebRTC, the browser exposes realtime media APIs, and at least one persona is advertised. STT-only,
// speech-output-only, and "full realtime without browser WebRTC" deployments deliberately stay
// dormant: there is no STT -> Chat -> TTS fallback masquerading as Voice Dialogue.
export function voiceDialogueModeForResolution(
  resolution: VoiceCapabilityResolution | undefined,
  browserRealtimeSupported: boolean,
): VoiceDialogueMode {
  const personaCount = resolution?.availableVoicePersonas?.length ?? 0;
  const offered = supportsRealtimeVoice(resolution) && browserRealtimeSupported && personaCount > 0;
  if (!offered) {
    return DIALOGUE_DORMANT;
  }
  return { offered: true, capture: "webrtc", speaks: true, canInterrupt: true };
}
