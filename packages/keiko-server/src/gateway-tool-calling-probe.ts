import {
  requestGatewayReadinessChatCompletion,
  type EnvSource,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewaySpendReservation,
  type ModelCapability,
  type ModelProviderConfig,
  type UsageMetadata,
} from "@oscharko-dev/keiko-model-gateway";
import { readJsonCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { reserveGatewaySpendForAttempt } from "./gateway-spend-budget.js";
import { processServerLogSink } from "./process-log-sink.js";
import { causeChain, keikoStackFrames } from "./observability/stack-frames.js";

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

export type GatewayToolCallingProbeFailureReporter = (error: unknown) => void;

export interface GatewayProbeSpendContext {
  readonly env: EnvSource;
  readonly capability: ModelCapability | undefined;
  readonly correlationId: string;
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
): GatewaySpendReservation | undefined {
  return context === undefined
    ? undefined
    : reserveGatewaySpendForAttempt(
        context.env,
        context.capability,
        probeBudgetRequest(provider),
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

async function executeGatewayToolCallingProbe(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  spend?: GatewayProbeSpendContext,
): Promise<GatewayToolCallingProbeStatus> {
  const reservation = reserveGatewayProbeSpend(provider, spend);
  let response: Response;
  try {
    response = await requestGatewayReadinessChatCompletion({
      config,
      provider,
      body: toolCallingBody(),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...admittedGatewayProbeOutputLimit(reservation, spend),
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
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
    return rejectedStatus(response);
  }
  let payload: unknown;
  try {
    payload = await readJsonCapped(response, MAX_PROVIDER_RESPONSE_BYTES);
  } catch (error) {
    settleGatewayProbeSpend(reservation, undefined);
    throw error;
  }
  settleGatewayProbeSpend(reservation, probeUsage(payload, spend));
  return hasExpectedToolCall(payload) ? "verified" : "unsupported";
}

export async function probeGatewayToolCalling(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
  reportFailure?: GatewayToolCallingProbeFailureReporter,
  spend?: GatewayProbeSpendContext,
): Promise<GatewayToolCallingProbeStatus> {
  try {
    return await executeGatewayToolCallingProbe(config, provider, fetchImpl, spend);
  } catch (error) {
    reportFailure?.(error);
    return "unverified";
  }
}
