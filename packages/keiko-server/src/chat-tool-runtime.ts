import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import type { ChatToolTurnPort } from "./chat-tool-turn.js";
import { createJiraChatToolTurn } from "./atlassian/jiraChatToolTurn.js";
import { createMcpChatToolTurn } from "./mcp/mcpChatToolTurn.js";
export type { ChatToolTurnPort } from "./chat-tool-turn.js";

/** Both normal and grounded Chat enter the same bounded orchestration before model work. */
export async function createChatToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<ChatToolTurnPort | undefined> {
  if (deps.store.findChatById(message.chatId)?.jiraPodBinding !== undefined)
    return createJiraChatToolTurn(deps, modelId, message, signal, correlationId);
  return createMcpChatToolTurn(deps, modelId, message, signal, correlationId);
}
export function scopeChatToolTurn(
  deps: UiHandlerDeps,
  turn: ChatToolTurnPort | undefined,
): UiHandlerDeps {
  if (turn === undefined) return deps;
  return {
    ...deps,
    chatToolTurn: turn,
    modelPortFactory: (id): ReturnType<UiHandlerDeps["modelPortFactory"]> => {
      const model = deps.modelPortFactory(id);
      return model === undefined ? undefined : turn.meter(model);
    },
  };
}
