// STT-only fixtures (Issue #505; AC3). The provider-configured environments crossed with an advertised
// speech-to-text capability, which stays speech-to-text (no degradation). They exercise
// stt-affordance-bounding (the SDP / media / playback / interrupt kinds must be excluded),
// capability-matrix-consistency, and the AC6 end-of-turn + transcript-correction metrics (STT is a
// transcript-capture profile). A speech-to-text cell egresses only to the configured model endpoint.

import type { VoiceTwinFixture } from "../types.js";

const CLEAN_MANIFESTS = [{ packageName: "keiko-server", dependencyNames: ["ws"] }] as const;

const CONFIGURED_LEDGER = [{ class: "configured-model-endpoint" as const }] as const;

function sttFixture(
  name: string,
  environment: "azure-foundry" | "customer-hosted",
  description: string,
): VoiceTwinFixture {
  return {
    name,
    category: "stt-only",
    description,
    environment,
    advertisedProfile: "speech-to-text",
    egressLedger: CONFIGURED_LEDGER,
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set([
      "stt-affordance-bounding",
      "capability-matrix-consistency",
      "external-destination-privacy",
      "end-of-turn-metric",
      "transcript-correction-metric",
      "latency-class-metric",
    ]),
    oracle: {
      expectedEffectiveProfile: "speech-to-text",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

export const STT_ONLY_FIXTURES: readonly VoiceTwinFixture[] = [
  sttFixture(
    "azure-foundry-stt",
    "azure-foundry",
    "Azure STT-only dictation: transcript kinds only, no WebRTC / media / playback affordances.",
  ),
  sttFixture(
    "customer-hosted-stt",
    "customer-hosted",
    "Customer-hosted STT-only dictation over the controlled network: configured-endpoint egress only.",
  ),
];
