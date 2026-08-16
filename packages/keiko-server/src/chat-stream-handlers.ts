// Desktop chat SSE streaming BFF route (#152). ADDITIVE to the buffered /api/desktop/chat path,
// which stays byte-identical as the client's fallback. This handler reuses the buffered path's
// front-matter (parseDesktopChatSend → validate, #149 guardrail, memory) and its
// message assembly so the streamed prompt is identical, then streams content
// deltas as SSE `token` events and persists the turn EXACTLY like persistModelChatTurn on `done`.
//
// Redaction is applied per token AND on the final content (#154): a model echoing a context secret
// is scrubbed before it ever reaches the wire. Guardrail/validation/model errors are returned as a
// JSON RouteResult BEFORE any SSE header so the client can fall back to the buffered route.

import { SSE_HEADERS, startSseHeartbeat } from "./sse.js";
import { writeOrDestroy } from "./sse-write.js";
import {
  STREAMING,
  errorBody,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "./routes.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import type {
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
  DesktopChatSendResponse,
  DesktopChatStreamEvent,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  commitChatAfterTurn,
  buildGatewayAssembly,
  assemblyWithConversationImages,
  conversationImageDeliveries,
  buildMemoryResult,
  captureDesktopChatExecutionAdmission,
  captureGatewayTurnSnapshot,
  collectMemoryActions,
  completeDesktopChatTurn,
  createAssistantMessage,
  desktopChatErrorResult,
  emptyMemoryResult,
  failDesktopChatTurn,
  gatewayHistoryPrefix,
  admitDesktopChatTurn,
  inspectDesktopChatTurn,
  parseDesktopChatSend,
  recordChatCompaction,
  validateDesktopChatSend,
  validateDesktopChatProviderBoundary,
  validateCurrentDesktopChatSend,
  runPostCommitConversationMemorySideEffects,
  type ParsedDesktopChatSend,
  type PreparedDesktopChatSend,
  type SendDesktopChatRequest,
  type GatewayTurnSnapshot,
  type DesktopChatExecutionAdmission,
} from "./chat-handlers.js";
import { CHAT_TURN_WAIT_CANCELLED, runSerializedChatTurn } from "./chat-turn-serializer.js";
import { createRequestCancellation } from "./request-cancellation.js";

// One SSE message. JSON.stringify never emits a raw newline inside a string (newlines escape to
// `\n`), so a single `data:` line is always valid framing — no manual escaping, mirroring sse.ts.
function sseMessage(message: DesktopChatStreamEvent): string {
  return `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

// GEN-PERF-CHATSTREAM-001 — bulkhead for concurrent chat SSE streams, mirroring the caps every
// sibling stream type already has (agent runs 16, QI runs 2, voice sessions 64). Without it, N
// open windows could fan out N unbounded upstream gateway streams. The rejection is a JSON 429
// BEFORE any SSE header, which the client maps to StreamingUnavailableError and transparently
// degrades to the buffered /api/desktop/chat path — no user-facing failure, no held SSE socket.
export const MAX_ACTIVE_CHAT_STREAMS_ENV = "KEIKO_CHAT_MAX_ACTIVE_STREAMS";
const DEFAULT_MAX_ACTIVE_CHAT_STREAMS = 16;
const HARD_MAX_ACTIVE_CHAT_STREAMS = 64;
let activeChatStreams = 0;

function maxActiveChatStreams(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_ACTIVE_CHAT_STREAMS_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_ACTIVE_CHAT_STREAMS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ACTIVE_CHAT_STREAMS;
  return Math.min(parsed, HARD_MAX_ACTIVE_CHAT_STREAMS);
}

// Test seam: not exported via index.ts. The counter is module state; parallel test files
// each get their own module instance, so a reset keeps cases order-independent.
export function _resetActiveChatStreamsForTests(): void {
  activeChatStreams = 0;
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

function requestIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function reportStreamIteratorCleanupFailure(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: ctx.correlationId ?? "unknown",
      operation: "POST /api/desktop/chat/stream",
      source: "chat.stream.iterator-cleanup",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}

function releaseStreamIterator(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  iterator: AsyncIterator<import("@oscharko-dev/keiko-model-gateway").GatewayStreamChunk>,
): void {
  try {
    const cleanup = iterator.return?.();
    if (cleanup !== undefined) {
      void cleanup.catch((error: unknown) => {
        reportStreamIteratorCleanupFailure(ctx, deps, error);
      });
    }
  } catch (error) {
    reportStreamIteratorCleanupFailure(ctx, deps, error);
  }
}

async function streamConversation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  stream: AsyncIterable<import("@oscharko-dev/keiko-model-gateway").GatewayStreamChunk>,
  controller: AbortController,
  termination: StreamTermination,
): Promise<StreamedTurn | undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return undefined;
      const chunk = next.value;
      if (controller.signal.aborted) return undefined;
      if (chunk.type === "delta") {
        writeOrDestroy(
          ctx.res,
          sseMessage({ event: "token", data: { text: deps.redactor(chunk.token) as string } }),
          controller,
          () => {
            termination.backpressure = true;
          },
        );
        if (requestIsAborted(controller.signal)) return undefined;
      } else {
        return { response: chunk.response };
      }
    }
  } finally {
    releaseStreamIterator(ctx, deps, iterator);
  }
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
  prepared: PreparedDesktopChatSend,
  memory: ConversationMemoryResultWire,
  turn: StreamedTurn,
  userMessage: ChatMessage,
  signal: AbortSignal,
): Promise<DesktopChatSendResponse | undefined> {
  const { request, chat, modelId, memoryContext } = prepared;
  const redactedContent = deps.redactor(turn.response.content) as string;
  const actions: readonly ConversationMemoryActionWire[] = await collectMemoryActions(
    deps,
    request,
    memoryContext,
  );
  if (signal.aborted) return undefined;
  const createdAssistant = createAssistantMessage(
    deps,
    request,
    redactedContent,
    modelId,
    userMessage,
  );
  const updatedChat = commitChatAfterTurn(deps, chat, request, modelId);
  const [canonicalUser, assistantMessage] = completeDesktopChatTurn(
    deps,
    prepared,
    userMessage,
    createdAssistant,
  );
  runPostCommitConversationMemorySideEffects(
    deps,
    request,
    memoryContext,
    modelId,
    memory,
    redactedContent,
    assistantMessage.id,
  );
  return {
    chat: updatedChat,
    messages: [canonicalUser, assistantMessage],
    usage: turn.response.usage,
    memory: { ...memory, actions },
    ...(conversationImageDeliveries(request).length === 0
      ? {}
      : { attachmentDeliveries: conversationImageDeliveries(request) }),
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
// capturing the prompt snapshot so it includes the current message by stable id. On cancel the user
// turn stays persisted (saved for retry) with no assistant message, matching the buffered path.
function failCancelledStreamTurn(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  emitTerminal: boolean,
): void {
  failDesktopChatTurn(deps, request, "cancelled");
  if (emitTerminal) writeTerminalFrame(ctx, sseMessage({ event: "cancelled", data: {} }));
}

async function streamAndPersist(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  admitted: AdmittedDesktopChatStream,
  controller: AbortController,
): Promise<void> {
  const { prepared, callStream, userMessage, gatewayTurn, messageCountBeforeTurn } = admitted;
  const { request, modelId, memoryContext } = prepared;
  const startedAt = Date.now();
  const memory = admitted.memory ?? (await resolveMemory(deps, request, memoryContext));
  if (requestIsAborted(controller.signal)) {
    failCancelledStreamTurn(ctx, deps, request, true);
    return;
  }
  const assembly = assemblyWithConversationImages(
    deps,
    request,
    modelId,
    buildGatewayAssembly(deps, request, memory, modelId, gatewayTurn),
  );
  const stream = callStream({ modelId, messages: assembly.messages }, controller.signal);
  const termination: StreamTermination = { backpressure: false };
  const turn = await streamConversation(ctx, deps, stream, controller, termination);
  if (turn === undefined || requestIsAborted(controller.signal)) {
    // A backpressure kill already destroyed the socket; do not write-after-destroy nor relabel it as
    // a user cancel. Only an actual (non-backpressure) cancel emits the `cancelled` terminal event.
    failCancelledStreamTurn(ctx, deps, request, !termination.backpressure);
    return;
  }
  const payload = await persistStreamedTurn(
    deps,
    prepared,
    memory,
    turn,
    userMessage,
    controller.signal,
  );
  if (payload === undefined) {
    failCancelledStreamTurn(ctx, deps, request, true);
    return;
  }
  recordChatCompaction(deps, {
    compaction: assembly.compaction,
    request,
    modelId,
    messageCount: messageCountBeforeTurn,
    startedAt,
    historyPrefix: gatewayHistoryPrefix(gatewayTurn),
  });
  writeTerminalFrame(ctx, sseMessage({ event: "done", data: payload }));
}

export async function handleSendDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const cancellation = createRequestCancellation(ctx, "desktop chat stream cancelled");
  try {
    // GEN-PERF-CHATSTREAM-001 — reject before any work (and before any SSE header) so the
    // client degrades to the buffered path instead of stacking an unbounded upstream fan-out.
    if (activeChatStreams >= maxActiveChatStreams()) {
      return {
        status: 429,
        body: errorBody("TOO_MANY_STREAMS", "Too many concurrent chat streams; retry buffered."),
      };
    }
    activeChatStreams += 1;
    try {
      return await runDesktopChatStream(ctx, deps, cancellation.controller);
    } finally {
      activeChatStreams -= 1;
    }
  } finally {
    cancellation.dispose();
  }
}

type StreamCall = NonNullable<import("@oscharko-dev/keiko-harness").ModelPort["callStream"]>;

interface PreparedDesktopChatStream {
  readonly kind: "ready";
  readonly parsed: ParsedDesktopChatSend;
}

type DesktopChatStreamPreparation =
  | PreparedDesktopChatStream
  | { readonly kind: "outcome"; readonly outcome: HandlerOutcome }
  | { readonly kind: "replay"; readonly response: DesktopChatSendResponse };

function streamingUnsupportedOutcome(): RouteResult {
  return {
    status: 400,
    body: errorBody("STREAMING_UNSUPPORTED", "Streaming is not available for this model."),
  };
}

function streamingReplayOutcome(
  ctx: RouteContext,
  response: DesktopChatSendResponse,
): HandlerOutcome {
  ctx.res.writeHead(200, SSE_HEADERS);
  writeTerminalFrame(ctx, sseMessage({ event: "done", data: response }));
  ctx.res.end();
  return STREAMING;
}

function inspectedStreamPreparation(
  inspection: ReturnType<typeof inspectDesktopChatTurn>,
): DesktopChatStreamPreparation | undefined {
  if (inspection.kind === "rejected") return { kind: "outcome", outcome: inspection.result };
  return inspection.kind === "replay"
    ? { kind: "replay", response: inspection.response }
    : undefined;
}

function nonAdmittedStreamOutcome(
  ctx: RouteContext,
  admission: Exclude<ReturnType<typeof admitDesktopChatTurn>, { readonly kind: "admitted" }>,
): HandlerOutcome {
  if (admission.kind === "rejected") return admission.result;
  return streamingReplayOutcome(ctx, admission.response);
}

async function prepareDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  signal: AbortSignal,
): Promise<DesktopChatStreamPreparation> {
  const parsed = await parseDesktopChatSend(ctx, deps, signal);
  if ("status" in parsed) return { kind: "outcome", outcome: parsed };
  const prepared = validateDesktopChatSend(parsed, deps);
  if ("status" in prepared) return { kind: "outcome", outcome: prepared };
  const inspection = inspectDesktopChatTurn(deps, prepared);
  const inspected = inspectedStreamPreparation(inspection);
  if (inspected !== undefined) return inspected;
  return {
    kind: "ready",
    parsed,
  };
}

function resolveDesktopChatStreamCall(
  prepared: PreparedDesktopChatSend,
  executionAdmission: DesktopChatExecutionAdmission,
  deps: UiHandlerDeps,
): StreamCall | RouteResult {
  const invalidExecution = validateDesktopChatProviderBoundary(
    prepared.modelId,
    executionAdmission,
    deps,
  );
  if (invalidExecution !== undefined) return invalidExecution;
  const model = deps.modelPortFactory(prepared.modelId);
  return model?.callStream === undefined
    ? streamingUnsupportedOutcome()
    : model.callStream.bind(model);
}

interface AdmittedDesktopChatStream {
  readonly prepared: PreparedDesktopChatSend;
  readonly callStream: StreamCall;
  readonly memory: ConversationMemoryResultWire | undefined;
  readonly userMessage: ChatMessage;
  readonly gatewayTurn: GatewayTurnSnapshot;
  readonly messageCountBeforeTurn: number;
}

function writeStreamFailure(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  controller: AbortController,
  error: unknown,
): void {
  const cancelled = requestIsAborted(controller.signal);
  failDesktopChatTurn(deps, request, cancelled ? "cancelled" : "failed");
  const event: DesktopChatStreamEvent = cancelled
    ? { event: "cancelled", data: {} }
    : { event: "error", data: errorEvent(error, deps, ctx.correlationId) };
  writeTerminalFrame(ctx, sseMessage(event));
}

async function executeAdmittedDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  turn: AdmittedDesktopChatStream,
  controller: AbortController,
  markStreamStarted: () => void,
): Promise<HandlerOutcome> {
  let stopHeartbeat: (() => void) | undefined;
  try {
    ctx.res.writeHead(200, SSE_HEADERS);
    markStreamStarted();
    stopHeartbeat = startSseHeartbeat(ctx.res);
    await streamAndPersist(ctx, deps, turn, controller);
  } catch (error) {
    writeStreamFailure(ctx, deps, turn.prepared.request, controller, error);
  } finally {
    stopHeartbeat?.();
    ctx.res.end();
  }
  return STREAMING;
}

interface DesktopChatStreamExecutionPreflight {
  readonly legacyExecutionAdmission: DesktopChatExecutionAdmission | undefined;
  readonly legacyCall: StreamCall | undefined;
}

function preflightDesktopChatStreamExecution(
  prepared: PreparedDesktopChatSend,
  deps: UiHandlerDeps,
): DesktopChatStreamExecutionPreflight | RouteResult {
  const legacyExecutionAdmission =
    prepared.request.clientTurnId === undefined
      ? captureDesktopChatExecutionAdmission(
          prepared.request,
          prepared.chat,
          prepared.modelId,
          deps,
        )
      : undefined;
  if (legacyExecutionAdmission !== undefined && "status" in legacyExecutionAdmission) {
    return legacyExecutionAdmission;
  }
  const legacyCall =
    deps.gatewayConfig === undefined && legacyExecutionAdmission !== undefined
      ? resolveDesktopChatStreamCall(prepared, legacyExecutionAdmission, deps)
      : undefined;
  return legacyCall === undefined || typeof legacyCall === "function"
    ? { legacyExecutionAdmission, legacyCall }
    : legacyCall;
}

async function prepareDesktopChatProviderStream(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  executionAdmission: DesktopChatExecutionAdmission,
  legacyCall: StreamCall | undefined,
  controller: AbortController,
): Promise<Pick<AdmittedDesktopChatStream, "callStream" | "memory"> | RouteResult> {
  const memory =
    deps.gatewayConfig === undefined
      ? undefined
      : await resolveMemory(deps, prepared.request, prepared.memoryContext);
  if (requestIsAborted(controller.signal)) {
    failDesktopChatTurn(deps, prepared.request, "cancelled");
    return { status: 499, body: errorBody("REQUEST_CANCELLED", "Request was cancelled.") };
  }
  const callStream = legacyCall ?? resolveDesktopChatStreamCall(prepared, executionAdmission, deps);
  if (typeof callStream === "function") return { callStream, memory };
  failDesktopChatTurn(deps, prepared.request);
  return callStream;
}

async function runAdmittedDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  start: PreparedDesktopChatStream,
  controller: AbortController,
  markStreamStarted: () => void,
): Promise<HandlerOutcome> {
  const prepared = validateCurrentDesktopChatSend(start.parsed, deps);
  if ("status" in prepared) return prepared;
  const preflight = preflightDesktopChatStreamExecution(prepared, deps);
  if ("status" in preflight) return preflight;
  const messageCountBeforeTurn = deps.store.countMessages(prepared.request.chatId);
  const admission = admitDesktopChatTurn(deps, prepared);
  if (admission.kind !== "admitted") return nonAdmittedStreamOutcome(ctx, admission);
  const executionAdmission =
    preflight.legacyExecutionAdmission ??
    captureDesktopChatExecutionAdmission(prepared.request, prepared.chat, prepared.modelId, deps);
  if ("status" in executionAdmission) {
    failDesktopChatTurn(deps, prepared.request);
    return executionAdmission;
  }
  const provider = await prepareDesktopChatProviderStream(
    deps,
    prepared,
    executionAdmission,
    preflight.legacyCall,
    controller,
  );
  if ("status" in provider) return provider;
  const gatewayTurn = captureGatewayTurnSnapshot(deps, prepared.request, admission.userMessage);
  return executeAdmittedDesktopChatStream(
    ctx,
    deps,
    {
      prepared,
      callStream: provider.callStream,
      memory: provider.memory,
      userMessage: admission.userMessage,
      gatewayTurn,
      messageCountBeforeTurn,
    },
    controller,
    markStreamStarted,
  );
}

interface DesktopChatStreamState {
  started: boolean;
}

async function runDesktopChatStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  controller: AbortController,
): Promise<HandlerOutcome> {
  const start = await prepareDesktopChatStream(ctx, deps, controller.signal);
  if (controller.signal.aborted) {
    return { status: 499, body: errorBody("REQUEST_CANCELLED", "Request was cancelled.") };
  }
  if (start.kind === "outcome") return start.outcome;
  if (start.kind === "replay") return streamingReplayOutcome(ctx, start.response);
  const streamState: DesktopChatStreamState = { started: false };
  const result = await runSerializedChatTurn(
    deps,
    start.parsed.request.chatId,
    controller.signal,
    () =>
      runAdmittedDesktopChatStream(ctx, deps, start, controller, () => {
        streamState.started = true;
      }),
  );
  if (result !== CHAT_TURN_WAIT_CANCELLED) return result;
  return streamState.started
    ? STREAMING
    : { status: 499, body: errorBody("REQUEST_CANCELLED", "Request was cancelled.") };
}
