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
import { STREAMING, errorBody, type HandlerOutcome, type RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { Chat } from "./store/index.js";
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
  desktopChatErrorResult,
  emptyMemoryResult,
  prepareDesktopChatSend,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";

// One SSE message. JSON.stringify never emits a raw newline inside a string (newlines escape to
// `\n`), so a single `data:` line is always valid framing — no manual escaping, mirroring sse.ts.
function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Wires the request/response lifecycle to the AbortController so a client disconnect cancels the
// in-flight gateway stream (mirrors #152 AC#3 — no partial persistence on cancel).
function abortOnDisconnect(ctx: RouteContext): AbortController {
  const controller = new AbortController();
  ctx.req.on("aborted", () => {
    controller.abort();
  });
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
async function streamConversation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  stream: AsyncIterable<import("@oscharko-dev/keiko-model-gateway").GatewayStreamChunk>,
  signal: AbortSignal,
): Promise<StreamedTurn | undefined> {
  for await (const chunk of stream) {
    if (signal.aborted) return undefined;
    if (chunk.type === "delta") {
      ctx.res.write(sseMessage("token", { text: deps.redactor(chunk.token) }));
    } else {
      return { response: chunk.response };
    }
  }
  return undefined;
}

// Persists the streamed turn EXACTLY like persistModelChatTurn: redact content, create user +
// assistant messages, collect memory actions, patch the chat. Returns the `done` event payload.
async function persistStreamedTurn(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
  memory: ConversationMemoryResultWire,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
  turn: StreamedTurn,
): Promise<Record<string, unknown>> {
  const userMessage = createUserMessage(deps, request);
  const redactedContent = deps.redactor(turn.response.content) as string;
  const assistantMessage = createAssistantMessage(deps, request, redactedContent);
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

export async function handleSendDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const prepared = await prepareDesktopChatSend(ctx, deps);
  if ("status" in prepared) return prepared;
  const { request, chat, modelId, memoryContext } = prepared;
  const model = deps.modelPortFactory(modelId);
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
    const memory = await resolveMemory(deps, request, memoryContext);
    const messages = buildGatewayMessages(deps, request, memory.context.text);
    const stream = callStream({ modelId, messages }, controller.signal);
    const turn = await streamConversation(ctx, deps, stream, controller.signal);
    if (turn === undefined || controller.signal.aborted) {
      ctx.res.write(sseMessage("cancelled", {}));
    } else {
      ctx.res.write(
        sseMessage(
          "done",
          await persistStreamedTurn(deps, request, chat, modelId, memory, memoryContext, turn),
        ),
      );
    }
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
