// Public barrel for the Prompt Enhancer server sub-module (Epic #1307, Issue #1314; ADR-0044 §1).
// Exposes the BFF route handler and the reusable, deterministic orchestration the CLI surface also
// drives (so both surfaces produce byte-identical enhancements — AC1).

export { handlePromptEnhancement, handlePromptEnhancementEvidence } from "./routes.js";
export {
  PromptEnhancementCancelledError,
  PromptEnhancementInputError,
  buildPromptEnhancementRecordInput,
  runPromptEnhancement,
  type RunPromptEnhancementDeps,
} from "./orchestrate.js";
