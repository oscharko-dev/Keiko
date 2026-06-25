// Voice-enabled discussion fixtures (Epic #491, Issue #502; AC2/AC4/AC6). These exercise the SAME
// discussion scaffold under voice-capable profiles (`speech-to-text`, `full-realtime`), proving voice
// reuses the intelligence (no parallel stack) and that an interrupted spoken turn recovers without
// losing the active mode/topicId/turnIndex. Pure value modules.

import type { DiscussionEvalFixture } from "../types.js";

export const voiceSttReview: DiscussionEvalFixture = {
  name: "voice-stt-review",
  category: "voice",
  description:
    "Review mode under a speech-to-text profile; voice may drive the same intelligence (no parallel stack).",
  profile: "speech-to-text",
  mode: "review",
  topicId: "topic-review-stt",
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

export const voiceRealtimeBargeInRecovery: DiscussionEvalFixture = {
  name: "voice-realtime-barge-in-recovery",
  category: "voice",
  description:
    "Decide mode under full-realtime voice with a barge-in interruption; recovery must preserve context (AC4).",
  profile: "full-realtime",
  mode: "decide",
  topicId: "topic-decide-realtime",
  interruption: true,
  dimensions: new Set([
    "mode-appropriateness",
    "disagreement-completeness",
    "uncertainty-discipline",
    "evidence-citation-discipline",
    "correction-handling",
    "interruption-recovery",
    "capability-gating",
  ]),
  oracle: {
    expectedMandatedFacets: ["evidence", "assumptions", "uncertainty"],
    expectedGatingAllowed: true,
    expectedUncertaintyDisclosure: true,
    expectedDecisionRecommendation: true,
    expectedContradictionPolicies: ["disclose-and-defer"],
    expectsRecoveredContext: true,
  },
};

export const VOICE_FIXTURES: readonly DiscussionEvalFixture[] = [
  voiceSttReview,
  voiceRealtimeBargeInRecovery,
];
