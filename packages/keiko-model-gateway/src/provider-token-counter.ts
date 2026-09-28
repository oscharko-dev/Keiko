import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  activityLogErrorKind,
  GATEWAY_FAILURE_EVIDENCE_FIELDS,
  gatewayFailureEvidence,
  type ModelGatewayLogContext,
  type ModelGatewayLogSink,
} from "./observability.js";
import {
  AuthenticationError,
  ConfigInvalidError,
  ProviderError,
} from "@oscharko-dev/keiko-security/errors/gateway";
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
  try {
    const response = await fetchTokenCount(request, provider, log, fetchImpl);
    if (!response.ok) {
      await response.body?.cancel();
      const error =
        response.status === 401 || response.status === 403
          ? new AuthenticationError("token counter access denied")
          : new ProviderError("token counter unavailable", response.status);
      logCounterFailure(log, request.logContext, error);
      return { status: "unavailable" };
    }
    const result = parseTokenCount(await readJsonCapped(response, 16_384));
    if (result.status === "invalid")
      logCounterFailure(
        log,
        request.logContext,
        new ConfigInvalidError("invalid token counter response"),
      );
    return result;
  } catch (error) {
    logCounterFailure(log, request.logContext, error);
    return { status: "unavailable" };
  }
}

async function fetchTokenCount(
  request: GatewayCallRequest & GatewayPromptTokenInput,
  provider: ModelProviderConfig,
  log: ModelGatewayLogSink,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(5_000),
    ...(request.cancellationSignal === undefined ? [] : [request.cancellationSignal]),
  ]);
  const header = (provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME).toLowerCase();
  return gatewayFetch(tokenCounterUrl(provider.baseUrl), {
    method: "POST",
    headers: {
      [header]: apiKeyHeaderValue(header, provider.apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.modelId,
      messages: request.messages.map(openAiCompatiblePromptMessage),
      ...(request.tools === undefined ? {} : { tools: openAiCompatiblePromptTools(request.tools) }),
    }),
    signal,
    egress: provider.egress,
    log,
    logContext: request.logContext,
    fetchImpl,
  });
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
    ...GATEWAY_FAILURE_EVIDENCE_FIELDS,
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
        correlationId:
          context?.correlationId ?? log.correlationId ?? ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
        errorKind: activityLogErrorKind(error),
      },
      {
        fallback: "local-estimate",
        completeness: "complete",
        loss: "none",
        ...gatewayFailureEvidence(log, error),
      },
    ),
  );
}
