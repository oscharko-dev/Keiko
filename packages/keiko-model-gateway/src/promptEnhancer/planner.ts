// Prompt Enhancer planner (Epic #1307, Issue #1310; ADR-0044 §1/§3/§4).
//
// Maps the deterministic analyzer output (`PromptTaskAnalysis`, produced by #1309 in keiko-contracts)
// to a concrete generation plan: the selected generation profile, the reasoning strategy and depth,
// the token budget, the output schema, and the grounding/safety posture. This is the "planner" half
// of Issue #1310; the "generator" half (`generator.ts`) consumes the plan.
//
// Determinism: pure. Identical (analysis, options) always yields an identical plan. No IO, clock, or
// randomness. The enhancer never self-authorizes (ADR-0044 §4): the plan only records whether the
// generated prompt must carry explicit human-approval safety rules; it never grants authority itself.

import {
  PROMPT_ENHANCEMENT_PROFILES,
  type GroundingNeed,
  type MissingInformationStrategy,
  type OutputSchemaDescriptor,
  type PromptCriticality,
  type PromptEnhancementProfileId,
  type PromptEnhancementRequestId,
  type PromptTaskAnalysis,
} from "@oscharko-dev/keiko-contracts";
import {
  getPromptEnhancerExecutionProfile,
  type PromptEnhancerExecutionProfile,
  type ReasoningDepth,
  type ReasoningStrategy,
} from "./profiles.js";

// How the planner arrived at the selected profile. `criticality-escalated` always wins over a caller
// preference so a high-stakes task cannot be downgraded out of the safety-critical posture by a hint
// (ADR-0044 §5 security-first). `preference-honored` reflects an explicit, non-overriding caller hint.
// `recommended` falls back to the analyzer's deterministic recommendation.
export type ProfileSelectionSource = "criticality-escalated" | "preference-honored" | "recommended";

// Machine-readable safety posture the generator turns into explicit, descriptive safety rules. None of
// these flags grants authority; they only require the generated prompt to *withhold* it more loudly.
export interface PromptSafetyPosture {
  // The task is high-stakes (safety-critical profile or critical criticality): the prompt must carry a
  // professional-advice disclaimer and avoid definitive determinations.
  readonly safetyCritical: boolean;
  // A human must review risky prompt authority. Runtime side effects then follow the confirmed mode,
  // Authority Envelope, and per-action policy; the prompt must never self-authorize or widen them.
  readonly requiresHumanApproval: boolean;
  // Invariant (ADR-0044 §4): an Enhanced Prompt is data, never a capability grant. Always true; the
  // generator always emits the no-authority safety rule. Surfaced so callers and tests can assert it.
  readonly restrictsAuthority: true;
}

export interface PromptEnhancementPlan {
  readonly requestId: PromptEnhancementRequestId;
  readonly selectedProfile: PromptEnhancementProfileId;
  readonly profileSource: ProfileSelectionSource;
  readonly reasoningStrategy: ReasoningStrategy;
  readonly reasoningDepth: ReasoningDepth;
  readonly tokenBudget: number;
  readonly executionProfile: PromptEnhancerExecutionProfile;
  readonly outputSchema: OutputSchemaDescriptor;
  readonly groundingNeed: GroundingNeed;
  // Whether a grounded retrieval plan is mandatory for this profile (#1311 binds it). Sourced from the
  // wire-contract profile metadata, not re-derived here.
  readonly groundingMandatory: boolean;
  readonly missingInformationStrategy: MissingInformationStrategy;
  // Upper bound on clarification questions the generator surfaces, from the profile metadata.
  readonly maxClarifications: number;
  readonly safetyPosture: PromptSafetyPosture;
}

export interface PlanPromptEnhancementOptions {
  // Optional caller hint. Honored unless the task is criticality-escalated (see `ProfileSelectionSource`).
  readonly profilePreference?: PromptEnhancementProfileId | undefined;
  // How missing information is represented downstream. Defaults to "clarify" when omitted; the analyzer
  // has already shaped `analysis.missingContext` accordingly when the originating request set it.
  readonly missingInformationStrategy?: MissingInformationStrategy | undefined;
}

function selectProfile(
  criticality: PromptCriticality,
  recommendedProfile: PromptEnhancementProfileId,
  profilePreference: PromptEnhancementProfileId | undefined,
): { readonly profile: PromptEnhancementProfileId; readonly source: ProfileSelectionSource } {
  if (criticality === "critical") {
    return { profile: "safety-critical", source: "criticality-escalated" };
  }
  if (profilePreference !== undefined) {
    return { profile: profilePreference, source: "preference-honored" };
  }
  return { profile: recommendedProfile, source: "recommended" };
}

function deriveSafetyPosture(
  selectedProfile: PromptEnhancementProfileId,
  analysis: PromptTaskAnalysis,
): PromptSafetyPosture {
  const safetyCritical =
    selectedProfile === "safety-critical" || analysis.criticality === "critical";
  const requiresHumanApproval =
    selectedProfile === "agentic" ||
    analysis.riskFlags.includes("tool-authority-requested") ||
    analysis.riskFlags.includes("egress-requested");
  return { safetyCritical, requiresHumanApproval, restrictsAuthority: true };
}

/**
 * Build a deterministic `PromptEnhancementPlan` from a `PromptTaskAnalysis`. Pure.
 *
 * Profile precedence: a critical-criticality task is always escalated to the `safety-critical`
 * profile (a caller preference cannot downgrade it); otherwise an explicit `profilePreference` is
 * honored; otherwise the analyzer's `recommendedProfile` is used.
 */
export function planPromptEnhancement(
  analysis: PromptTaskAnalysis,
  options: PlanPromptEnhancementOptions = {},
): PromptEnhancementPlan {
  const { profile: selectedProfile, source: profileSource } = selectProfile(
    analysis.criticality,
    analysis.recommendedProfile,
    options.profilePreference,
  );
  const executionProfile = getPromptEnhancerExecutionProfile(selectedProfile);
  const metadata = PROMPT_ENHANCEMENT_PROFILES[selectedProfile];
  return {
    requestId: analysis.requestId,
    selectedProfile,
    profileSource,
    reasoningStrategy: executionProfile.reasoningStrategy,
    reasoningDepth: executionProfile.reasoningDepth,
    tokenBudget: executionProfile.tokenBudget,
    executionProfile,
    outputSchema: analysis.outputSchema,
    groundingNeed: analysis.groundingNeed,
    groundingMandatory: metadata.groundingMandatory,
    missingInformationStrategy: options.missingInformationStrategy ?? "clarify",
    maxClarifications: metadata.maxClarifications,
    safetyPosture: deriveSafetyPosture(selectedProfile, analysis),
  };
}
