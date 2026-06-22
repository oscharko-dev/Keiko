// Shared test helpers for the Prompt Enhancer module tests. Excluded from coverage by the vitest
// config (`**/_support.ts`); not a test file.

import {
  asEnhancedPromptId,
  asPromptEnhancementRequestId,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type ClarificationOrAssumption,
  type EnhancedPromptId,
  type GroundingNeed,
  type OutputSchemaDescriptor,
  type PromptCriticality,
  type PromptDomain,
  type PromptEnhancementProfileId,
  type PromptRiskClass,
  type PromptTaskAnalysis,
  type PromptTaskClass,
} from "@oscharko-dev/keiko-contracts";

export interface AnalysisOverrides {
  readonly taskClass?: PromptTaskClass;
  readonly domain?: PromptDomain;
  readonly criticality?: PromptCriticality;
  readonly groundingNeed?: GroundingNeed;
  readonly outputSchema?: OutputSchemaDescriptor;
  readonly missingContext?: readonly ClarificationOrAssumption[];
  readonly riskFlags?: readonly PromptRiskClass[];
  readonly recommendedProfile?: PromptEnhancementProfileId;
  readonly requestId?: string;
}

const BASE_ANALYSIS: Omit<PromptTaskAnalysis, "requestId"> = {
  schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
  taskClass: "factual-qa",
  taskClassConfidence: "moderate",
  domain: "general",
  criticality: "standard",
  groundingNeed: { kind: "none", volatile: false, signals: [] },
  outputSchema: { format: "unspecified", structured: false, hints: [] },
  missingContext: [],
  riskFlags: [],
  recommendedProfile: "precise",
  normalizedInputLength: 16,
  signals: [],
};

export function makeAnalysis(overrides: AnalysisOverrides = {}): PromptTaskAnalysis {
  const { requestId, ...rest } = overrides;
  return {
    ...BASE_ANALYSIS,
    ...rest,
    requestId: asPromptEnhancementRequestId(requestId ?? "test-request"),
  };
}

export function testPromptId(value = "test-prompt"): EnhancedPromptId {
  return asEnhancedPromptId(value);
}
