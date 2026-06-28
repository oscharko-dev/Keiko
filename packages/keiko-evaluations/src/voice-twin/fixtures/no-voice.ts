// No-voice fixtures (Issue #505; AC1 / AC2). Every cell here resolves to effective profile `none`: the
// no-voice environment crossed with each advertised capability (all degrade to none), plus the
// provider-configured environments crossed with an advertised `none`. They exercise no-voice-dormancy and
// capability-matrix-consistency. A `none` cell egresses nowhere, so its egress ledger is empty (approved)
// and its manifests are clean.

import type { VoiceTwinDimension, VoiceTwinFixture } from "../types.js";

const CLEAN_MANIFESTS = [{ packageName: "keiko-server", dependencyNames: ["ws"] }] as const;

function noVoiceFixture(
  name: string,
  environment: VoiceTwinFixture["environment"],
  advertisedProfile: VoiceTwinFixture["advertisedProfile"],
  description: string,
  extraDimensions: readonly VoiceTwinDimension[] = [],
): VoiceTwinFixture {
  return {
    name,
    category: "no-voice",
    description,
    environment,
    advertisedProfile,
    egressLedger: [],
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set(["no-voice-dormancy", "capability-matrix-consistency", ...extraDimensions]),
    oracle: {
      expectedEffectiveProfile: "none",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

export const NO_VOICE_FIXTURES: readonly VoiceTwinFixture[] = [
  // The dormant baseline also exercises the latency-class dimension to prove a `none` profile maps to the
  // `none` latency class (no latency surface at all) — the negative end of the latency-posture proof.
  noVoiceFixture(
    "no-voice-env-advertises-none",
    "no-voice-env",
    "none",
    "No provider configured and none advertised: fully dormant baseline.",
    ["latency-class-metric"],
  ),
  noVoiceFixture(
    "no-voice-env-degrades-stt",
    "no-voice-env",
    "speech-to-text",
    "Advertised STT degrades to none when no provider is configured.",
  ),
  noVoiceFixture(
    "no-voice-env-degrades-speech-output",
    "no-voice-env",
    "speech-output",
    "Advertised speech-output degrades to none when no provider is configured.",
  ),
  noVoiceFixture(
    "no-voice-env-degrades-full-realtime",
    "no-voice-env",
    "full-realtime",
    "Advertised full-realtime degrades to none when no provider is configured.",
  ),
  noVoiceFixture(
    "azure-foundry-none",
    "azure-foundry",
    "none",
    "Azure environment with voice not enabled: dormant, no egress.",
  ),
  noVoiceFixture(
    "customer-hosted-none",
    "customer-hosted",
    "none",
    "Customer-hosted environment with voice not enabled: dormant, no egress.",
  ),
];
