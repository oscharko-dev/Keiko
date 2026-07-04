// Token-efficiency fixtures (Epic #1307, Issue #1315). Exercises the token-efficiency dimension at both
// ends of the breadth/cost trade-off: a lean draft routed to the `fast` profile must stay well under a
// tight ceiling, while a thorough draft routed to the `research` profile must still respect its larger
// token budget. Both prove the generator honours the profile's token budget.
//
// Ceiling calibration (GEN-DUP-SEMANTIC-002, Step 10): the enhancer's `estimatePromptTokens` now
// delegates to the canonical `estimateTokens` currency (keiko-contracts, UTF-8-byte based with a
// per-segment overhead + dense-text floor) instead of the former private `chars / 4` heuristic. The
// rendered prompts are unchanged; only the counting is more conservative (~10-14% higher for these
// English drafts). The `maxEstimatedTokens` ceilings below were re-scaled from 650/1200 to 800/1400 to
// keep the same real-prompt bound under the new estimator while preserving headroom that still fails a
// genuinely bloated prompt (current estimates: lean 717, thorough 1285).

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
    maxEstimatedTokens: 800,
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
    maxEstimatedTokens: 1400,
  },
};

export const TOKEN_EFFICIENCY_FIXTURES: readonly PromptEnhancerEvalFixture[] = [
  tokenEfficiencyLean,
  tokenEfficiencyThorough,
];
