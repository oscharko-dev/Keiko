// Public barrel for the Prompt Enhancer sub-module of the model gateway
// (Epic #1307, Issue #1310; ADR-0044 §1). Exposes the generation-profile execution catalog, the
// deterministic planner, the structured generator, and the provider-neutral renderers. Mirrors the
// `qualityIntelligence/index.ts` barrel layout. Model-bound candidate/critic dispatch is #1312.

// ─── Execution-profile catalog ───────────────────────────────────────────────
export type {
  PromptEnhancerExecutionProfile,
  ReasoningDepth,
  ReasoningStrategy,
} from "./profiles.js";
export {
  PROMPT_ENHANCER_EXECUTION_PROFILES,
  REASONING_DEPTHS,
  REASONING_STRATEGIES,
  getPromptEnhancerExecutionProfile,
  listPromptEnhancerExecutionProfiles,
  reasoningDepthRank,
} from "./profiles.js";

// ─── Planner ─────────────────────────────────────────────────────────────────
export type {
  PlanPromptEnhancementOptions,
  ProfileSelectionSource,
  PromptEnhancementPlan,
  PromptSafetyPosture,
} from "./planner.js";
export { planPromptEnhancement } from "./planner.js";

// ─── Generator ───────────────────────────────────────────────────────────────
export type { GenerateEnhancedPromptArgs } from "./generator.js";
export { GENERATED_INPUT_MAX_CHARS, generateEnhancedPrompt } from "./generator.js";

// ─── Rendering ───────────────────────────────────────────────────────────────
export { renderEnhancedPromptMessages, renderEnhancedPromptText } from "./rendering.js";
