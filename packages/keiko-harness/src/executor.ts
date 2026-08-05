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
import type {
  ContextToolObservation,
  ToolCallResult,
  ToolShapingDegradedReason,
} from "@oscharko-dev/keiko-contracts";
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

// ADR-0055 D4 (PR4-W3): additively attach a shaped observation to the completed ToolCallResult via
// the optional injected port. The port is pure/total; a returned undefined means "no shape for this
// tool type" and leaves `result` untouched. No-op when no port is injected (every existing caller),
// preserving byte-identical behavior. Accumulating onto ctx.shapedObservations is deliberately NOT
// done here: the caller commits it only once the rest of the shaping step has succeeded, so a
// failure cannot leave a half-applied observation behind.
function enrichWithObservation(
  ctx: RunContext,
  call: NormalizedToolCall,
  result: ToolCallResult,
): ToolCallResult {
  if (ctx.shaperPort === undefined) {
    return result;
  }
  const observation = ctx.shaperPort({
    result,
    toolName: call.name,
    toolCallId: call.id,
    arguments: call.arguments,
  });
  if (observation === undefined) {
    return result;
  }
  return { ...result, shapedObservation: observation };
}

interface ToolMessageCandidate {
  readonly raw: ChatMessage;
  readonly compact?: ChatMessage | undefined;
}

function compactObservationContent(observation: ContextToolObservation): string {
  const laneId = "rehydration" in observation ? observation.rehydration?.laneId : undefined;
  return JSON.stringify(
    {
      kind: "keiko.compactedToolObservation",
      summary:
        "Raw tool output exceeded the live harness context budget; this bounded observation preserves failure facts and rehydration metadata.",
      laneId: laneId ?? "tool-observations",
      observation,
    },
    null,
    2,
  );
}

function toolMessageCandidate(result: ToolCallResult): ToolMessageCandidate {
  const raw: ChatMessage = { role: "tool", content: result.output, toolCallId: result.toolCallId };
  if (result.shapedObservation === undefined) {
    return { raw };
  }
  return {
    raw,
    compact: {
      role: "tool",
      content: compactObservationContent(result.shapedObservation),
      toolCallId: result.toolCallId,
    },
  };
}

interface CompactMessagesResult {
  readonly messages: ChatMessage[];
  readonly changed: boolean;
}

interface ToolMessageState {
  readonly messages: readonly ChatMessage[];
  readonly results: readonly ChatMessage[];
  readonly prefix: readonly ChatMessage[];
  readonly changed: boolean;
}

interface ToolMessageSelection {
  readonly messages: readonly ChatMessage[];
  readonly results: readonly ChatMessage[];
  readonly message: ChatMessage;
}

function compactToolMessages(
  messages: readonly ChatMessage[],
  compacted: ReadonlyMap<string, ChatMessage>,
): CompactMessagesResult {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "tool" || message.toolCallId === undefined) {
      return message;
    }
    const compact = compacted.get(message.toolCallId);
    if (compact === undefined || compact.content === message.content) {
      return message;
    }
    changed = true;
    return compact;
  });
  return { messages: next, changed };
}

function unchangedToolMessageState(
  ctx: RunContext,
  results: readonly ChatMessage[],
): ToolMessageState {
  return {
    messages: ctx.messages,
    results,
    prefix: [...ctx.messages, ...results],
    changed: false,
  };
}

function compactedToolMessageState(
  ctx: RunContext,
  results: readonly ChatMessage[],
): ToolMessageState {
  const messages = compactToolMessages(ctx.messages, ctx.compactedToolMessages);
  const compactedResults = compactToolMessages(results, ctx.compactedToolMessages);
  return {
    messages: messages.messages,
    results: compactedResults.messages,
    prefix: [...messages.messages, ...compactedResults.messages],
    changed: messages.changed || compactedResults.changed,
  };
}

function selectIfFits(
  ctx: RunContext,
  state: ToolMessageState,
  message: ChatMessage,
): ToolMessageSelection | undefined {
  const bytes = contextBytes([...state.prefix, message]);
  if (bytes > ctx.limits.maxContextBytes) {
    return undefined;
  }
  return { messages: state.messages, results: state.results, message };
}

function selectToolMessage(
  ctx: RunContext,
  results: readonly ChatMessage[],
  candidate: ToolMessageCandidate,
): ToolMessageSelection | StateStep {
  const rawState = unchangedToolMessageState(ctx, results);
  const raw = selectIfFits(ctx, rawState, candidate.raw);
  if (raw !== undefined) {
    return raw;
  }
  const rawBytes = contextBytes([...rawState.prefix, candidate.raw]);
  const compactedState = compactedToolMessageState(ctx, results);
  const rawAfterPriorCompaction = selectIfFits(ctx, compactedState, candidate.raw);
  if (compactedState.changed && rawAfterPriorCompaction !== undefined) {
    return rawAfterPriorCompaction;
  }
  if (candidate.compact !== undefined) {
    const compact = selectIfFits(ctx, compactedState, candidate.compact);
    if (compact !== undefined) {
      return compact;
    }
  }
  return toolOutputBudgetExceeded(ctx, rawBytes);
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

// Issue #2638 hardening: the pre-execution budget check in handleToolCall is name-scoped to
// `run_command`; the counter itself increments on any tool result that claims a command ran.
// Reject the mismatch here so a rogue or misconfigured tool cannot bypass maxCommandExecutions
// by claiming a command under a different name — this is a tool-contract violation, not a budget
// breach, so it fails with HARNESS_INTERNAL and stops the run rather than continuing. The
// tool:call:failed emit closes the tool:call:started event so per-call observability stays
// consistent with the success and exception paths in runOneTool.
function accountForCommandExecution(
  ctx: RunContext,
  call: NormalizedToolCall,
  result: ToolCallResult,
): StateStep | null {
  if (result.commandExecuted !== true) {
    return null;
  }
  ctx.counters.commandExecutions += 1;
  if (call.name === RUN_COMMAND_TOOL) {
    return null;
  }
  const message = `tool ${call.name} claimed commandExecuted:true; only ${RUN_COMMAND_TOOL} may execute commands`;
  ctx.failure = toFailure(HARNESS_CODES.INTERNAL, message);
  ctx.emitter.emit({
    type: "tool:call:failed",
    toolName: call.name,
    toolCallId: call.id,
    errorCode: HARNESS_CODES.INTERNAL,
    message,
  });
  return {
    to: "failed",
    reason: "tool contract violation: commandExecuted claimed by non-run_command tool",
  };
}

function toolOutputBudgetExceeded(ctx: RunContext, bytes: number): StateStep {
  ctx.failure = toFailure(
    HARNESS_CODES.LIMIT_CONTEXT_SIZE,
    `context ${String(bytes)} bytes exceeds limit ${String(ctx.limits.maxContextBytes)}`,
  );
  return { to: "limit-exceeded", reason: "maxContextBytes exceeded after tool output" };
}

function isStateStep(value: ToolMessageCandidate | StateStep): value is StateStep {
  return "to" in value;
}

function isSelectedToolMessage(
  value: ToolMessageSelection | StateStep,
): value is ToolMessageSelection {
  return "message" in value;
}

// Shaping and compaction are additive (ADR-0055 D4) and run AFTER the tool has succeeded and
// tool:call:completed has already been emitted. A shaper port that throws in violation of its own
// totality contract, or an observation that cannot be serialized, must therefore degrade to the
// raw ToolCallResult: it may not re-enter the tool-failure path, may not emit a second,
// contradictory terminal event for this toolCallId, and may not end the run. Both side effects are
// committed only once every step that can still throw has succeeded. A degraded fallback still
// emits a redacted, non-terminal diagnostic (tool:shaping:degraded) so a broken shaper port or a
// non-serialisable observation is operator-visible instead of silently discarded — the two steps
// that can throw are tried separately so the reason names which one actually failed.
function shapeOrFallBackToRaw(
  ctx: RunContext,
  call: NormalizedToolCall,
  result: ToolCallResult,
): ToolMessageCandidate {
  let enriched: ToolCallResult;
  try {
    enriched = enrichWithObservation(ctx, call, result);
  } catch {
    emitShapingDegraded(ctx, call, "shaper-threw");
    return toolMessageCandidate(result);
  }
  try {
    const candidate = toolMessageCandidate(enriched);
    if (enriched.shapedObservation !== undefined) {
      ctx.shapedObservations.push(enriched.shapedObservation);
    }
    if (candidate.compact !== undefined) {
      ctx.compactedToolMessages.set(call.id, candidate.compact);
    }
    return candidate;
  } catch {
    emitShapingDegraded(ctx, call, "unserializable-observation");
    // Intentionally terminal: the enrichment is optional, the tool call already succeeded, and the
    // raw output is the same model-facing message the harness produces with no port injected.
    return toolMessageCandidate(result);
  }
}

function emitShapingDegraded(
  ctx: RunContext,
  call: NormalizedToolCall,
  reason: ToolShapingDegradedReason,
): void {
  ctx.emitter.emit({
    type: "tool:shaping:degraded",
    toolCallId: call.id,
    toolName: call.name,
    reason,
  });
}

async function runOneTool(
  ctx: RunContext,
  call: NormalizedToolCall,
): Promise<ToolMessageCandidate | StateStep> {
  ctx.counters.toolCalls += 1;
  ctx.emitter.emit({ type: "tool:call:started", toolName: call.name, toolCallId: call.id });
  try {
    const result = await ctx.tools.execute({
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      signal: ctx.signal,
    });
    const contractViolation = accountForCommandExecution(ctx, call, result);
    if (contractViolation !== null) {
      return contractViolation;
    }
    ctx.emitter.emit({
      type: "tool:call:completed",
      toolName: call.name,
      toolCallId: call.id,
      durationMs: result.durationMs,
    });
    emitToolMetadata(ctx, result.metadata, result.durationMs);
    return shapeOrFallBackToRaw(ctx, call, result);
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
  let results: ChatMessage[] = [];
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
    const selected = selectToolMessage(ctx, results, result);
    if (!isSelectedToolMessage(selected)) {
      return selected;
    }
    ctx.messages = [...selected.messages];
    results = [...selected.results, selected.message];
  }
  ctx.messages = [...ctx.messages, ...results];
  return { to: "model-call", reason: "tool results fed back to model" };
}
