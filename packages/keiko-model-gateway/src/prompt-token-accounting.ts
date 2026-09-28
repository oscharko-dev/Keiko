import {
  countContextTokens,
  countContextTokensForSegments,
  type ContextTokenAccounting,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";

import type {
  ChatMessage,
  ChatMessageContentPart,
  ToolDefinition,
  ResponseFormat,
} from "./types.js";

export type { ModelTokenAccounting } from "./types.js";

export interface GatewayPromptTokenInput {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly responseFormat?: ResponseFormat | undefined;
}

type ProviderMessageContentParts = readonly (
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } }
)[];

export interface OpenAiCompatiblePromptMessage {
  readonly role: string;
  readonly content: string | ProviderMessageContentParts | null;
  readonly tool_call_id?: string | undefined;
  readonly tool_calls?:
    | readonly {
        readonly id: string;
        readonly type: "function";
        readonly function: { readonly name: string; readonly arguments: string };
      }[]
    | undefined;
}

function providerContentParts(
  parts: readonly ChatMessageContentPart[],
): ProviderMessageContentParts {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image_url" as const, image_url: { url: part.image_url.url } },
  );
}

function providerContent(
  message: ChatMessage,
  hasToolCalls: boolean,
): OpenAiCompatiblePromptMessage["content"] {
  if (message.role === "assistant" && hasToolCalls) return null;
  if (message.contentParts === undefined) return message.content;
  return providerContentParts(message.contentParts);
}

export function openAiCompatiblePromptMessage(message: ChatMessage): OpenAiCompatiblePromptMessage {
  const toolCalls = message.toolCalls?.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
  return {
    role: message.role,
    content: providerContent(message, hasToolCalls),
    ...(message.role === "tool" && message.toolCallId !== undefined
      ? { tool_call_id: message.toolCallId }
      : {}),
    ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
  };
}

export function openAiCompatiblePromptTools(
  tools: readonly ToolDefinition[],
): readonly Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// A deliberately conservative, model-independent fallback, not an exact vision tokenizer.
// Encoded bytes/URL length do not describe the patches/tiles a provider puts in its context.
// Keep this allowance separate from text calibration; a text probe cannot calibrate image cost.
const FALLBACK_IMAGE_TOKENS = 8_192;

function countMessageTokens(message: ChatMessage, accounting?: ContextTokenAccounting): number {
  const projected = openAiCompatiblePromptMessage(message);
  const parts =
    typeof projected.content === "string" || projected.content === null
      ? undefined
      : projected.content;
  const imageCount = parts?.filter((part) => part.type === "image_url").length ?? 0;
  const content =
    parts?.map((part) => (part.type === "text" ? part : { type: "image_url" })) ??
    projected.content;
  const text =
    parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? (typeof content === "string" ? content : "");
  // Preserve the dense-text floor when the JSON projection escapes literal newlines.
  return (
    Math.max(
      countContextTokens(text, accounting),
      countContextTokens(JSON.stringify({ ...projected, content }), accounting),
    ) +
    imageCount * FALLBACK_IMAGE_TOKENS
  );
}

/** The LiteLLM counter receives messages/tools, but not the generation response schema. */
export function countGatewayResponseFormatTokens(
  input: GatewayPromptTokenInput,
  accounting?: ContextTokenAccounting,
): number {
  return input.responseFormat?.type === "json_schema"
    ? countContextTokens(JSON.stringify(input.responseFormat), accounting)
    : 0;
}

/** Counts the complete provider projection; image bytes are never treated as text tokens. */
export function countGatewayPromptTokens(
  input: GatewayPromptTokenInput,
  accounting?: ContextTokenAccounting,
): number {
  const messageTokens = input.messages.reduce(
    (sum, message) => sum + countMessageTokens(message, accounting),
    0,
  );
  const segments =
    input.tools !== undefined && input.tools.length > 0
      ? [JSON.stringify(openAiCompatiblePromptTools(input.tools))]
      : [];
  return (
    messageTokens +
    countContextTokensForSegments(segments, accounting) +
    countGatewayResponseFormatTokens(input, accounting)
  );
}
