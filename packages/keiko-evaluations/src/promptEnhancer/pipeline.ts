// Prompt Enhancer evaluation pipeline (Epic #1307, Issue #1315; ADR-0044 §1/§5/§6).
//
// Runs the full deterministic enhancement chain for one fixture and collects every artefact the scorer
// needs: the analyzer result, the plan, the generated Enhanced Prompt, the deterministic critic
// scorecard, the structural safety assessment, the raw-draft injection signals, and the token estimate.
//
// Determinism: pure. The whole chain — analyze, plan, generate, critic-score, safety-assess, injection-
// detect — is deterministic and never dispatches a model, so identical fixtures always yield identical
// observations and the evaluation provides reproducible CI coverage (Engineering Notes).

import {
  analyzePrompt,
  asEnhancedPromptId,
  asPromptEnhancementRequestId,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type PromptEnhancementRequest,
} from "@oscharko-dev/keiko-contracts";
import { PromptEnhancer } from "@oscharko-dev/keiko-model-gateway";
import { detectPromptInjectionSignals } from "@oscharko-dev/keiko-security";
import type { EnhancementObservation, PromptEnhancerFixtureRequest } from "./types.js";

// Builds a wire-valid `PromptEnhancementRequest` from a fixture's safe request subset. The ids are
// derived from the fixture name (kebab-case, so they pass the id validators) to keep runs deterministic.
function buildRequest(name: string, req: PromptEnhancerFixtureRequest): PromptEnhancementRequest {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: asPromptEnhancementRequestId(`req-pe-eval-${name}`),
    input: {
      text: req.text,
      hasConnectedContext: req.hasConnectedContext,
      attachmentCount: req.attachmentCount,
    },
    missingInformationStrategy: req.missingInformationStrategy ?? "clarify",
    profilePreference: req.profilePreference,
    locale: req.locale,
  };
}

/**
 * Run the deterministic Prompt Enhancer pipeline for one fixture and return all observable artefacts.
 * Pure: no IO, clock, randomness, or model dispatch.
 */
export function runEnhancement(
  name: string,
  req: PromptEnhancerFixtureRequest,
): EnhancementObservation {
  const request = buildRequest(name, req);
  const analysis = analyzePrompt(request);
  const plan = PromptEnhancer.planPromptEnhancement(analysis, {
    profilePreference: req.profilePreference,
    missingInformationStrategy: request.missingInformationStrategy,
  });
  const prompt = PromptEnhancer.generateEnhancedPrompt({
    promptId: asEnhancedPromptId(`prompt-pe-eval-${name}`),
    analysis,
    plan,
    input: request.input,
  });
  const critic = PromptEnhancer.scorePromptCandidate({
    candidateId: `cand-pe-eval-${name}`,
    profile: plan.selectedProfile,
    prompt,
    plan,
    analysis,
  });
  const safety = PromptEnhancer.assessPromptSafety({ prompt, analysis, input: request.input });
  return {
    analysis,
    plan,
    prompt,
    critic,
    safety,
    injectionSignals: detectPromptInjectionSignals(req.text),
    estimatedTokens: PromptEnhancer.estimatePromptTokens(prompt),
  };
}
