import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import type { ChatToolTurnPort } from "./chat-tool-turn.js";
import { createJiraChatToolTurn } from "./atlassian/jiraChatToolTurn.js";
import { createMcpChatToolTurn } from "./mcp/mcpChatToolTurn.js";
import { createChatSourcesToolTurn } from "./chat-tool-sources-turn.js";
import { correlationIdOrUnknown } from "./correlation.js";
export type { ChatToolTurnPort } from "./chat-tool-turn.js";

/** Both normal and grounded Chat enter the same bounded orchestration before model work. */
export async function createChatToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<ChatToolTurnPort | undefined> {
  if (deps.store.findChatById(message.chatId)?.jiraPodBinding === undefined)
    return createMcpChatToolTurn(deps, modelId, message, signal, correlationId);
  const mcp = await deps.mcpChatCatalog?.get(correlationIdOrUnknown(correlationId));
  return mcp === undefined
    ? createJiraChatToolTurn(deps, modelId, message, signal, correlationId)
    : createChatSourcesToolTurn(deps, modelId, message, signal, correlationId, mcp);
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

/**
 * The cancellation signal for work that follows an accepted tool turn (#4175). A human stop or an
 * authority revocation cancels at once. The turn's deadline cancels too, except when the turn
 * already settled an exchange: it then answers from its transcript, and that deterministic answer
 * must reach the human instead of a cancellation. The deadline still bounds every provider dispatch
 * through the turn's own signal and the synthesis grants.
 */
export function chatToolTurnCancellationSignal(
  signal: AbortSignal,
  turn: Pick<ChatToolTurnPort, "signal" | "deadlineAtMs" | "answersAtDeadline">,
): AbortSignal {
  const controller = new AbortController();
  const cancel = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onTurnAbort = (): void => {
    const deadlineOnly = !signal.aborted && Date.now() >= turn.deadlineAtMs;
    if (!deadlineOnly || !turn.answersAtDeadline) cancel(turn.signal.reason);
  };
  const deadline = AbortSignal.timeout(Math.max(0, turn.deadlineAtMs - Date.now()));
  signal.addEventListener(
    "abort",
    () => {
      cancel(signal.reason);
    },
    { once: true },
  );
  turn.signal.addEventListener("abort", onTurnAbort, { once: true });
  deadline.addEventListener("abort", onTurnAbort, { once: true });
  if (signal.aborted) cancel(signal.reason);
  else if (turn.signal.aborted) onTurnAbort();
  return controller.signal;
}
