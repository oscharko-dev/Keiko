// Compatibility barrel for the Prompt Enhancer workflow authority.
//
// The lifecycle lives in `@oscharko-dev/keiko-workflows/promptEnhancer` per ADR-0044; server callers
// keep importing from this path so existing route and public server exports stay stable.

export {
  PromptEnhancementCancelledError,
  PromptEnhancementInputError,
  buildPromptEnhancementRecordInput,
  promptEnhancementGatewayRoutingConfig,
  runPromptEnhancement,
  type PromptEnhancementGatewayRoutingConfig,
  type RunPromptEnhancementDeps,
} from "@oscharko-dev/keiko-workflows";
