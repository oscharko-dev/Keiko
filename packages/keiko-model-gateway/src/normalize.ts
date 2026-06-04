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

function buildUsage(payload: Record<string, unknown>, seed: UsageSeed): UsageMetadata {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    requestId: seed.requestId,
    promptTokens: asCount(usage.prompt_tokens),
    completionTokens: asCount(usage.completion_tokens),
    latencyMs: seed.latencyMs,
    costClass: seed.costClass,
  };
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
    throw new MalformedToolCallError(`tool call '${name}' has non-JSON arguments`);
  }
  if (!isRecord(parsed)) {
    throw new MalformedToolCallError(`tool call '${name}' arguments are not an object`);
  }
  return { id, name, arguments: parsed };
}

function parseToolCalls(message: Record<string, unknown>): readonly NormalizedToolCall[] {
  const raw = message.tool_calls;
  return Array.isArray(raw) ? raw.map(parseToolCall) : [];
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

export function normalizeChatResponse(
  rawPayload: unknown,
  modelId: string,
  seed: UsageSeed,
  expectStructured = false,
): NormalizedResponse {
  const payload = isRecord(rawPayload) ? rawPayload : {};
  const usage = buildUsage(payload, seed);
  const choice = firstChoice(payload);
  const message = choice !== undefined && isRecord(choice.message) ? choice.message : {};
  const finishReason = mapFinishReason(choice?.finish_reason);
  assertNotRefusal(message, finishReason);
  const toolCalls = parseToolCalls(message);
  const content = typeof message.content === "string" ? message.content : "";
  const structuredOutput =
    expectStructured && content.length > 0 ? parseStructuredOutput(content) : null;
  return { modelId, content, finishReason, toolCalls, structuredOutput, usage };
}
