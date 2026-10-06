// Provider payload → NormalizedResponse. The internal contract is strict and small
// so workflows fail closed when a provider response is unsafe or malformed.

import {
  MalformedToolCallError,
  ModelRefusalError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  CostClass,
  FinishReason,
  NormalizedResponse,
  NormalizedToolCall,
  UsageMetadata,
} from "./types.js";

export interface UsageSeed {
  readonly requestId: string;
  readonly latencyMs: number;
  readonly costClass: CostClass;
}

const FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "error",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function mapFinishReason(value: unknown): FinishReason {
  return typeof value === "string" && FINISH_REASONS.has(value as FinishReason)
    ? (value as FinishReason)
    : "stop";
}

// #3878: the provider's own count of reasoning tokens, only when it reports one as a whole
// non-negative number; an absent or malformed count stays absent and is never estimated.
function reportedReasoningTokens(usage: Record<string, unknown>): number | undefined {
  const details = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;
  const value = details?.reasoning_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function buildUsage(payload: Record<string, unknown>, seed: UsageSeed): UsageMetadata {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const reasoningTokens = reportedReasoningTokens(usage);
  return {
    requestId: seed.requestId,
    promptTokens: asCount(usage.prompt_tokens),
    completionTokens: asCount(usage.completion_tokens),
    latencyMs: seed.latencyMs,
    costClass: seed.costClass,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

const UTF8 = new TextEncoder();

// The name is provider-controlled and gateway error messages cross to UI-visible
// bodies, so it is admitted into a message only when it is a bounded machine token
// (mirrors the server diagnostics machineToken bound, which this package cannot
// import); URLs, prose, or echoed content are omitted, never rewritten.
const TOOL_NAME_TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

function toolCallLabel(name: string): string {
  return TOOL_NAME_TOKEN_SHAPE.test(name) ? `tool call '${name}'` : "tool call";
}

function parseToolCall(raw: unknown): NormalizedToolCall {
  if (!isRecord(raw) || !isRecord(raw.function)) {
    throw new MalformedToolCallError("tool call is missing a function descriptor");
  }
  const fn = raw.function;
  const name = typeof fn.name === "string" ? fn.name : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  const argsText = typeof fn.arguments === "string" ? fn.arguments : "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    throw new MalformedToolCallError(`${toolCallLabel(name)} has non-JSON arguments`);
  }
  if (!isRecord(parsed)) {
    throw new MalformedToolCallError(`${toolCallLabel(name)} arguments are not an object`);
  }
  return { id, name, arguments: parsed };
}

/** Reused by the streaming adapter to assemble tool calls from accumulated SSE deltas. */
export function parseNormalizedToolCalls(raw: unknown): readonly NormalizedToolCall[] {
  return Array.isArray(raw) ? raw.map(parseToolCall) : [];
}

function parseToolCalls(message: Record<string, unknown>): readonly NormalizedToolCall[] {
  return parseNormalizedToolCalls(message.tool_calls);
}

function parseStructuredOutput(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertNotRefusal(message: Record<string, unknown>, finishReason: FinishReason): void {
  if (finishReason === "content_filter") {
    throw new ModelRefusalError("provider filtered the model response");
  }
  const refusal = message.refusal;
  if (typeof refusal === "string" && refusal.length > 0) {
    throw new ModelRefusalError("provider refused the model request");
  }
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  return isRecord(choices[0]) ? choices[0] : undefined;
}

function textPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  return typeof value.content === "string" ? value.content : "";
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map(textPart).join("");
}

// #3878: LiteLLM normalises a provider's reasoning (a reasoning parser behind vLLM, Anthropic
// thinking) as `reasoning_content` on a message or a streamed delta; a server that names it
// `reasoning` is read the same way, and `reasoning_content` wins when both are present. Only
// non-empty text counts, and the answer's `content` never absorbs it.
export function reasoningText(record: Record<string, unknown>): string | undefined {
  for (const value of [record.reasoning_content, record.reasoning]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Whether an answer carried model reasoning, as the reasoning text it holds or the bytes its usage
 * recorded (the text is gone once a surface that does not display reasoning discarded it). The one
 * definition behind the reasoning disposition of a completion line and behind the empty answer the
 * gateway steers a repair for (#3873, F23).
 */
export function carriedReasoning(response: NormalizedResponse): boolean {
  return response.reasoning !== undefined || (response.usage.reasoningBytes ?? 0) > 0;
}

function firstMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const choice = firstChoice(payload);
  return choice !== undefined && isRecord(choice.message) ? choice.message : {};
}

/** The reasoning a whole chat-completion body carries, read exactly as normalization reads it. */
export function reasoningOfChatPayload(rawPayload: unknown): string | undefined {
  return reasoningText(firstMessage(isRecord(rawPayload) ? rawPayload : {}));
}

export function normalizeChatResponse(
  rawPayload: unknown,
  modelId: string,
  seed: UsageSeed,
  expectStructured = false,
): NormalizedResponse {
  const payload = isRecord(rawPayload) ? rawPayload : {};
  const usage = buildUsage(payload, seed);
  const choice = firstChoice(payload);
  const message = firstMessage(payload);
  const finishReason = mapFinishReason(choice?.finish_reason);
  assertNotRefusal(message, finishReason);
  const toolCalls = parseToolCalls(message);
  const content = textFromContent(message.content);
  const structuredOutput =
    expectStructured && content.length > 0 ? parseStructuredOutput(content) : null;
  const reasoning = reasoningText(message);
  if (reasoning === undefined) {
    return { modelId, content, finishReason, toolCalls, structuredOutput, usage };
  }
  return {
    modelId,
    content,
    finishReason,
    toolCalls,
    structuredOutput,
    usage: { ...usage, reasoningBytes: UTF8.encode(reasoning).byteLength },
    reasoning,
  };
}

/** Apply the captured catalog binding after the existing provider-secret redaction. */
export function bindNormalizedToolCalls(
  response: NormalizedResponse,
  bind: (calls: readonly NormalizedToolCall[]) => readonly NormalizedToolCall[],
): NormalizedResponse {
  return { ...response, toolCalls: bind(response.toolCalls) };
}
