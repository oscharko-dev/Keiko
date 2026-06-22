// Token-efficiency fixtures (Epic #1307, Issue #1315). Exercises the token-efficiency dimension at both
// ends of the breadth/cost trade-off: a lean draft routed to the `fast` profile must stay well under a
// tight ceiling, while a thorough draft routed to the `research` profile must still respect its larger
// token budget. Both prove the generator honours the profile's token budget.

import type { PromptEnhancerEvalFixture } from "../types.js";

export const tokenEfficiencyLean: PromptEnhancerEvalFixture = {
  name: "token-efficiency-lean",
  category: "token-efficiency",
  description: "A lean editing draft routed to the fast profile; instructions stay compact.",
  request: { text: "Proofread and tighten this one-sentence status update." },
  dimensions: new Set(["token-efficiency", "clarity"]),
  oracle: {
    expectedTaskClasses: ["writing-editing"],
    expectedProfiles: ["fast"],
    // The fast profile keeps the full rendered prompt compact and scores high instruction-leanness.
    maxEstimatedTokens: 650,
    minTokenEfficiencyScore: 0.4,
  },
};

export const tokenEfficiencyThorough: PromptEnhancerEvalFixture = {
  name: "token-efficiency-thorough",
  category: "token-efficiency",
  description: "A thorough research draft routed to the research profile; stays within its budget.",
  request: {
    text: "Deep research: produce a comprehensive overview and survey of distributed consensus algorithms.",
  },
  dimensions: new Set(["token-efficiency", "clarity"]),
  oracle: {
    // The research profile is the most thorough; the full rendered prompt is larger but still bounded.
    expectedTaskClasses: ["research"],
    expectedProfiles: ["research"],
    maxEstimatedTokens: 1200,
  },
};

export const TOKEN_EFFICIENCY_FIXTURES: readonly PromptEnhancerEvalFixture[] = [
  tokenEfficiencyLean,
  tokenEfficiencyThorough,
];
