// Speech-output fixtures (Issue #505). The provider-configured environments crossed with an advertised
// speech-output capability. They exercise the AC6 interruption (barge-in) metric and
// capability-matrix-consistency. A speech-output cell egresses only to the configured model endpoint and
// permits playback + interrupt control kinds but no WebRTC media signalling.

import type { VoiceTwinFixture } from "../types.js";

const CLEAN_MANIFESTS = [{ packageName: "keiko-server", dependencyNames: ["ws"] }] as const;

const CONFIGURED_LEDGER = [{ class: "configured-model-endpoint" as const }] as const;

function speechOutputFixture(
  name: string,
  environment: "azure-foundry" | "customer-hosted",
  description: string,
): VoiceTwinFixture {
  return {
    name,
    category: "speech-output",
    description,
    environment,
    advertisedProfile: "speech-output",
    egressLedger: CONFIGURED_LEDGER,
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set([
      "interruption-metric",
      "capability-matrix-consistency",
      "external-destination-privacy",
      "latency-class-metric",
    ]),
    oracle: {
      expectedEffectiveProfile: "speech-output",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

export const SPEECH_OUTPUT_FIXTURES: readonly VoiceTwinFixture[] = [
  speechOutputFixture(
    "azure-foundry-speech-output",
    "azure-foundry",
    "Azure speech-output playback with barge-in interruption permitted.",
  ),
  speechOutputFixture(
    "customer-hosted-speech-output",
    "customer-hosted",
    "Customer-hosted speech-output playback over the controlled network.",
  ),
];
