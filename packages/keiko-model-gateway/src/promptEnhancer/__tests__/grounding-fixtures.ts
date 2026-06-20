// Grounding-plan fixtures for the Prompt Enhancer (Issue #1311 deliverable 3).
//
// Natural prompts whose deterministic analysis (#1309) drives a specific grounding strategy, covering
// the six plan types named in the Expected Verification (no-grounding, supplied-context-only,
// local-knowledge, repository-context, hybrid, external-research-required) plus the deliverable
// categories: factual/current prompts, RAG prompts, enterprise-data prompts, and an
// unsupported-evidence case. Each fixture exercises the real analyze -> plan -> generate path.
//
// This file lives under `__tests__/` so it is excluded from coverage instrumentation; it is test data.

import {
  asPromptEnhancementRequestId,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type GroundingStrategy,
  type PromptEnhancementRequest,
} from "@oscharko-dev/keiko-contracts";

export interface GroundingFixture {
  readonly name: string;
  readonly category:
    | "factual"
    | "current"
    | "rag"
    | "enterprise"
    | "code"
    | "self-contained"
    | "unsupported-evidence";
  readonly expectedStrategy: GroundingStrategy;
  readonly expectsRagHints: boolean;
  readonly expectedRequired: boolean;
  readonly request: PromptEnhancementRequest;
}

function makeRequest(
  id: string,
  text: string,
  hasConnectedContext?: boolean,
): PromptEnhancementRequest {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: asPromptEnhancementRequestId(id),
    input: { text, hasConnectedContext },
    missingInformationStrategy: "clarify",
  };
}

export const GROUNDING_FIXTURES: readonly GroundingFixture[] = [
  {
    name: "self-contained: code generation needs no grounding",
    category: "self-contained",
    expectedStrategy: "no-grounding",
    expectsRagHints: false,
    expectedRequired: false,
    request: makeRequest("grd-none", "Write a function to reverse a singly linked list."),
  },
  {
    name: "rag: answer strictly from the provided text",
    category: "rag",
    expectedStrategy: "supplied-context-only",
    expectsRagHints: true,
    expectedRequired: true,
    request: makeRequest(
      "grd-supplied",
      "Based on the provided text, answer which mitigations the report recommends.",
    ),
  },
  {
    name: "enterprise: look up an answer in the connected document store",
    category: "enterprise",
    expectedStrategy: "local-knowledge",
    expectsRagHints: true,
    expectedRequired: true,
    request: makeRequest(
      "grd-local",
      "Using the document knowledge base, look up our onboarding steps and list them.",
    ),
  },
  {
    name: "code: debug a failure against the repository context",
    category: "code",
    expectedStrategy: "repository-context",
    expectsRagHints: false,
    expectedRequired: true,
    request: makeRequest(
      "grd-repo",
      "Debug why this function returns the wrong result when the input array is empty.",
    ),
  },
  {
    name: "factual research: comprehensive overview with citations (hybrid)",
    category: "factual",
    expectedStrategy: "hybrid",
    expectsRagHints: true,
    expectedRequired: true,
    request: makeRequest(
      "grd-hybrid",
      "Provide a comprehensive overview of advances in solid-state battery technology, with citations.",
    ),
  },
  {
    name: "current: recency-sensitive question requires external research",
    category: "current",
    expectedStrategy: "external-research-required",
    expectsRagHints: false,
    expectedRequired: true,
    request: makeRequest(
      "grd-current",
      "What are the latest developments in the EU AI Act as of today?",
    ),
  },
  {
    name: "unsupported-evidence: RAG question whose answer may be absent from context",
    category: "unsupported-evidence",
    expectedStrategy: "supplied-context-only",
    expectsRagHints: true,
    expectedRequired: true,
    request: makeRequest(
      "grd-unsupported",
      "Based on the provided text, what was the company's exact revenue in 1850?",
    ),
  },
];
