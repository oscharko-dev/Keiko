import { randomUUID } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  activityLogErrorKind,
  type ModelGatewayLogContext,
  type ModelGatewayLogSink,
} from "./observability.js";
import { gatewayFetch, readJsonCapped } from "./http.js";
import { apiKeyHeaderValue, DEFAULT_API_KEY_HEADER_NAME } from "./config.js";
import {
  openAiCompatiblePromptMessage,
  openAiCompatiblePromptTools,
  type GatewayPromptTokenInput,
} from "./prompt-token-accounting.js";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelProviderConfig } from "./types.js";

export interface ProviderTokenCount {
  readonly status: "disabled" | "available" | "unavailable" | "invalid";
  readonly tokens?: number | undefined;
  readonly tokenizer?: "openai" | "huggingface" | "other" | "unknown" | undefined;
}

function tokenCounterUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/v1\/?$/u, "").replace(/\/$/u, "")}/utils/token_counter`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseTokenCount(value: unknown): ProviderTokenCount {
  if (value === null || typeof value !== "object") return { status: "invalid" };
  const record = value as Record<string, unknown>;
  if (record.error === true) return { status: "invalid" };
  const tokens = record.total_tokens;
  return typeof tokens === "number" &&
    Number.isSafeInteger(tokens) &&
    tokens >= 0 &&
    tokens <= 1_000_000_000
    ? { status: "available", tokens, tokenizer: tokenizerSource(record.tokenizer_type) }
    : { status: "invalid" };
}

/** Counting uses the same configured host, credentials, cancellation and HTTP egress policy as
 * generation. LiteLLM can itself fall back to a tokenizer; this is reported, never called exact. */
export async function countProviderPromptTokens(
  request: GatewayCallRequest & GatewayPromptTokenInput,
  provider: ModelProviderConfig,
  log: ModelGatewayLogSink,
  fetchImpl?: typeof fetch,
): Promise<ProviderTokenCount> {
  if (provider.tokenCounter !== "litellm") return { status: "disabled" };
  if (request.cancellationSignal?.aborted === true) return { status: "unavailable" };
  const signal = AbortSignal.any([
    AbortSignal.timeout(5_000),
    ...(request.cancellationSignal === undefined ? [] : [request.cancellationSignal]),
  ]);
  const header = (provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME).toLowerCase();
  try {
    const response = await gatewayFetch(tokenCounterUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        [header]: apiKeyHeaderValue(header, provider.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages.map(openAiCompatiblePromptMessage),
        ...(request.tools === undefined
          ? {}
          : { tools: openAiCompatiblePromptTools(request.tools) }),
      }),
      signal,
      egress: provider.egress,
      log,
      logContext: request.logContext,
      fetchImpl,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: "unavailable" };
    }
    return parseTokenCount(await readJsonCapped(response, 16_384));
  } catch (error) {
    logCounterFailure(log, request.logContext, error);
    return { status: "unavailable" };
  }
}

function tokenizerSource(value: unknown): NonNullable<ProviderTokenCount["tokenizer"]> {
  if (value === "openai_tokenizer") return "openai";
  if (value === "huggingface_tokenizer") return "huggingface";
  return typeof value === "string" ? "other" : "unknown";
}

const COUNTER_FAILED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.prompt.counter-failed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "provider-token-counter.logCounterFailure",
  fields: {
    fallback: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["local-estimate"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-context-admission"],
  proofIds: ["gateway.prompt.counter-failed.fallback"],
  releaseImpact: "patch",
});

function logCounterFailure(
  log: ModelGatewayLogSink,
  context: ModelGatewayLogContext | undefined,
  error: unknown,
): void {
  log.write(
    activityLogEvent(
      COUNTER_FAILED,
      {
        correlationId: context?.correlationId ?? log.correlationId ?? randomUUID(),
        errorKind: activityLogErrorKind(error),
      },
      { fallback: "local-estimate", completeness: "complete", loss: "none" },
    ),
  );
}
