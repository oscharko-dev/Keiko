import type { ModelProviderConfig } from "./types.js";

const COMPLETION_TOKEN_PARAMETER_MODEL_RE = /^(?:gpt-5|o[134])(?:[.-]|$)/iu;

const NO_REASONING_WITH_TOOLS_MODEL_RE = /^gpt-5\.6(?:[.-]|$)/iu;

/**
 * Whether the model accepts function tools on Chat Completions only with `reasoning_effort: "none"`
 * (#3640, Microsoft's documented GPT-5.6 contract; omitting the field does not help). Every other
 * model, including the rest of the gpt-5 family, keeps the effort the turn selected.
 */
export function requiresNoReasoningWithTools(modelId: string): boolean {
  return NO_REASONING_WITH_TOOLS_MODEL_RE.test(modelId);
}

/** One provider-field projection shared by normal calls and raw readiness probes. */
export function providerOutputTokenLimit(
  maxOutputTokens: number | undefined,
  config: ModelProviderConfig,
): { readonly max_tokens?: number; readonly max_completion_tokens?: number } {
  if (maxOutputTokens === undefined) return {};
  const parameter =
    config.outputTokenParameter ??
    (COMPLETION_TOKEN_PARAMETER_MODEL_RE.test(config.modelId)
      ? "max_completion_tokens"
      : "max_tokens");
  return parameter === "max_completion_tokens"
    ? { max_completion_tokens: maxOutputTokens }
    : { max_tokens: maxOutputTokens };
}
