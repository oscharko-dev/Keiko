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

/** The two provider fields that carry an output-token bound. */
export type OutputTokenField = "max_tokens" | "max_completion_tokens";

export const OTHER_OUTPUT_TOKEN_FIELD: Readonly<Record<OutputTokenField, OutputTokenField>> = {
  max_tokens: "max_completion_tokens",
  max_completion_tokens: "max_tokens",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a provider rejection names the output-token field a request sent AND says that field is
 * unsupported: Azure answers a GPT-5 deployment's max_tokens with param "max_tokens" and code
 * "unsupported_parameter"; an older model names max_completion_tokens as an unrecognized argument.
 * A rejected value of a supported field ("invalid_value", "integer above maximum") is no reason to
 * switch fields (#3639, PR #3625 review). One rule for the chat adapter and the readiness probe.
 */
export function rejectsOutputTokenField(payload: unknown, field: OutputTokenField): boolean {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
  if (!isRecord(error)) return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const namesField = error.param === field || message.includes(field);
  return namesField && /unsupported|not supported|unrecognized|unknown/.test(`${code} ${message}`);
}
