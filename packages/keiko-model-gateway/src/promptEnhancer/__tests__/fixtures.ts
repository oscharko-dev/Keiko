// Profile-specific fixtures for the Prompt Enhancer planner/generator (Issue #1310 deliverable 3).
//
// One representative request per generation profile (fast, precise, research, creative, technical,
// safety-critical, agentic). Each request is a natural prompt whose deterministic analyzer
// classification selects the named profile, so the fixtures exercise the real analyze → plan → generate
// path rather than forcing a profile. `expectedProfile` is asserted by `fixtures.test.ts`.
//
// This file lives under `__tests__/` so it is excluded from coverage instrumentation; it is test data,
// not production code.

import {
  asPromptEnhancementRequestId,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type MissingInformationStrategy,
  type PromptEnhancementProfileId,
  type PromptEnhancementRequest,
} from "@oscharko-dev/keiko-contracts";

export interface ProfileFixture {
  readonly name: string;
  readonly expectedProfile: PromptEnhancementProfileId;
  readonly request: PromptEnhancementRequest;
}

function makeRequest(
  id: string,
  text: string,
  options: {
    readonly missingInformationStrategy?: MissingInformationStrategy;
    readonly hasConnectedContext?: boolean;
  } = {},
): PromptEnhancementRequest {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: asPromptEnhancementRequestId(id),
    input: {
      text,
      hasConnectedContext: options.hasConnectedContext,
    },
    missingInformationStrategy: options.missingInformationStrategy ?? "clarify",
  };
}

export const PROFILE_FIXTURES: readonly ProfileFixture[] = [
  {
    name: "fast: light editing",
    expectedProfile: "fast",
    request: makeRequest("fixture-fast", "Proofread this paragraph and fix any grammar mistakes."),
  },
  {
    name: "precise: factual question",
    expectedProfile: "precise",
    request: makeRequest(
      "fixture-precise",
      "What is the capital of Australia and roughly when did it become the capital?",
    ),
  },
  {
    name: "research: grounded overview",
    expectedProfile: "research",
    request: makeRequest(
      "fixture-research",
      "Provide a comprehensive overview of advances in solid-state battery technology, with citations.",
    ),
  },
  {
    name: "creative: short story",
    expectedProfile: "creative",
    request: makeRequest(
      "fixture-creative",
      "Write a short story about a lighthouse keeper who befriends a whale.",
    ),
  },
  {
    name: "technical: code generation",
    expectedProfile: "technical",
    request: makeRequest(
      "fixture-technical",
      "Write a function in TypeScript that merges two sorted arrays into one sorted array. Return JSON describing the result.",
    ),
  },
  {
    name: "safety-critical: medical advice",
    expectedProfile: "safety-critical",
    request: makeRequest(
      "fixture-safety-critical",
      "I have a headache and a fever. What medication should I take and what dose is safe?",
    ),
  },
  {
    name: "agentic: tool automation",
    expectedProfile: "agentic",
    request: makeRequest(
      "fixture-agentic",
      "As an agent, automate my onboarding workflow: call the API to create accounts and take actions on my behalf.",
    ),
  },
];
