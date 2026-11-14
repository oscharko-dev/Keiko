import { chatKnowledgeScopes } from "./requirement-inventory.js";
import { createKnowledgeChatToolTurn } from "./knowledge-chat-turn.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import type { ChatToolTurnPort } from "./chat-tool-turn.js";
import type { ChatToolTurnCancelReason } from "./chat-tool-turn-ending.js";
import { createJiraChatToolTurn } from "./atlassian/jiraChatToolTurn.js";
import { createMcpChatToolTurn } from "./mcp/mcpChatToolTurn.js";
import { createChatSourcesToolTurn } from "./chat-tool-sources-turn.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { isChatTurnDeadlineReason } from "./chat-tool-turn-deadline.js";
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
> & {
  /** Records why the turn ended without an answer of its own; runs in an abort listener, never throws. */
  readonly recordEnding?: (reason: ChatToolTurnCancelReason) => void;
};
/** The closed body-free diagnostic for a turn state an abort listener could not read or record. */
function reportStateUnreadable(error: unknown, correlationId: string | undefined): void {
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
}

/**
 * Runs inside an abort listener, where a throw is uncaught and ends the process, and possibly long
 * after the request settled: a turn whose state cannot be read has no answer to give. `cause` is the
 * reason of the signal that fired first for this decision.
 */
function turnAnswers(
  signal: AbortSignal,
  turn: CancellableTurn,
  cause: unknown,
  correlationId: string | undefined,
): boolean {
  try {
    const deadlineOnly = !signal.aborted && isChatTurnDeadlineReason(cause);
    return turn.answersAfterScopeChange || (deadlineOnly && turn.answersAtDeadline);
  } catch (error) {
    reportStateUnreadable(error, correlationId);
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
  // One closed line says why the turn ended without an answer of its own, once, with the abort; a
  // recording never throws inside an abort listener.
  const cancel = (reason: unknown, ending?: ChatToolTurnCancelReason): void => {
    if (controller.signal.aborted) return;
    try {
      if (ending !== undefined) turn.recordEnding?.(ending);
    } catch (error) {
      // A recording that fails must not stop the cancellation, nor throw inside an abort listener.
      reportStateUnreadable(error, correlationId);
    }
    controller.abort(reason);
  };
  // The first cause to fire decides: a person's stop that fired first cancels with its own reason; a
  // deadline that fired first answers from the transcript, and a stop that follows it cancels only
  // the delivery to that request, never the receipt the transcript already holds.
  const onTurnAbort = (source: AbortSignal): void => {
    if (turnAnswers(signal, turn, source.reason, correlationId)) return;
    cancel(
      source.reason,
      isChatTurnDeadlineReason(source.reason) ? "deadline-cancelled" : undefined,
    );
  };
  const deadline = AbortSignal.timeout(Math.max(0, turn.deadlineAtMs - Date.now()));
  signal.addEventListener(
    "abort",
    () => {
      cancel(signal.reason, "request-aborted");
    },
    { once: true },
  );
  turn.signal.addEventListener(
    "abort",
    () => {
      onTurnAbort(turn.signal);
    },
    { once: true },
  );
  deadline.addEventListener(
    "abort",
    () => {
      onTurnAbort(deadline);
    },
    { once: true },
  );
  if (signal.aborted) cancel(signal.reason, "request-aborted");
  else if (turn.signal.aborted) onTurnAbort(turn.signal);
  return controller.signal;
}
