import type { ModelProviderConfig } from "./types.js";

const COMPLETION_TOKEN_PARAMETER_MODEL_RE = /^(?:gpt-5|o[134])(?:[.-]|$)/iu;

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
