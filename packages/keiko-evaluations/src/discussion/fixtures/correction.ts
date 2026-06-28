// Correction / contradiction-handling discussion fixtures (Epic #491, Issue #502; AC3). These pin the
// evidence-check mode's strict citation discipline and the disclose-and-defer contradiction policy that
// governs how Keiko handles an unresolved contradiction (defer to the user). Pure value modules.

import type { DiscussionEvalFixture } from "../types.js";

export const evidenceCheckCorrection: DiscussionEvalFixture = {
  name: "evidence-check-correction",
  category: "correction",
  description:
    "Evidence-check mode in the `none` profile; strict citation discipline and disclose-and-defer on contradiction.",
  profile: "none",
  mode: "evidence-check",
  topicId: "topic-evidence-check",
  dimensions: new Set([
    "mode-appropriateness",
    "disagreement-completeness",
    "uncertainty-discipline",
    "evidence-citation-discipline",
    "correction-handling",
    "capability-gating",
  ]),
  oracle: {
    expectedMandatedFacets: ["evidence", "assumptions", "uncertainty"],
    expectedGatingAllowed: false,
    expectedUncertaintyDisclosure: true,
    expectedDecisionRecommendation: false,
    expectedContradictionPolicies: ["disclose-and-defer"],
  },
};

export const voiceEvidenceCheckCorrection: DiscussionEvalFixture = {
  name: "voice-evidence-check-correction",
  category: "correction",
  description:
    "Evidence-check mode under a speech-to-text profile; same correction handling reached via voice.",
  profile: "speech-to-text",
  mode: "evidence-check",
  topicId: "topic-evidence-check-stt",
  dimensions: new Set([
    "mode-appropriateness",
    "disagreement-completeness",
    "uncertainty-discipline",
    "evidence-citation-discipline",
    "correction-handling",
    "capability-gating",
  ]),
  oracle: {
    expectedMandatedFacets: ["evidence", "assumptions", "uncertainty"],
    expectedGatingAllowed: true,
    expectedUncertaintyDisclosure: true,
    expectedDecisionRecommendation: false,
    expectedContradictionPolicies: ["disclose-and-defer"],
  },
};

export const CORRECTION_FIXTURES: readonly DiscussionEvalFixture[] = [
  evidenceCheckCorrection,
  voiceEvidenceCheckCorrection,
];
