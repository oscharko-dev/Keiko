import { createHash } from "node:crypto";
import { countGatewayPromptTokens } from "../../../packages/keiko-model-gateway/dist/prompt-token-accounting.js";
import { groundedSynthesisAttemptUsage } from "../../../packages/keiko-server/dist/grounded-answer.js";

const MESSAGE_KEYS = new Set(["role", "content"]);

function isTextMessage(message, role) {
  return (
    message !== null &&
    typeof message === "object" &&
    message.role === role &&
    typeof message.content === "string" &&
    Object.keys(message).every((key) => MESSAGE_KEYS.has(key))
  );
}

function outputLimits(wire) {
  return {
    outputTokensMax: wire.max_completion_tokens ?? wire.max_tokens ?? null,
    outputCapFields:
      Number(wire.max_completion_tokens !== undefined) + Number(wire.max_tokens !== undefined),
  };
}

// This fixture uses the uncalibrated, text-only profile in keiko.e2e.config.json.
// Refuse richer wire shapes: the gateway counter expects internal tool/message contracts.
export function groundingAccountingWitness(raw, usage) {
  const wire = JSON.parse(raw);
  const messages = wire.messages;
  const supportedTextOnly =
    Array.isArray(messages) &&
    messages.length === 2 &&
    isTextMessage(messages[0], "system") &&
    isTextMessage(messages[1], "user") &&
    wire.tools === undefined &&
    wire.response_format === undefined;
  const canonicalPromptTokens = supportedTextOnly ? countGatewayPromptTokens({ messages }) : null;
  return {
    requestSha256: createHash("sha256").update(raw).digest("hex"),
    requestModelSha256:
      typeof wire.model === "string" ? createHash("sha256").update(wire.model).digest("hex") : null,
    ...outputLimits(wire),
    supportedTextOnly,
    canonicalPromptTokens,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    accountedPromptTokens:
      canonicalPromptTokens === null
        ? null
        : groundedSynthesisAttemptUsage(canonicalPromptTokens, {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
          }).promptTokens,
  };
}
