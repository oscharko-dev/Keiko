import { chatKnowledgeScopes } from "./requirement-inventory.js";
import { createKnowledgeChatToolTurn } from "./knowledge-chat-turn.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import type { ChatToolTurnPort } from "./chat-tool-turn.js";
import { createJiraChatToolTurn } from "./atlassian/jiraChatToolTurn.js";
import { createMcpChatToolTurn } from "./mcp/mcpChatToolTurn.js";
import { createChatSourcesToolTurn } from "./chat-tool-sources-turn.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { openTraceSession } from "./requirement-trace.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
export type { ChatToolTurnPort } from "./chat-tool-turn.js";

/** Both normal and grounded Chat enter the same bounded orchestration before model work. */
export async function createChatToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<ChatToolTurnPort | undefined> {
  const chat = deps.store.findChatById(message.chatId);
  if (chat?.jiraPodBinding === undefined)
    return createUnboundChatToolTurn(deps, modelId, message, signal, correlationId);
  const mcp = await deps.mcpChatCatalog?.get(
    correlationIdOrUnknown(correlationId),
    chat.mcpServers,
  );
  return mcp === undefined
    ? createJiraChatToolTurn(deps, modelId, message, signal, correlationId, (context) =>
        openTraceSession(deps, {
          chatId: context.chatId,
          userMessageId: context.userMessageId,
          correlationId: context.correlationId,
        }),
      )
    : createChatSourcesToolTurn(deps, modelId, message, signal, correlationId, mcp);
}
async function createUnboundChatToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<ChatToolTurnPort | undefined> {
  const chat = deps.store.findChatById(message.chatId);
  if (chatKnowledgeScopes(chat).length === 0)
    return createMcpChatToolTurn(deps, modelId, message, signal, correlationId);
  const mcp = await deps.mcpChatCatalog?.get(
    correlationIdOrUnknown(correlationId),
    chat?.mcpServers,
  );
  return mcp === undefined
    ? createKnowledgeChatToolTurn(deps, modelId, message, signal, correlationId)
    : createChatSourcesToolTurn(deps, modelId, message, signal, correlationId, mcp, "knowledge");
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

type CancellableTurn = Pick<
  ChatToolTurnPort,
  "signal" | "deadlineAtMs" | "answersAtDeadline" | "answersAfterScopeChange"
>;
/**
 * Runs inside an abort listener, where a throw is uncaught and ends the process, and possibly long
 * after the request settled: a turn whose state cannot be read has no answer to give.
 */
function turnAnswers(
  signal: AbortSignal,
  turn: CancellableTurn,
  correlationId: string | undefined,
): boolean {
  try {
    const deadlineOnly = !signal.aborted && Date.now() >= turn.deadlineAtMs;
    return turn.answersAfterScopeChange || (deadlineOnly && turn.answersAtDeadline);
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(correlationId),
        operation: "chat.tool-turn.state-unreadable",
        source: "chat-tool-runtime",
        error,
        redact: () => "server-operation-failed",
      }),
    );
    return false;
  }
}

/**
 * The cancellation signal for work that follows an accepted tool turn (#4175). A human stop or an
 * authority revocation cancels at once. The turn's deadline cancels too, except when the turn
 * already settled an exchange: it then answers from its transcript, and that deterministic answer
 * must reach the human instead of a cancellation, like the answer of a turn that a change of the
 * Chat's scope ended after a write. The deadline still bounds every provider dispatch through the
 * turn's own signal and the synthesis grants.
 */
export function chatToolTurnCancellationSignal(
  signal: AbortSignal,
  turn: CancellableTurn,
  correlationId: string | undefined,
): AbortSignal {
  const controller = new AbortController();
  const cancel = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onTurnAbort = (): void => {
    if (!turnAnswers(signal, turn, correlationId)) cancel(turn.signal.reason);
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
