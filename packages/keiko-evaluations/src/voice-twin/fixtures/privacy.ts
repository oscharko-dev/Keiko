// Privacy fixtures (Issue #505; AC5). These exercise external-destination-privacy directly. POSITIVE
// fixtures carry only `none` / `configured-model-endpoint` egress and clean manifests (audit approved).
// NEGATIVE fixtures carry an `unapproved-external` destination and/or a denied media package — they PASS
// the dimension by being CAUGHT: the auditor correctly returns approved=false / clean=false, which is what
// their oracle expects. This proves the AC5 teeth: a voice addition that introduces an unapproved external
// destination, or a denied runtime media package, does not silently pass.

import type { VoiceTwinFixture } from "../types.js";

const CLEAN_MANIFESTS = [{ packageName: "keiko-server", dependencyNames: ["ws"] }] as const;

export const PRIVACY_FIXTURES: readonly VoiceTwinFixture[] = [
  {
    name: "privacy-positive-configured-endpoint",
    category: "privacy",
    description: "A realtime cell egressing only to the configured model endpoint audits approved.",
    environment: "customer-hosted",
    advertisedProfile: "full-realtime",
    egressLedger: [{ class: "configured-model-endpoint" }],
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set(["external-destination-privacy"]),
    oracle: {
      expectedEffectiveProfile: "full-realtime",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  },
  {
    name: "privacy-positive-none",
    category: "privacy",
    description: "A dormant cell with no egress audits approved.",
    environment: "no-voice-env",
    advertisedProfile: "full-realtime",
    egressLedger: [],
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set(["external-destination-privacy"]),
    oracle: {
      expectedEffectiveProfile: "none",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  },
  {
    name: "privacy-negative-unapproved-external",
    category: "privacy",
    description:
      "A voice addition routing audio to an unapproved external destination is correctly caught (approved=false).",
    environment: "azure-foundry",
    advertisedProfile: "full-realtime",
    egressLedger: [{ class: "configured-model-endpoint" }, { class: "unapproved-external" }],
    manifests: CLEAN_MANIFESTS,
    dimensions: new Set(["external-destination-privacy"]),
    oracle: {
      expectedEffectiveProfile: "full-realtime",
      expectedEgressApproved: false,
      expectedManifestsClean: true,
    },
  },
  {
    name: "privacy-negative-denied-media-package",
    category: "privacy",
    description:
      "A voice addition pulling in a denied runtime media package is correctly caught (clean=false).",
    environment: "azure-foundry",
    advertisedProfile: "full-realtime",
    egressLedger: [{ class: "unapproved-external" }],
    manifests: [{ packageName: "keiko-ui", dependencyNames: ["simple-peer", "ws"] }],
    dimensions: new Set(["external-destination-privacy"]),
    oracle: {
      expectedEffectiveProfile: "full-realtime",
      expectedEgressApproved: false,
      expectedManifestsClean: false,
    },
  },
];
