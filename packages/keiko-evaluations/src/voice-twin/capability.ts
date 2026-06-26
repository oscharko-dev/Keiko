// Voice Digital Twin capability-cell derivation (Epic #491, Issue #505; ADR-0068).
//
// `deriveCapabilityCell` resolves one environment × advertised-capability cell to the contract-derived
// facts the matrix asserts: the effective profile (after environment degradation), the allowed control
// message kinds, the media transport, the negotiation mode, the always-loopback control plane, the media
// plane id, and the egress class. Every fact is read directly from a frozen keiko-contracts table for the
// effective profile, so the scorer can compare the cell against those same tables and catch any drift or
// wrong derivation. Pure.

import {
  VOICE_CONTROL_TRANSPORTS,
  VOICE_MEDIA_PLANE,
  VOICE_PROFILE_ALLOWED_MESSAGE_KINDS,
  VOICE_PROFILE_MEDIA_TRANSPORT,
  VOICE_PROFILE_NEGOTIATION_MODE,
  type VoiceProfile,
} from "@oscharko-dev/keiko-contracts";
import { effectiveVoiceProfile, egressDestinationClassFor } from "./profiles.js";
import type { VoiceTwinCapabilityCell, VoiceEnvironmentProfile } from "./types.js";

export function deriveCapabilityCell(
  environment: VoiceEnvironmentProfile,
  advertised: VoiceProfile,
): VoiceTwinCapabilityCell {
  const effectiveProfile = effectiveVoiceProfile(environment, advertised);
  return {
    effectiveProfile,
    allowedKinds: VOICE_PROFILE_ALLOWED_MESSAGE_KINDS[effectiveProfile],
    mediaTransport: VOICE_PROFILE_MEDIA_TRANSPORT[effectiveProfile],
    negotiation: VOICE_PROFILE_NEGOTIATION_MODE[effectiveProfile],
    // The authoritative control / signaling plane is always realized on the host loopback seam; the
    // browser never holds media-negotiation authority directly (AC4). Derived from the contract transport
    // catalog: every control transport in `VOICE_CONTROL_TRANSPORTS` is a loopback transport, so adding a
    // non-loopback control transport to the contract flips this false and fails the AC4 dimension.
    controlPlaneIsLoopback: VOICE_CONTROL_TRANSPORTS.every((t) => t.startsWith("loopback-")),
    mediaPlaneId: VOICE_MEDIA_PLANE.plane,
    egressClass: egressDestinationClassFor(effectiveProfile),
  };
}
