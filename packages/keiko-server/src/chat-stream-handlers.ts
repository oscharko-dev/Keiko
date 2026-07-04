// Desktop chat SSE streaming BFF route (#152). ADDITIVE to the buffered /api/desktop/chat path,
// which stays byte-identical as the client's fallback. This handler reuses the buffered path's
// front-matter (prepareDesktopChatSend → parse, validate, #149 guardrail, memory) and its
// message-assembly (buildGatewayMessages) so the streamed prompt is identical, then streams content
// deltas as SSE `token` events and persists the turn EXACTLY like persistModelChatTurn on `done`.
//
// Redaction is applied per token AND on the final content (#154): a model echoing a context secret
// is scrubbed before it ever reaches the wire. Guardrail/validation/model errors are returned as a
// JSON RouteResult BEFORE any SSE header so the client can fall back to the buffered route.

import { SSE_HEADERS, startSseHeartbeat } from "./sse.js";
import { writeOrDestroy } from "./sse-write.js";
import { STREAMING, errorBody, type HandlerOutcome, type RouteContext } from "./routes.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import type { UiHandlerDeps } from "./deps.js";
import type { Chat, ChatMessage } from "./store/index.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import type {
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
  DesktopChatSendResponse,
  DesktopChatStreamEvent,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  abortDesktopChatOnDisconnect,
  buildChatPatch,
  buildGatewayAssembly,
  buildMemoryResult,
  collectMemoryActions,
  createAssistantMessage,
  createUserMessage,
  desktopChatErrorResult,
  emptyMemoryResult,
  prepareDesktopChatSend,
  recordChatCompaction,
  recordConversationMemoryUse,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";

// One SSE message. JSON.stringify never emits a raw newline inside a string (newlines escape to
// `\n`), so a single `data:` line is always valid framing — no manual escaping, mirroring sse.ts.
function sseMessage(message: DesktopChatStreamEvent): string {
  return `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

interface StreamedTurn {
  readonly response: import("@oscharko-dev/keiko-model-gateway").NormalizedResponse;
}

// Iterates the gateway stream: writes one redacted `token` event per delta, returns the terminal
// response from the `done` chunk. Returns undefined if the signal aborted (no `done` arrived).
// Backpressure (res.write → false) aborts the controller and destroys the socket via writeOrDestroy
// so a slow client is detected immediately rather than buffering without bound.
// Terminal reason for a stream that did not reach `done`: an intentional user cancel vs a backpressure
// kill (slow client). Threaded out so the caller can emit a DISTINCT terminal signal and avoid
// relabeling a backpressure termination as a user cancel (GEN-PERF-CHAT-006).
interface StreamTermination {
  backpressure: boolean;
}

async function streamConversation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  stream: AsyncIterable<import("@oscharko-dev/keiko-model-gateway").GatewayStreamChunk>,
  controller: AbortController,
  termination: StreamTermination,
): Promise<StreamedTurn | undefined> {
  for await (const chunk of stream) {
    if (controller.signal.aborted) return undefined;
    if (chunk.type === "delta") {
      writeOrDestroy(
        ctx.res,
        sseMessage({ event: "token", data: { text: deps.redactor(chunk.token) as string } }),
        controller,
        () => {
          // Distinct, observable signal: this termination is a slow-client backpressure kill, not a
          // user cancel. Carries no body bytes. The subsequent abort() surfaces as a stream end.
          termination.backpressure = true;
        },
      );
    } else {
      return { response: chunk.response };
    }
  }
  return undefined;
}

// A backpressure kill destroys the socket; writing another SSE frame to it is a no-op at best and can
// throw on some transports. Guard terminal writes so we never write-after-destroy nor relabel a
// backpressure termination as a user cancel.
function writeTerminalFrame(ctx: RouteContext, frame: string): void {
  if (ctx.res.writableEnded || ctx.res.destroyed) return;
  ctx.res.write(frame);
}

// Persists the streamed turn EXACTLY like persistModelChatTurn: redact content, create the
// assistant message, collect memory actions, patch the chat. Returns the `done` event payload.
// The user message is created BEFORE the prompt is built (mirroring the buffered path), so it is
// threaded in here rather than created again — creating it twice would duplicate the turn.
async function persistStreamedTurn(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
  memory: ConversationMemoryResultWire,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
  turn: StreamedTurn,
  userMessage: ChatMessage,
): Promise<DesktopChatSendResponse> {
  const redactedContent = deps.redactor(turn.response.content) as string;
  const assistantMessage = createAssistantMessage(deps, request, redactedContent, modelId);
  recordConversationMemoryUse(deps, memory, redactedContent);
  const actions: readonly ConversationMemoryActionWire[] = await collectMemoryActions(
    deps,
    request,
    memoryContext,
    modelId,
    redactedContent,
  );
  const updatedChat = deps.store.updateChat(request.chatId, buildChatPatch(chat, request, modelId));
  return {
    chat: updatedChat,
    messages: [userMessage, assistantMessage],
    usage: turn.response.usage,
    memory: { ...memory, actions },
  };
}

async function resolveMemory(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
): Promise<ConversationMemoryResultWire> {
  return memoryContext === undefined
    ? emptyMemoryResult(false)
    : buildMemoryResult(request, deps, memoryContext);
}

// Maps a thrown gateway error to a REDACTED { code, message, correlationId } SSE error payload,
// reusing the buffered path's desktopChatErrorResult so a raw provider message can never leak (#154).
//
// RB-6 (GEN-OBS-DIAGNOSTICS-602, STATUS-403): before returning ANY frame, the real cause is routed —
// redacted — to the operator diagnostic sink, keyed by the request correlation id, so a mid-stream
// failure is no longer an untraceable black box. desktopChatErrorResult rethrows for unexpected
// (non-Gateway, non-store) errors; once SSE headers are committed we can no longer return a JSON 500,
// so an unexpected error now surfaces as an honest `INTERNAL` code (NOT a misleading `GATEWAY_ERROR`,
// which falsely blamed the provider) carrying the correlation id.
function errorEvent(
  error: unknown,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): { code: string; message: string; correlationId?: string } {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationId ?? "unknown",
      operation: "POST /api/desktop/chat/stream",
      source: "chat.stream",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
  const withId = (payload: {
    code: string;
    message: string;
  }): {
    code: string;
    message: string;
    correlationId?: string;
  } => (correlationId === undefined ? payload : { ...payload, correlationId });
  let result;
  try {
    result = desktopChatErrorResult(error, deps);
  } catch {
    return withId({ code: "INTERNAL", message: "An unexpected error occurred." });
  }
  const body = result.body as { error?: { code?: string; message?: string } };
  return withId({
    code: body.error?.code ?? "GATEWAY_ERROR",
    message: body.error?.message ?? "The model request failed.",
  });
}

// Streams the gateway response and writes the terminal SSE event. Persists the user turn BEFORE
// building the prompt so buildGatewayMessages (which reads store.listMessages) includes the current
// message — otherwise a fresh chat sends `[system]` only (model hallucinates) and a history chat
// ends on an `assistant` turn (some providers reject it 400). Mirrors the buffered
// persistModelChatTurn ordering exactly (#152). On cancel the user turn stays persisted (saved for
// retry) with no assistant message — identical to the buffered path's no-rollback-on-error contract.
async function streamAndPersist(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  prepared: {
    request: SendDesktopChatRequest;
    chat: Chat;
    modelId: string;
    memoryContext: ConversationMemoryRuntimeContext | undefined;
  },
  callStream: NonNullable<import("@oscharko-dev/keiko-harness").ModelPort["callStream"]>,
  controller: AbortController,
): Promise<void> {
  const { request, chat, modelId, memoryContext } = prepared;
  const memory = await resolveMemory(deps, request, memoryContext);
  // ADR-0057 D3: pin the pre-user-message count BEFORE createUserMessage, mirroring the buffered
  // path's lifecycle moment so the compaction-evidence runId is identical across both paths.
  const messageCountBeforeTurn = deps.store.countMessages(request.chatId);
  const startedAt = Date.now();
  const userMessage = createUserMessage(deps, request);
  const assembly = buildGatewayAssembly(deps, request, memory, modelId);
  const messages = assembly.messages;
  const stream = callStream({ modelId, messages }, controller.signal);
  const termination: StreamTermination = { backpressure: false };
  const turn = await streamConversation(ctx, deps, stream, controller, termination);
  if (turn === undefined || controller.signal.aborted) {
    // A backpressure kill already destroyed the socket; do not write-after-destroy nor relabel it as
    // a user cancel. Only an actual (non-backpressure) cancel emits the `cancelled` terminal event.
    if (!termination.backpressure) {
      writeTerminalFrame(ctx, sseMessage({ event: "cancelled", data: {} }));
    }
    return;
  }
  const payload = await persistStreamedTurn(
    deps,
    request,
    chat,
    modelId,
    memory,
    memoryContext,
    turn,
    userMessage,
  );
  recordChatCompaction(deps, {
    compaction: assembly.compaction,
    request,
    modelId,
    messageCount: messageCountBeforeTurn,
    startedAt,
  });
  writeTerminalFrame(ctx, sseMessage({ event: "done", data: payload }));
}

export async function handleSendDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const prepared = await prepareDesktopChatSend(ctx, deps);
  if ("status" in prepared) return prepared;
  const model = deps.modelPortFactory(prepared.modelId);
  if (model?.callStream === undefined) {
    return {
      status: 400,
      body: errorBody("STREAMING_UNSUPPORTED", "Streaming is not available for this model."),
    };
  }
  const callStream = model.callStream.bind(model);
  const controller = abortDesktopChatOnDisconnect(ctx);
  ctx.res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(ctx.res);
  try {
    await streamAndPersist(ctx, deps, prepared, callStream, controller);
  } catch (error) {
    if (controller.signal.aborted) {
      writeTerminalFrame(ctx, sseMessage({ event: "cancelled", data: {} }));
    } else {
      writeTerminalFrame(
        ctx,
        sseMessage({ event: "error", data: errorEvent(error, deps, ctx.correlationId) }),
      );
    }
  } finally {
    stopHeartbeat();
    ctx.res.end();
  }
  return STREAMING;
}
