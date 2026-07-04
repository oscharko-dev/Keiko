// Voice Digital Twin profile × environment model (Epic #491, Issue #505; ADR-0110).
//
// The two orthogonal axes the capstone evaluates: the contract `VoiceProfile` capability axis and the
// deployment ENVIRONMENT axis (`docs/voice/deployment-profile-matrix.md` §1). `effectiveVoiceProfile`
// applies the matrix §3 degradation rule — in a no-voice environment EVERY advertised capability degrades
// to `none` because no provider is configured; in a provider-configured environment the advertised
// capability is the effective profile. `egressDestinationClassFor` encodes the matrix §3 / privacy-contract
// §1 external-call rule: an effective-none cell egresses nowhere, any active capability egresses ONLY to
// the configured model endpoint. Pure.

import { VOICE_PROFILE_MEDIA_TRANSPORT, type VoiceProfile } from "@oscharko-dev/keiko-contracts";
import type { EgressDestinationClass, VoiceEnvironmentProfile } from "./types.js";

// The four capability-axis profiles, declared locally because the contract exports no `VOICE_PROFILES`
// array. `profiles.test.ts` asserts this equals the keys of `VOICE_PROFILE_MEDIA_TRANSPORT` so it can
// never drift from the contract.
export const ALL_VOICE_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
] as const;

// Whether the contract's media-transport table — keyed by `VoiceProfile` for totality — still lists
// exactly the locally-declared profiles. A drift (a new profile added to the contract) makes this false.
export function localProfilesMatchContract(): boolean {
  const contractKeys = Object.keys(VOICE_PROFILE_MEDIA_TRANSPORT).slice().sort();
  const local = ALL_VOICE_PROFILES.slice().sort();
  return contractKeys.length === local.length && contractKeys.every((k, i) => k === local[i]);
}

// ─── Environment descriptors ─────────────────────────────────────────────────────────
// `networkPosture` is a content-free label for the deployment's egress posture; `egresses` is whether a
// configured provider exists at all (false for the no-voice environment, where capability degrades to
// `none`).
export type VoiceNetworkPosture = "cloud-provider" | "controlled-network" | "no-provider";

export interface VoiceEnvironmentDescriptor {
  readonly id: VoiceEnvironmentProfile;
  readonly label: string;
  readonly networkPosture: VoiceNetworkPosture;
  readonly egresses: boolean;
}

export const VOICE_ENVIRONMENT_DESCRIPTORS: Record<
  VoiceEnvironmentProfile,
  VoiceEnvironmentDescriptor
> = {
  "azure-foundry": {
    id: "azure-foundry",
    label: "Azure AI Foundry dev/academic",
    networkPosture: "cloud-provider",
    egresses: true,
  },
  "customer-hosted": {
    id: "customer-hosted",
    label: "Customer-hosted controlled-network",
    networkPosture: "controlled-network",
    egresses: true,
  },
  "no-voice-env": {
    id: "no-voice-env",
    label: "No voice provider configured",
    networkPosture: "no-provider",
    egresses: false,
  },
} as const;

// ─── Effective profile (matrix §3 degradation rule) ──────────────────────────────────
// In a no-voice environment nothing is configured, so any advertised capability degrades to `none`
// (AC1/AC2). Otherwise the advertised capability is the effective profile.
export function effectiveVoiceProfile(
  environment: VoiceEnvironmentProfile,
  advertised: VoiceProfile,
): VoiceProfile {
  return VOICE_ENVIRONMENT_DESCRIPTORS[environment].egresses ? advertised : "none";
}

// ─── Egress destination class (matrix §3 external-call rule) ──────────────────────────
// An effective-none cell egresses nowhere; any active capability egresses only to the configured model
// endpoint. This is the ONLY positive egress class the matrix permits.
export function egressDestinationClassFor(effectiveProfile: VoiceProfile): EgressDestinationClass {
  return effectiveProfile === "none" ? "none" : "configured-model-endpoint";
}
