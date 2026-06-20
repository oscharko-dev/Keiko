// Grounding-sensitive evaluation fixtures (Epic #1307, Issue #1315). Exercises the groundedness and
// faithfulness dimensions across the three grounding postures: required-from-supplied-context,
// required-from-external-research, and not-required (parametric). Pure value modules.

import type { PromptEnhancerEvalFixture } from "../types.js";

export const groundingSuppliedContext: PromptEnhancerEvalFixture = {
  name: "grounding-supplied-context",
  category: "grounding",
  description: "Answer strictly from connected/supplied context; grounding is required.",
  request: {
    text: "Using the attached files, explain which functions read from the database in this code.",
    hasConnectedContext: true,
    attachmentCount: 3,
  },
  dimensions: new Set(["groundedness", "faithfulness", "clarity"]),
  oracle: {
    expectedTaskClasses: [
      "rag-question-answering",
      "factual-qa",
      "code-debugging",
      "code-generation",
    ],
    expectedGroundingRequired: true,
  },
};

export const groundingExternalResearch: PromptEnhancerEvalFixture = {
  name: "grounding-external-research",
  category: "grounding",
  description: "A research request whose answer needs external evidence; grounding is required.",
  request: {
    text: "Provide a literature review and comprehensive overview of recent advances in retrieval-augmented generation.",
  },
  dimensions: new Set(["groundedness", "faithfulness", "clarity"]),
  oracle: {
    expectedTaskClasses: ["research"],
    expectedGroundingRequired: true,
    expectedGroundingStrategies: ["external-research-required", "hybrid", "local-knowledge"],
  },
};

export const groundingNotRequired: PromptEnhancerEvalFixture = {
  name: "grounding-not-required",
  category: "grounding",
  description: "A stable-knowledge question that needs no retrieval; grounding is not required.",
  request: { text: "Explain the difference between TCP and UDP at a high level." },
  dimensions: new Set(["groundedness", "faithfulness", "clarity"]),
  oracle: {
    // The strategy may still be a retrieval-capable one (e.g. hybrid) while `required` is false: the
    // planner permits a parametric answer under grounding discipline. The load-bearing assertion is
    // that grounding is not required for a stable-knowledge question.
    expectedTaskClasses: ["factual-qa"],
    expectedGroundingRequired: false,
  },
};

export const GROUNDING_FIXTURES: readonly PromptEnhancerEvalFixture[] = [
  groundingSuppliedContext,
  groundingExternalResearch,
  groundingNotRequired,
];
