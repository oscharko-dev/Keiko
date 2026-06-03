// Handlers for the model-call and tool-call states. The harness — not the model — owns
// control flow: it inspects finishReason and toolCalls and decides the next state. A model
// response is never executed as an instruction (ADR-0004 D1).

import {
  CancelledError,
  GatewayError,
  type ChatMessage,
  type GatewayRequest,
  type NormalizedResponse,
  type NormalizedToolCall,
} from "@oscharko-dev/keiko-model-gateway";
import { ToolError } from "@oscharko-dev/keiko-tools";
import { WorkspaceError } from "@oscharko-dev/keiko-workspace";
import { contextBytes, type RunContext, type StateStep } from "./context.js";
import { HARNESS_CODES, toFailure } from "./errors.js";
import type { ToolCallMetadata } from "./ports.js";

const RUN_COMMAND_TOOL = "run_command";

function toolFailureCode(error: unknown): string {
  if (error instanceof ToolError || error instanceof WorkspaceError) {
    return error.code;
  }
  return "TOOL_ERROR";
}

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
  if (ctx.signal.aborted || error instanceof CancelledError) {
    if (ctx.failure?.category === HARNESS_CODES.LIMIT_WALL_TIME) {
      return { to: "limit-exceeded", reason: "maxWallTimeMs exceeded during model call" };
    }
    return { to: "cancelled", reason: "abort detected during model call" };
  }
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
  return response.toolCalls.length === 0
    ? { role: "assistant", content: response.content }
    : { role: "assistant", content: response.content, toolCalls: response.toolCalls };
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
      type: "sandbox:configured",
      envAllowlist: metadata.sandbox.envAllowlist,
      network: metadata.sandbox.network,
      maxOutputBytes: metadata.sandbox.maxOutputBytes,
      timeoutMs: metadata.sandbox.timeoutMs,
      terminationGraceMs: metadata.sandbox.terminationGraceMs,
      cwdRequested: metadata.sandbox.cwdRequested,
    });
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

function abortStep(ctx: RunContext, reason: string): StateStep {
  if (ctx.failure?.category === HARNESS_CODES.LIMIT_WALL_TIME) {
    return { to: "limit-exceeded", reason: "maxWallTimeMs exceeded during tool call" };
  }
  return { to: "cancelled", reason };
}

function commandBudgetExceeded(ctx: RunContext): StateStep {
  ctx.failure = toFailure(HARNESS_CODES.LIMIT_COMMAND_EXEC, "command-execution budget exhausted");
  return { to: "limit-exceeded", reason: "maxCommandExecutions exceeded" };
}

function toolOutputBudgetExceeded(ctx: RunContext, bytes: number): StateStep {
  ctx.failure = toFailure(
    HARNESS_CODES.LIMIT_CONTEXT_SIZE,
    `context ${String(bytes)} bytes exceeds limit ${String(ctx.limits.maxContextBytes)}`,
  );
  return { to: "limit-exceeded", reason: "maxContextBytes exceeded after tool output" };
}

function isStateStep(value: ChatMessage | StateStep): value is StateStep {
  return "to" in value;
}

async function runOneTool(
  ctx: RunContext,
  call: NormalizedToolCall,
): Promise<ChatMessage | StateStep> {
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
      errorCode: toolFailureCode(error),
      message,
    });
    if (ctx.signal.aborted || error instanceof CancelledError) {
      return abortStep(ctx, "abort detected during tool call");
    }
    ctx.failure = toFailure(HARNESS_CODES.TOOL_ERROR, message);
    return { to: "failed", reason: "tool execution failed" };
  }
}

export async function handleToolCall(ctx: RunContext): Promise<StateStep> {
  const calls = ctx.lastResponse?.toolCalls ?? [];
  const results: ChatMessage[] = [];
  for (const call of calls) {
    if (ctx.signal.aborted) {
      return abortStep(ctx, "abort detected before tool call");
    }
    if (
      call.name === RUN_COMMAND_TOOL &&
      ctx.counters.commandExecutions >= ctx.limits.maxCommandExecutions
    ) {
      return commandBudgetExceeded(ctx);
    }
    const result = await runOneTool(ctx, call);
    if (isStateStep(result)) {
      return result;
    }
    const bytes = contextBytes([...ctx.messages, ...results, result]);
    if (bytes > ctx.limits.maxContextBytes) {
      return toolOutputBudgetExceeded(ctx, bytes);
    }
    results.push(result);
  }
  ctx.messages = [...ctx.messages, ...results];
  return { to: "model-call", reason: "tool results fed back to model" };
}
