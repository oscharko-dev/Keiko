import type { GatewayToolCallingOutcome } from "@oscharko-dev/keiko-contracts/bff-wire";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { redactContent } from "@oscharko-dev/keiko-security";
import {
  requestGatewayReadinessChatCompletion,
  readGatewayReadinessChatCompletionResponse,
  type EnvSource,
  type GatewayCallRequest,
  type ToolDefinition,
  type GatewayConfig,
  type GatewaySpendReservation,
  type ModelCapability,
  type ModelProviderConfig,
  type UsageMetadata,
} from "@oscharko-dev/keiko-model-gateway";
import { reserveGatewaySpendForAttempt } from "./gateway-spend-budget.js";
import { processServerLogSink } from "./process-log-sink.js";
import { redactionSecrets } from "./redaction-secrets.js";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";

const MAX_PROVIDER_RESPONSE_BYTES = 500_000;

// The stack-frame port a readiness probe gets for a failure the model gateway records itself
// instead of rethrowing (an unreadable rejection, PR #3625 review): dist-anchored frames and the
// cause chain, never the error's message.
export function gatewayProbeErrorEvidence(error: unknown): {
  readonly frames: readonly string[];
  readonly causeChain: readonly string[];
} {
  return { frames: keikoStackFrames(error), causeChain: causeChain(error) };
}

// `transient`: the gateway answered with an overload or timeout status (`transientGatewayStatus`),
// which proves nothing about the model either way and must not be stored as a verdict.
export type GatewayToolCallingProbeStatus = "verified" | "unsupported" | "unverified" | "transient";

/** The status the stored verdict follows and the closed outcome that says how the check ended. */
export interface ToolCallingProbeVerdict {
  readonly status: GatewayToolCallingProbeStatus;
  readonly outcome: GatewayToolCallingOutcome;
}

export type GatewayToolCallingProbeFailureReporter = (error: unknown) => void;

export interface GatewayProbeSpendContext {
  readonly env: EnvSource;
  readonly capability: ModelCapability | undefined;
  readonly correlationId: string;
  readonly redactionSecrets?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExpectedToolCall(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  const choices: readonly unknown[] = payload.choices;
  const choice = choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) {
    return false;
  }
  return choice.message.tool_calls.some(expectedToolCall);
}

function expectedToolCall(call: unknown): boolean {
  if (!isRecord(call) || !isRecord(call.function) || call.function.name !== "report_readiness") {
    return false;
  }
  return hasReadinessArguments(call.function.arguments);
}

function hasReadinessArguments(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed.status === "ok" && Object.keys(parsed).length === 1;
  } catch {
    return false;
  }
}

// A gateway at peak load answers 408/429/5xx for a while; that is no verdict on the model, and a
// Workbench that treated it as one locked itself out for hours (#3591 review). 501 (not
// implemented) is the one 5xx that IS a verdict.
export function transientGatewayStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501);
}

function rejectedStatus(response: Response): GatewayToolCallingProbeStatus {
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 422 ||
    response.status === 501
  ) {
    return "unsupported";
  }
  return transientGatewayStatus(response.status) ? "transient" : "unverified";
}

// The check's first attempt is production's request: the tool offered, no forced `tool_choice`. A
// provider that cannot be forced (a reasoning model in thinking mode answers 400 to it) is judged by
// what it does without one; only a model that called none is then asked with the forced named call.
function unforcedToolCallingBody(): Readonly<Record<string, unknown>> {
  const { tool_choice: _forced, ...body } = toolCallingBody();
  return body;
}

function toolCallingBody(): Readonly<Record<string, unknown>> {
  return {
    messages: [
      { role: "system", content: "Use the provided tool for readiness checks." },
      { role: "user", content: "Call the report_readiness tool with status ok." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "report_readiness",
          description: "Report gateway readiness.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { status: { type: "string", enum: ["ok"] } },
            required: ["status"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "report_readiness" } },
  };
}

function probeBudgetRequest(provider: ModelProviderConfig): GatewayCallRequest {
  return {
    modelId: provider.modelId,
    messages: [{ role: "user", content: "Gateway readiness probe." }],
  };
}

export function reserveGatewayProbeSpend(
  provider: ModelProviderConfig,
  context: GatewayProbeSpendContext | undefined,
  request: GatewayCallRequest = probeBudgetRequest(provider),
): GatewaySpendReservation | undefined {
  return context === undefined
    ? undefined
    : reserveGatewaySpendForAttempt(
        context.env,
        context.capability,
        request,
        context.correlationId,
      );
}

export function settleGatewayProbeSpend(
  reservation: GatewaySpendReservation | undefined,
  usage: UsageMetadata | undefined,
): void {
  if (reservation !== undefined) reservation.settle(usage);
}

export function admittedGatewayProbeOutputLimit(
  reservation: GatewaySpendReservation | undefined,
  context: GatewayProbeSpendContext | undefined,
): { readonly maxOutputTokens?: number } {
  return reservation === undefined || context?.capability === undefined
    ? {}
    : { maxOutputTokens: context.capability.maxOutputTokens };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function probeUsage(
  payload: unknown,
  context: GatewayProbeSpendContext | undefined,
): UsageMetadata | undefined {
  if (context?.capability === undefined || !isRecord(payload)) return undefined;
  const usage = payload.usage;
  if (!isRecord(usage)) return undefined;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!nonNegativeInteger(promptTokens) || !nonNegativeInteger(completionTokens)) {
    return undefined;
  }
  if (promptTokens + completionTokens === 0) return undefined;
  return {
    requestId: context.correlationId,
    promptTokens,
    completionTokens,
    latencyMs: 0,
    costClass: context.capability.costClass,
  };
}

function toolProbeStreams(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  spend: GatewayProbeSpendContext | undefined,
): boolean {
  const capability =
    spend?.capability ?? config.capabilities?.find((entry) => entry.id === provider.modelId);
  return capability?.streaming === true;
}

function toolProbeBudgetRequest(
  provider: ModelProviderConfig,
  body: Readonly<Record<string, unknown>>,
): GatewayCallRequest & { readonly tools: readonly ToolDefinition[] } {
  const messages = body.messages as readonly Record<string, unknown>[];
  return {
    modelId: provider.modelId,
    messages: messages.map((message) => ({
      role: message.role as "user" | "assistant" | "system" | "tool",
      content: typeof message.content === "string" ? message.content : "",
      ...(typeof message.reasoning_content === "string"
        ? { reasoningContent: message.reasoning_content }
        : {}),
      ...(typeof message.tool_call_id === "string" ? { toolCallId: message.tool_call_id } : {}),
      ...(Array.isArray(message.tool_calls)
        ? {
            toolCalls: message.tool_calls.map(
              (call: { id: string; function: { name: string; arguments: string } }) => ({
                id: call.id,
                name: call.function.name,
                arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
              }),
            ),
          }
        : {}),
    })),
    tools: (body.tools as readonly { readonly function: ToolDefinition }[]).map(
      (tool) => tool.function,
    ),
  };
}

interface ContinuationProbeChoice {
  readonly finish_reason: unknown;
  readonly message: Record<string, unknown>;
}

function continuationProbeChoice(payload: unknown): ContinuationProbeChoice | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const choice: unknown = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  return { finish_reason: choice.finish_reason, message: choice.message };
}

function usableProbeReasoning(
  message: Record<string, unknown>,
  secrets: readonly string[],
): boolean {
  return (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content.trim().length > 0 &&
    (message.reasoning === undefined || message.reasoning === message.reasoning_content) &&
    redactContent(JSON.stringify(message), "preserve", secrets) === JSON.stringify(message)
  );
}

function continuationToolMessage(
  choice: ContinuationProbeChoice,
): Record<string, unknown> | undefined {
  const { message } = choice;
  if (
    choice.finish_reason !== "tool_calls" ||
    !Array.isArray(message.tool_calls) ||
    message.tool_calls.length !== 1
  )
    return undefined;
  const call: unknown = message.tool_calls[0];
  if (
    !expectedToolCall(call) ||
    !isRecord(call) ||
    typeof call.id !== "string" ||
    call.id.length === 0
  )
    return undefined;
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    reasoning_content: message.reasoning_content,
    tool_calls: message.tool_calls,
  };
}

function continuationProbeMessage(
  payload: unknown,
  secrets: readonly string[],
): Record<string, unknown> | undefined {
  const choice = continuationProbeChoice(payload);
  if (choice === undefined || !usableProbeReasoning(choice.message, secrets)) return undefined;
  const { message } = choice;
  if (
    choice.finish_reason === "stop" &&
    typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    (message.tool_calls === undefined ||
      message.tool_calls === null ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length === 0))
  )
    return {
      role: "assistant",
      content: message.content,
      reasoning_content: message.reasoning_content,
    };
  return continuationToolMessage(choice);
}

function expectedContinuationRound(
  assistant: Readonly<Record<string, unknown>>,
  round: number,
): boolean {
  return round === 2 ? assistant.tool_calls === undefined : assistant.tool_calls !== undefined;
}

function thinkingProbeBody(): Record<string, unknown> {
  return {
    ...toolCallingBody(),
    tool_choice: "auto",
    messages: [
      {
        role: "system",
        content:
          "Use report_readiness with status ok twice, waiting for each tool result. After the second result answer Ready without calling another tool. When the user asks to check again, call report_readiness once more.",
      },
      { role: "user", content: "Perform both readiness checks, then answer Ready." },
    ],
  };
}

function nextContinuationProbeBody(
  body: Readonly<Record<string, unknown>>,
  assistant: Readonly<Record<string, unknown>>,
  round: number,
): Record<string, unknown> {
  const tail =
    round === 2
      ? [
          {
            role: "user",
            content: "Check readiness once more by calling report_readiness with status ok.",
          },
        ]
      : [
          {
            role: "tool",
            tool_call_id: (assistant.tool_calls as { id: string }[])[0]?.id,
            content: '{"status":"ok"}',
          },
        ];
  return {
    ...body,
    messages: [...(body.messages as unknown[]), assistant, ...tail],
    tool_choice: round === 1 ? "none" : "auto",
  };
}

function probeRedactionSecrets(
  config: GatewayConfig,
  spend: GatewayProbeSpendContext | undefined,
): readonly string[] {
  return spend?.redactionSecrets ?? redactionSecrets(spend?.env ?? {}, config);
}

/** The two-step check: what the model does as production asks, then, only if it called no tool, forced. */
async function executeTwoStepToolCallingProbe(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  spend?: GatewayProbeSpendContext,
  signal?: AbortSignal,
): Promise<ToolCallingProbeVerdict> {
  const unforced = await sendGatewayToolProbe(
    config,
    provider,
    fetchImpl,
    spend,
    signal,
    unforcedToolCallingBody(),
  );
  if (unforced.status !== "verified") return verdictOfRejection(unforced.status);
  if (hasExpectedToolCall(unforced.payload))
    return { status: "verified", outcome: "called-unforced" };
  const forced = await sendGatewayToolProbe(config, provider, fetchImpl, spend, signal);
  // After an answered first step, a refused forced call is the provider declining `tool_choice`, not a
  // verdict on the model: the result stays "unverified" with its own reason, never "unsupported".
  if (forced.status === "unsupported") return { status: "unverified", outcome: "forced-refused" };
  if (forced.status !== "verified") return { status: forced.status, outcome: "inconclusive" };
  return hasExpectedToolCall(forced.payload)
    ? { status: "verified", outcome: "called-only-forced" }
    : { status: "unsupported", outcome: "no-call" };
}

function verdictOfRejection(status: GatewayToolCallingProbeStatus): ToolCallingProbeVerdict {
  return status === "unsupported"
    ? { status, outcome: "tools-refused" }
    : { status, outcome: "inconclusive" };
}

async function executeGatewayToolCallingProbe(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  spend?: GatewayProbeSpendContext,
  signal?: AbortSignal,
): Promise<ToolCallingProbeVerdict> {
  if (provider.reasoningContinuation !== "required-with-tools")
    return executeTwoStepToolCallingProbe(config, provider, fetchImpl, spend, signal);
  let body = thinkingProbeBody();
  // Two tool rounds, an ordinary assistant answer, then a later user turn with tools still present.
  for (let round = 0; round < 4; round++) {
    const result = await sendGatewayToolProbe(config, provider, fetchImpl, spend, signal, body);
    if (result.status !== "verified") return verdictOfRejection(result.status);
    const assistant = continuationProbeMessage(
      result.payload,
      probeRedactionSecrets(config, spend),
    );
    if (assistant === undefined || !expectedContinuationRound(assistant, round))
      return { status: "unverified", outcome: "inconclusive" };
    body = nextContinuationProbeBody(body, assistant, round);
  }
  return { status: "verified", outcome: "called-unforced" };
}

function probeInputFits(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  request: GatewayCallRequest & { readonly tools: readonly ToolDefinition[] },
  spend: GatewayProbeSpendContext | undefined,
): boolean {
  if (provider.reasoningContinuation === undefined) return true;
  const capability =
    spend?.capability ??
    config.capabilities?.find((candidate) => candidate.id === provider.modelId);
  return (
    capability !== undefined &&
    countGatewayPromptTokens(request, capability.tokenAccounting) <=
      deriveContextProfileFromCapability(capability).effectiveInputBudget
  );
}

async function sendGatewayToolProbe(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  spend?: GatewayProbeSpendContext,
  signal?: AbortSignal,
  body: Readonly<Record<string, unknown>> = toolCallingBody(),
): Promise<{ readonly status: GatewayToolCallingProbeStatus; readonly payload?: unknown }> {
  const budgetRequest = toolProbeBudgetRequest(provider, body);
  if (!probeInputFits(config, provider, budgetRequest, spend)) return { status: "unverified" };
  const reservation = reserveGatewayProbeSpend(provider, spend, budgetRequest);
  let response: Response;
  try {
    response = await requestGatewayReadinessChatCompletion({
      config,
      provider,
      body,
      stream: toolProbeStreams(config, provider, spend),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...admittedGatewayProbeOutputLimit(reservation, spend),
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
      ...(signal === undefined ? {} : { signal }),
      // Every attempt and compatibility retry of this probe is recorded under its correlation.
      log: processServerLogSink(),
      ...(spend === undefined ? {} : { correlationId: spend.correlationId }),
      errorEvidence: gatewayProbeErrorEvidence,
    });
  } catch (error) {
    settleGatewayProbeSpend(reservation, undefined);
    throw error;
  }
  if (!response.ok) {
    settleGatewayProbeSpend(reservation, undefined);
    return { status: rejectedStatus(response) };
  }
  let payload: unknown;
  try {
    payload = await readGatewayReadinessChatCompletionResponse(
      response,
      MAX_PROVIDER_RESPONSE_BYTES,
    );
  } catch (error) {
    settleGatewayProbeSpend(reservation, undefined);
    throw error;
  }
  settleGatewayProbeSpend(reservation, probeUsage(payload, spend));
  return { status: "verified", payload };
}

export async function probeGatewayToolCallingVerdict(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  reportFailure?: GatewayToolCallingProbeFailureReporter,
  spend?: GatewayProbeSpendContext,
  signal?: AbortSignal,
): Promise<ToolCallingProbeVerdict> {
  try {
    return await executeGatewayToolCallingProbe(config, provider, fetchImpl, spend, signal);
  } catch (error) {
    signal?.throwIfAborted();
    reportFailure?.(error);
    return { status: "unverified", outcome: "inconclusive" };
  }
}

export async function probeGatewayToolCalling(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  reportFailure?: GatewayToolCallingProbeFailureReporter,
  spend?: GatewayProbeSpendContext,
  signal?: AbortSignal,
): Promise<GatewayToolCallingProbeStatus> {
  return (
    await probeGatewayToolCallingVerdict(config, provider, fetchImpl, reportFailure, spend, signal)
  ).status;
}
