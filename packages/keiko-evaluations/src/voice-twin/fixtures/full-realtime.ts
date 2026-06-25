// Full-realtime fixtures (Issue #505; AC4). The provider-configured environments crossed with an
// advertised full-realtime capability. They exercise transport-plane-separation (webrtc media +
// proxied-sdp negotiation + loopback control + SDP / media-track kinds), interruption,
// buffer-boundedness, provider-failure-recovery, and capability-matrix-consistency. A full-realtime cell
// egresses only to the configured model endpoint.

import type { VoiceTwinFixture } from "../types.js";

const CLEAN_MANIFESTS = [{ packageName: "keiko-server", dependencyNames: ["ws"] }] as const;

const CONFIGURED_LEDGER = [{ class: "configured-model-endpoint" as const }] as const;

function fullRealtimeFixture(
  name: string,
  environment: "azure-foundry" | "customer-hosted",
  description: string,
): VoiceTwinFixture {
  return {
    name,
    category: "full-realtime",
    description,
    environment,
    advertisedProfile: "full-realtime",
    egressLedger: CONFIGURED_LEDGER,
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set([
      "transport-plane-separation",
      "interruption-metric",
      "buffer-boundedness-metric",
      "provider-failure-recovery-metric",
      "capability-matrix-consistency",
      "external-destination-privacy",
      "latency-class-metric",
    ]),
    oracle: {
      expectedEffectiveProfile: "full-realtime",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

export const FULL_REALTIME_FIXTURES: readonly VoiceTwinFixture[] = [
  fullRealtimeFixture(
    "azure-foundry-full-realtime",
    "azure-foundry",
    "Azure full-duplex realtime: WebRTC media, proxied-SDP, loopback control plane.",
  ),
  fullRealtimeFixture(
    "customer-hosted-full-realtime",
    "customer-hosted",
    "Customer-hosted full-duplex realtime over the controlled network.",
  ),
];
