// Handlers for the model-call and tool-call states. The harness — not the model — owns
// control flow: it inspects finishReason and toolCalls and decides the next state. A model
// response is never executed as an instruction (ADR-0004 D1).

import { GatewayError } from "../gateway/errors.js";
import type {
  ChatMessage,
  GatewayRequest,
  NormalizedResponse,
  NormalizedToolCall,
} from "../gateway/types.js";
import { contextBytes, type RunContext, type StateStep } from "./context.js";
import { HARNESS_CODES, toFailure } from "./errors.js";
import type { ToolCallMetadata } from "./ports.js";

function buildRequest(ctx: RunContext): GatewayRequest {
  const tools = ctx.plan.allowsTools ? ctx.tools.listTools() : undefined;
  return tools === undefined
    ? { modelId: ctx.modelId, messages: ctx.messages }
    : { modelId: ctx.modelId, messages: ctx.messages, tools };
}

function routeAfterModel(ctx: RunContext, response: NormalizedResponse): StateStep {
  if (response.finishReason === "tool_calls") {
    if (!ctx.plan.allowsTools) {
      ctx.failure = toFailure(
        HARNESS_CODES.INTERNAL,
        "model requested tool calls on a read-only task type",
      );
      return { to: "failed", reason: "tool_calls finishReason forbidden for this task type" };
    }
    return { to: "tool-call", reason: "model requested tool calls" };
  }
  if (ctx.plan.allowsPatch) {
    return { to: "patch-proposal", reason: "model produced final content; assembling patch" };
  }
  return { to: "reporting", reason: "model produced final content; read-only task" };
}

function onModelError(ctx: RunContext, error: unknown): StateStep {
  const code = error instanceof GatewayError ? error.code : "UNKNOWN";
  const message = error instanceof Error ? error.message : "model call failed";
  ctx.emitter.emit({ type: "model:call:failed", modelId: ctx.modelId, errorCode: code, message });
  const retryable = error instanceof GatewayError && error.retryable;
  if (!retryable) {
    ctx.failure = toFailure(HARNESS_CODES.MODEL_ERROR, message);
    return { to: "failed", reason: "non-retryable model error" };
  }
  ctx.counters.failureAttempts += 1;
  if (ctx.counters.failureAttempts >= ctx.limits.maxFailureAttempts) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_FAILURE_ATTEMPTS, "max failure attempts reached");
    return { to: "limit-exceeded", reason: "maxFailureAttempts exceeded" };
  }
  return { to: "planning", reason: "retryable model error; re-planning" };
}

export async function handleModelCall(ctx: RunContext): Promise<StateStep> {
  ctx.counters.modelCalls += 1;
  ctx.emitter.emit({
    type: "model:call:started",
    modelId: ctx.modelId,
    messageCount: ctx.messages.length,
    contextBytes: contextBytes(ctx.messages),
  });
  let response: NormalizedResponse;
  try {
    response = await ctx.model.call(buildRequest(ctx), ctx.signal);
  } catch (error) {
    return onModelError(ctx, error);
  }
  ctx.emitter.emit({
    type: "model:call:completed",
    modelId: ctx.modelId,
    finishReason: response.finishReason,
    toolCallCount: response.toolCalls.length,
    usage: {
      requestId: response.usage.requestId,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      latencyMs: response.usage.latencyMs,
    },
  });
  ctx.emitter.emit({
    type: "reasoning:trace",
    phase: "model-call",
    rationale: "evaluated model response and selected next state",
    modelResponse: response.content,
  });
  ctx.messages = [...ctx.messages, assistantMessage(response)];
  ctx.lastResponse = response;
  return routeAfterModel(ctx, response);
}

function assistantMessage(response: NormalizedResponse): ChatMessage {
  return { role: "assistant", content: response.content };
}

// S-M1: emits the redacted audit event matching a tool's metadata, in addition to
// tool:call:completed, so the issue #10 ledger sees THAT a command ran / a patch applied — never
// the args, stdout, or file paths. No-op when the tool returned no metadata (read-only tools).
function emitToolMetadata(
  ctx: RunContext,
  metadata: ToolCallMetadata | undefined,
  durationMs: number,
): void {
  if (metadata === undefined) {
    return;
  }
  if (metadata.kind === "command") {
    ctx.emitter.emit({
      type: "command:executed",
      executable: metadata.executable,
      argCount: metadata.argCount,
      exitCode: metadata.exitCode,
      timedOut: metadata.timedOut,
      durationMs,
    });
    return;
  }
  ctx.emitter.emit({
    type: "patch:applied",
    changedFiles: metadata.changedFiles,
    created: metadata.created,
    deleted: metadata.deleted,
  });
}

async function runOneTool(ctx: RunContext, call: NormalizedToolCall): Promise<ChatMessage> {
  ctx.counters.toolCalls += 1;
  ctx.emitter.emit({ type: "tool:call:started", toolName: call.name, toolCallId: call.id });
  try {
    const result = await ctx.tools.execute({
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      signal: ctx.signal,
    });
    if (result.commandExecuted === true) {
      ctx.counters.commandExecutions += 1;
    }
    ctx.emitter.emit({
      type: "tool:call:completed",
      toolName: call.name,
      toolCallId: call.id,
      durationMs: result.durationMs,
    });
    emitToolMetadata(ctx, result.metadata, result.durationMs);
    return { role: "tool", content: result.output, toolCallId: call.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "tool execution failed";
    ctx.emitter.emit({
      type: "tool:call:failed",
      toolName: call.name,
      toolCallId: call.id,
      errorCode: "TOOL_ERROR",
      message,
    });
    return { role: "tool", content: `error: ${message}`, toolCallId: call.id };
  }
}

export async function handleToolCall(ctx: RunContext): Promise<StateStep> {
  const calls = ctx.lastResponse?.toolCalls ?? [];
  const results: ChatMessage[] = [];
  for (const call of calls) {
    results.push(await runOneTool(ctx, call));
  }
  ctx.messages = [...ctx.messages, ...results];
  return { to: "model-call", reason: "tool results fed back to model" };
}
