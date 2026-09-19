// Pure, React-free availability matrix for Voice Dialogue. Turn signals, recovery, barge-in, and
// persistence are owned by the live `useRealtimeVoice` hook and its `createVoiceTurnManager` instance.
// Keeping this module small avoids a second, misleading dialogue-session layer.

import type { VoiceCapabilityResolution } from "@/lib/types";
import {
  supportsDictation,
  supportsRealtimeVoice,
  supportsSpeechOutput,
} from "./useVoiceCapability";

// Capture strategy for one spoken conversation. `"none"` is the fail-closed default. The existing
// composer dictation flow stays separate; batch dialogue owns turn delivery and spoken replies.
export type VoiceDialogueCapture = "none" | "webrtc" | "batch";

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

// Prefer native Realtime when its media posture and browser support allow it. Otherwise the
// browser can capture one short STT turn at a time and receive a spoken canonical chat answer.
export function voiceDialogueModeForResolution(
  resolution: VoiceCapabilityResolution | undefined,
  browserRealtimeSupported: boolean,
  browserBatchSupported = false,
): VoiceDialogueMode {
  const personaCount = resolution?.availableVoicePersonas?.length ?? 0;
  const nativeOffered =
    supportsRealtimeVoice(resolution) &&
    supportsSpeechOutput(resolution) &&
    browserRealtimeSupported &&
    personaCount > 0;
  if (nativeOffered) return { offered: true, capture: "webrtc", speaks: true, canInterrupt: true };
  return batchDialogueMode(resolution, browserBatchSupported, personaCount);
}

function batchDialogueMode(
  resolution: VoiceCapabilityResolution | undefined,
  browserBatchSupported: boolean,
  personaCount: number,
): VoiceDialogueMode {
  const offered =
    supportsDictation(resolution) &&
    supportsSpeechOutput(resolution) &&
    browserBatchSupported &&
    personaCount > 0;
  return offered
    ? { offered: true, capture: "batch", speaks: true, canInterrupt: false }
    : DIALOGUE_DORMANT;
}
