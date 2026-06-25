// No-voice (text-first) discussion fixtures (Epic #491, Issue #502; AC1/AC6). These exercise the
// discussion scaffold in the `none` voice profile, proving every mode works text-first and that
// capability gating denies spoken turns for a profile with no capture capability. Pure value modules.

import type { DiscussionEvalFixture } from "../types.js";

export const noVoiceChallenge: DiscussionEvalFixture = {
  name: "no-voice-challenge",
  category: "no-voice",
  description:
    "Challenge mode in the text-first `none` profile; full disagreement structure mandated.",
  profile: "none",
  mode: "challenge",
  topicId: "topic-challenge-text",
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

export const noVoiceDecide: DiscussionEvalFixture = {
  name: "no-voice-decide",
  category: "no-voice",
  description: "Decide mode in the text-first `none` profile; produces a decision recommendation.",
  profile: "none",
  mode: "decide",
  topicId: "topic-decide-text",
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
    expectedDecisionRecommendation: true,
    expectedContradictionPolicies: ["disclose-and-defer"],
  },
};

export const noVoiceBrainstorm: DiscussionEvalFixture = {
  name: "no-voice-brainstorm",
  category: "no-voice",
  description:
    "Brainstorm mode in the `none` profile; relaxes uncertainty disclosure and expands options.",
  profile: "none",
  mode: "brainstorm",
  topicId: "topic-brainstorm-text",
  dimensions: new Set([
    "mode-appropriateness",
    "disagreement-completeness",
    "uncertainty-discipline",
    "evidence-citation-discipline",
    "correction-handling",
    "capability-gating",
  ]),
  oracle: {
    // Brainstorm relaxes the disagreement structure: it mandates evidence + assumptions but NOT
    // uncertainty, so the facet set is a strict subset of the full three.
    expectedMandatedFacets: ["evidence", "assumptions"],
    expectedGatingAllowed: false,
    expectedUncertaintyDisclosure: false,
    expectedDecisionRecommendation: false,
    expectedContradictionPolicies: ["synthesize-with-caveats"],
  },
};

export const NO_VOICE_FIXTURES: readonly DiscussionEvalFixture[] = [
  noVoiceChallenge,
  noVoiceDecide,
  noVoiceBrainstorm,
];
