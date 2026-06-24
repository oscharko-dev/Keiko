// Desktop chat SSE streaming BFF route (#152). ADDITIVE to the buffered /api/desktop/chat path,
// which stays byte-identical as the client's fallback. This handler reuses the buffered path's
// front-matter (prepareDesktopChatSend → parse, validate, #149 guardrail, memory) and its
// message-assembly (buildGatewayMessages) so the streamed prompt is identical, then streams content
// deltas as SSE `token` events and persists the turn EXACTLY like persistModelChatTurn on `done`.
//
// Redaction is applied per token AND on the final content (#154): a model echoing a context secret
// is scrubbed before it ever reaches the wire. Guardrail/validation/model errors are returned as a
// JSON RouteResult BEFORE any SSE header so the client can fall back to the buffered route.

import { SSE_HEADERS } from "./sse.js";
import { writeOrDestroy } from "./sse-write.js";
import { STREAMING, errorBody, type HandlerOutcome, type RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { Chat, ChatMessage } from "./store/index.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import type {
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  buildChatPatch,
  buildGatewayMessages,
  buildMemoryResult,
  collectMemoryActions,
  createAssistantMessage,
  createUserMessage,
  deriveCompactionOutcome,
  desktopChatErrorResult,
  emptyMemoryResult,
  prepareDesktopChatSend,
  recordChatCompaction,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";

// One SSE message. JSON.stringify never emits a raw newline inside a string (newlines escape to
// `\n`), so a single `data:` line is always valid framing — no manual escaping, mirroring sse.ts.
function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Wires the request/response lifecycle to the AbortController so a client disconnect cancels the
// in-flight gateway stream (mirrors #152 AC#3 — no partial persistence on cancel). The req
// "aborted" event is deprecated since Node 17 and fires unreliably; res "close" is the canonical
// signal for a disconnected client and covers the same lifecycle.
function abortOnDisconnect(ctx: RouteContext): AbortController {
  const controller = new AbortController();
  ctx.res.on("close", () => {
    controller.abort();
  });
  return controller;
}

interface StreamedTurn {
  readonly response: import("@oscharko-dev/keiko-model-gateway").NormalizedResponse;
}

// Iterates the gateway stream: writes one redacted `token` event per delta, returns the terminal
// response from the `done` chunk. Returns undefined if the signal aborted (no `done` arrived).
// Backpressure (res.write → false) aborts the controller and destroys the socket via writeOrDestroy
// so a slow client is detected immediately rather than buffering without bound.
async function streamConversation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  stream: AsyncIterable<import("@oscharko-dev/keiko-model-gateway").GatewayStreamChunk>,
  controller: AbortController,
): Promise<StreamedTurn | undefined> {
  for await (const chunk of stream) {
    if (controller.signal.aborted) return undefined;
    if (chunk.type === "delta") {
      writeOrDestroy(
        ctx.res,
        sseMessage("token", { text: deps.redactor(chunk.token) }),
        controller,
      );
    } else {
      return { response: chunk.response };
    }
  }
  return undefined;
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
): Promise<Record<string, unknown>> {
  const redactedContent = deps.redactor(turn.response.content) as string;
  const assistantMessage = createAssistantMessage(deps, request, redactedContent, modelId);
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

// Maps a thrown gateway error to a REDACTED { code, message } SSE error payload, reusing the
// buffered path's desktopChatErrorResult so a raw provider message can never leak (#154).
// desktopChatErrorResult rethrows for unexpected (non-Gateway, non-store) errors; once SSE headers
// are committed we can no longer return a JSON 500, so an unexpected error degrades to a generic
// redacted code instead of crashing the stream and leaking a raw message.
function errorEvent(error: unknown, deps: UiHandlerDeps): { code: string; message: string } {
  let result;
  try {
    result = desktopChatErrorResult(error, deps);
  } catch {
    return { code: "GATEWAY_ERROR", message: "The model request failed." };
  }
  const body = result.body as { error?: { code?: string; message?: string } };
  return {
    code: body.error?.code ?? "GATEWAY_ERROR",
    message: body.error?.message ?? "The model request failed.",
  };
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
  const messageCountBeforeTurn = deps.store.listMessages(request.chatId).length;
  const startedAt = Date.now();
  const userMessage = createUserMessage(deps, request);
  const outcome = deriveCompactionOutcome(deps, request);
  const messages = buildGatewayMessages(deps, request, memory.context.text);
  const stream = callStream({ modelId, messages }, controller.signal);
  const turn = await streamConversation(ctx, deps, stream, controller);
  if (turn === undefined || controller.signal.aborted) {
    ctx.res.write(sseMessage("cancelled", {}));
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
    outcome,
    request,
    modelId,
    messageCount: messageCountBeforeTurn,
    startedAt,
  });
  ctx.res.write(sseMessage("done", payload));
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
  const controller = abortOnDisconnect(ctx);
  ctx.res.writeHead(200, SSE_HEADERS);
  try {
    await streamAndPersist(ctx, deps, prepared, callStream, controller);
  } catch (error) {
    if (controller.signal.aborted) {
      ctx.res.write(sseMessage("cancelled", {}));
    } else {
      ctx.res.write(sseMessage("error", errorEvent(error, deps)));
    }
  } finally {
    ctx.res.end();
  }
  return STREAMING;
}
