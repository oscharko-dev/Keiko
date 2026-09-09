import { countContextTokensForSegments } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";

import type {
  ChatMessage,
  ChatMessageContentPart,
  ModelTokenAccounting,
  ToolDefinition,
} from "./types.js";

export type { ModelTokenAccounting } from "./types.js";

export interface GatewayPromptTokenInput {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
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

/** Counts the complete text-bearing provider request projection with the selected model's token
 * calibration. Tool-call arguments and ids are context just like visible message content. */
export function countGatewayPromptTokens(
  input: GatewayPromptTokenInput,
  accounting?: ModelTokenAccounting,
): number {
  const segments = input.messages.map((message) =>
    JSON.stringify(openAiCompatiblePromptMessage(message)),
  );
  if (input.tools !== undefined) {
    segments.push(JSON.stringify(openAiCompatiblePromptTools(input.tools)));
  }
  return countContextTokensForSegments(segments, accounting);
}
