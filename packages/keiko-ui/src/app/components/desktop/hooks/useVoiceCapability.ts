// Issue #495, Epic #491 — non-blocking voice-capability probe for the chat composer.
//
// The composer must consult the local voice-capability resolution (Issue #493) BEFORE rendering any
// dictation affordance, but that probe must NEVER block composer rendering: in a no-voice deployment
// the composer stays clean, stable, and fully text-capable. This hook fires the probe lazily on first
// mount and returns `undefined` until it resolves; the composer renders fully meanwhile and only adds
// the microphone affordance once the resolution reports speech-to-text capability.

import { useEffect, useState } from "react";
import { fetchVoiceCapability } from "@/lib/api";
import type { VoiceCapabilityResolution } from "@/lib/types";

// Module-cached single-flight probe. The resolution is content-free and stable for the lifetime of a
// gateway config, so one fetch is shared across every composer instance and remount (mirrors the
// `fetchModels` memoized-promise pattern in lib/api.ts). A transport failure is NOT cached, so a later
// mount retries instead of being stuck on a transient error.
let capabilityRequest: Promise<VoiceCapabilityResolution> | undefined;

async function loadVoiceCapability(): Promise<VoiceCapabilityResolution> {
  capabilityRequest ??= fetchVoiceCapability()
    .then((response) => response.voice)
    .catch((error: unknown) => {
      capabilityRequest = undefined;
      throw error;
    });
  return capabilityRequest;
}

// Test-only reset so each test starts from an unresolved probe (mirrors `clearModelCacheForTests`).
export function clearVoiceCapabilityCacheForTests(): void {
  capabilityRequest = undefined;
}

// Returns the resolved voice capability, or `undefined` while the probe is in flight or after it
// failed. Callers MUST treat `undefined` and an unavailable resolution identically — render no voice
// affordance — so a slow or failed probe can never leave a broken control in the composer (AC1).
export function useVoiceCapability(): VoiceCapabilityResolution | undefined {
  const [resolution, setResolution] = useState<VoiceCapabilityResolution | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void loadVoiceCapability().then(
      (voice) => {
        if (!cancelled) setResolution(voice);
      },
      () => {
        // Fail safe: a failed probe leaves the resolution undefined, so the mic stays hidden and the
        // composer remains fully usable. Never logs the error (it could carry transport detail).
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return resolution;
}

// True only when the resolved capability advertises controlled speech-to-text dictation. STT-only is
// the single profile Issue #495 surfaces; speech output and full-realtime conversation are deliberately
// NOT actioned here (a transcription endpoint can never imply full Voice Digital Twin conversation —
// AC5). `undefined` (unresolved/failed) and any unavailable resolution both return false.
export function supportsDictation(resolution: VoiceCapabilityResolution | undefined): boolean {
  return resolution !== undefined && resolution.available && resolution.capabilities.speechToText;
}

// True only when the resolved capability is the full-realtime profile — the single profile that may
// open the WebSocket control plane and the browser WebRTC media plane (Issue #497, AC1/AC3). Reuses
// the same module-cached probe (no second fetch). STT-only and speech-output deployments return false,
// so they expose dictation but never the realtime transport. `undefined` (unresolved/failed) and any
// unavailable resolution both return false, so a slow or failed probe never lights up the realtime UI.
export function supportsRealtimeVoice(resolution: VoiceCapabilityResolution | undefined): boolean {
  return (
    resolution !== undefined &&
    resolution.available &&
    resolution.profile === "full-realtime" &&
    resolution.capabilities.realtimeVoice &&
    resolution.transport.webrtcMedia
  );
}

// True only when deployments explicitly advertise Realtime function calling. Grounded Voice uses this
// as the UI-side branch guard: without it the session still opens and every spoken turn is recorded,
// but the provider is not asked to call Keiko's grounded retrieval tool.
export function supportsRealtimeToolCalling(
  resolution: VoiceCapabilityResolution | undefined,
): boolean {
  return (
    resolution !== undefined &&
    supportsRealtimeVoice(resolution) &&
    resolution.capabilities.realtimeToolCalling === true
  );
}

// True only when the resolved capability advertises optional assistant speech output — the providers
// that may speak the assistant's reply (text-to-speech or realtime speech output). This is the Issue
// #501 gate: it is satisfied by the `speech-output` profile and by `full-realtime` (which also speaks),
// but NEVER by `speech-to-text` (dictation does not imply the assistant can speak — AC1) or `none`.
// Reuses the same module-cached probe (no second fetch). `undefined` (unresolved/failed) and any
// unavailable resolution both return false, so a slow or failed probe never lights up the playback UI
// and Keiko answers in text with no broken playback affordance (AC1).
export function supportsSpeechOutput(resolution: VoiceCapabilityResolution | undefined): boolean {
  return (
    resolution !== undefined &&
    resolution.available &&
    resolution.capabilities.speechOutput &&
    (resolution.profile === "speech-output" || resolution.profile === "full-realtime")
  );
}
