// Public barrel for the Prompt Enhancer sub-module of the model gateway
// (Epic #1307, Issues #1310/#1312; ADR-0044 §1). Exposes the generation-profile execution catalog, the
// deterministic planner, the structured generator, the provider-neutral renderers, and the
// deterministic candidate critic + bounded optimization loop (#1312). Mirrors the
// `qualityIntelligence/index.ts` barrel layout. A model-assisted candidate/critic dispatch stage is an
// explicit later option; the #1312 MVP is fully deterministic for reproducible CI coverage.

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

// ─── Candidate critic (#1312) ──────────────────────────────────────────────────
export type { PromptCandidateScoringContext } from "./critic.js";
export {
  PROMPT_CRITIC_DIMENSION_WEIGHTS,
  estimatePromptTokens,
  scorePromptCandidate,
} from "./critic.js";

// ─── Candidate generation (#1312) ──────────────────────────────────────────────
export type {
  GeneratePromptCandidatesArgs,
  PromptCandidate,
  PromptCandidateSet,
  RejectedCandidate,
} from "./candidates.js";
export { generatePromptCandidates } from "./candidates.js";

// ─── Bounded optimization (#1312) ──────────────────────────────────────────────
export type { OptimizePromptCandidatesArgs } from "./optimize.js";
export {
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOKEN_BUDGET,
  MAX_CANDIDATE_COUNT,
  optimizePromptCandidates,
  rankCandidates,
} from "./optimize.js";
