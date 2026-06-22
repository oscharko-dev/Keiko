// Prompt Enhancer execution-profile catalog (Epic #1307, Issue #1310; governed by ADR-0044 §1/§3
// and the prompt-enhancer architecture blueprint §8).
//
// The wire-safe, provider-neutral profile *metadata* (governance posture, preferred output modes,
// grounding-mandatory flag) lives in `keiko-contracts` as `PROMPT_ENHANCEMENT_PROFILES`. That module
// deliberately excludes model-execution parameters: as its own comment records, token budget,
// temperature, and reasoning depth "are gateway concerns owned by #1310 and must not appear on a wire
// contract" (`packages/keiko-contracts/src/prompt-enhancer.ts`). This module owns exactly those
// gateway-side execution parameters, paralleling `QUALITY_INTELLIGENCE_TASK_PROFILES`
// (`../qualityIntelligence/taskProfiles.ts`).
//
// Determinism: pure value tables only. No IO, no clock, no randomness. Frozen at module load so the
// catalog cannot be mutated by callers. The id set is exhaustive at the type level, so adding a future
// profile is a compile error in the planner/generator rather than a silent fall-through.
//
// What lives here vs. #1312: these are the *generation* profiles that shape the deterministic
// structured prompt (reasoning strategy/depth, token budget, structural fan-out). The model-bound
// candidate/critic *dispatch* stage profiles (e.g. `pe:candidate`, `pe:critic`) and capability gating
// are #1312's concern when productive model calls are added; they are intentionally not modelled here.

import { PROMPT_ENHANCEMENT_PROFILE_IDS } from "@oscharko-dev/keiko-contracts";
import type { PromptEnhancementProfileId } from "@oscharko-dev/keiko-contracts";

// ─── Reasoning depth (ordered) ────────────────────────────────────────────────────
// An ordered scale of how much explicit step-by-step structure the generated prompt asks for. The
// order is meaningful (`minimal < standard < extended < exhaustive`) so the planner and tests can
// compare depths numerically; `reasoningDepthRank` exposes the comparison.
export type ReasoningDepth = "minimal" | "standard" | "extended" | "exhaustive";

export const REASONING_DEPTHS: readonly ReasoningDepth[] = [
  "minimal",
  "standard",
  "extended",
  "exhaustive",
] as const;

export function reasoningDepthRank(depth: ReasoningDepth): number {
  return REASONING_DEPTHS.indexOf(depth);
}

// ─── Reasoning strategy ───────────────────────────────────────────────────────────
// The closed set of structural strategies the generator uses to populate the task-decomposition
// section. Each strategy is a fixed, provider-neutral decomposition template; none names a model.
export type ReasoningStrategy =
  | "direct"
  | "decomposed"
  | "grounded-research"
  | "exploratory"
  | "structured-engineering"
  | "cautious-verification"
  | "plan-act-checkpoint";

export const REASONING_STRATEGIES: readonly ReasoningStrategy[] = [
  "direct",
  "decomposed",
  "grounded-research",
  "exploratory",
  "structured-engineering",
  "cautious-verification",
  "plan-act-checkpoint",
] as const;

// ─── Execution profile ─────────────────────────────────────────────────────────────
export interface PromptEnhancerExecutionProfile {
  readonly id: PromptEnhancementProfileId;
  // Structural strategy that selects the task-decomposition template (AC2: prompt structure).
  readonly reasoningStrategy: ReasoningStrategy;
  // How much explicit reasoning structure the prompt requests (AC2: reasoning depth).
  readonly reasoningDepth: ReasoningDepth;
  // Declared soft token budget for this profile (AC2: token budget). Monotonic across profiles: fast
  // is the smallest, research the largest. It is a forward-looking hint for downstream model dispatch
  // (#1312); the deterministic generator's actual rendered size is governed by the structural caps
  // below, so the two are kept consistent (a smaller budget pairs with smaller caps).
  readonly tokenBudget: number;
  // Upper bounds the generator applies when shaping list sections, so leaner profiles emit materially
  // smaller prompts while still populating every required section (AC1 + the token-budget test).
  readonly maxTaskDecompositionSteps: number;
  readonly maxQualityCriteria: number;
  readonly maxConstraints: number;
  // Whether the generator adds explicit citation/grounding-discipline rules regardless of the
  // detected grounding need (true for grounding-mandatory profiles).
  readonly emphasizeGrounding: boolean;
}

function freezeProfile(profile: PromptEnhancerExecutionProfile): PromptEnhancerExecutionProfile {
  return Object.freeze({ ...profile });
}

const PROFILES: Readonly<Record<PromptEnhancementProfileId, PromptEnhancerExecutionProfile>> =
  Object.freeze({
    fast: freezeProfile({
      id: "fast",
      reasoningStrategy: "direct",
      reasoningDepth: "minimal",
      tokenBudget: 512,
      maxTaskDecompositionSteps: 2,
      maxQualityCriteria: 2,
      maxConstraints: 3,
      emphasizeGrounding: false,
    }),
    creative: freezeProfile({
      id: "creative",
      reasoningStrategy: "exploratory",
      reasoningDepth: "standard",
      tokenBudget: 1024,
      maxTaskDecompositionSteps: 3,
      maxQualityCriteria: 3,
      maxConstraints: 3,
      emphasizeGrounding: false,
    }),
    technical: freezeProfile({
      id: "technical",
      reasoningStrategy: "structured-engineering",
      reasoningDepth: "extended",
      tokenBudget: 1536,
      maxTaskDecompositionSteps: 5,
      maxQualityCriteria: 4,
      maxConstraints: 5,
      emphasizeGrounding: false,
    }),
    precise: freezeProfile({
      id: "precise",
      reasoningStrategy: "decomposed",
      reasoningDepth: "standard",
      tokenBudget: 2048,
      maxTaskDecompositionSteps: 4,
      maxQualityCriteria: 4,
      maxConstraints: 4,
      emphasizeGrounding: false,
    }),
    agentic: freezeProfile({
      id: "agentic",
      reasoningStrategy: "plan-act-checkpoint",
      reasoningDepth: "extended",
      tokenBudget: 2560,
      maxTaskDecompositionSteps: 5,
      maxQualityCriteria: 4,
      maxConstraints: 6,
      emphasizeGrounding: false,
    }),
    "safety-critical": freezeProfile({
      id: "safety-critical",
      reasoningStrategy: "cautious-verification",
      reasoningDepth: "exhaustive",
      tokenBudget: 3072,
      maxTaskDecompositionSteps: 6,
      maxQualityCriteria: 5,
      maxConstraints: 6,
      emphasizeGrounding: true,
    }),
    research: freezeProfile({
      id: "research",
      reasoningStrategy: "grounded-research",
      reasoningDepth: "exhaustive",
      tokenBudget: 4096,
      maxTaskDecompositionSteps: 6,
      maxQualityCriteria: 5,
      maxConstraints: 5,
      emphasizeGrounding: true,
    }),
  });

export const PROMPT_ENHANCER_EXECUTION_PROFILES: Readonly<
  Record<PromptEnhancementProfileId, PromptEnhancerExecutionProfile>
> = PROFILES;

export function listPromptEnhancerExecutionProfiles(): readonly PromptEnhancerExecutionProfile[] {
  return PROMPT_ENHANCEMENT_PROFILE_IDS.map((id) => PROFILES[id]);
}

export function getPromptEnhancerExecutionProfile(
  id: PromptEnhancementProfileId,
): PromptEnhancerExecutionProfile {
  // Look up via the list (which yields `… | undefined`) so the runtime totality guard stays
  // meaningful for a bad cast at a JS call site, mirroring `getQualityIntelligenceTaskProfile`.
  const found = listPromptEnhancerExecutionProfiles().find((profile) => profile.id === id);
  if (found === undefined) {
    throw new Error("Unknown Prompt Enhancer execution profile id.");
  }
  return found;
}
