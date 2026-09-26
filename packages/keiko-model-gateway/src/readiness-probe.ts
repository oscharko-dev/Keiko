import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  trimTrailingAzureOpenAiSegment,
  trimTrailingSlash,
} from "./config.js";
import { gatewayFetch } from "./http.js";
import {
  logEndpointHost,
  logModelId,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogSink,
} from "./observability.js";
import { providerOutputTokenLimit, requiresNoReasoningWithTools } from "./output-token-limit.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

// A strict OpenAI-compatible chat shape rejects a malformed request with 400 or 422 — the same
// two statuses the production adapter's own compatibility retry gates on (isStrictChatShapeRejection).
function isStrictChatShapeRejectionStatus(status: number): boolean {
  return status === 400 || status === 422;
}

export interface GatewayReadinessChatCompletionRequest {
  readonly config: GatewayConfig;
  readonly provider: ModelProviderConfig;
  readonly body: Readonly<Record<string, unknown>>;
  readonly stream?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  // The caller's activity-log port and the probe's correlation id: every attempt and every
  // compatibility retry of one probe is recorded under it (PR #3625 review).
  readonly log?: ModelGatewayLogSink | undefined;
  readonly correlationId?: string | undefined;
}

// PR #3625 review: which field a readiness probe left out on a compatibility retry, the status that
// made it retry and the status the retry got, joined to the probe by its correlation id. Body-free:
// an endpoint digest and the safe model id only.
const READINESS_COMPATIBILITY_RETRY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.readiness.compatibility-retry",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "readiness-probe.logReadinessCompatibilityRetry",
  fields: {
    endpointDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    omittedField: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["stream_options", "max_tokens", "max_completion_tokens"],
    },
    rejectedStatus: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-chat-provider-call"],
  proofIds: ["gateway.readiness.compatibility-retry.line"],
  releaseImpact: "patch",
});

type ReadinessOmittedField = "stream_options" | "max_tokens" | "max_completion_tokens";

function readinessLog(request: GatewayReadinessChatCompletionRequest): ModelGatewayLogSink {
  return withCorrelationId(resolveLogSink(request.log), request.correlationId);
}

function logReadinessCompatibilityRetry(
  request: GatewayReadinessChatCompletionRequest,
  omittedField: ReadinessOmittedField,
  rejectedStatus: number,
  retry: Response,
): void {
  const url = readinessChatCompletionsUrl(request.provider);
  readinessLog(request).write(
    activityLogEvent(
      READINESS_COMPATIBILITY_RETRY_OPERATION,
      {
        level: retry.ok ? "info" : "warn",
        status: retry.status,
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
      },
      {
        endpointDigest: sha256Hex(logEndpointHost(url) ?? "invalid-endpoint"),
        modelId: logModelId(request.provider.modelId),
        omittedField,
        rejectedStatus,
      },
    ),
  );
}

function providerHeaders(provider: ModelProviderConfig): Record<string, string> {
  const headerName = provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
  return {
    "content-type": "application/json",
    [headerName]: apiKeyHeaderValue(headerName, provider.apiKey),
  };
}

// Mirrors openai-adapter.ts's chatCompletionsUrl exactly, including the #3643 fix: the Azure
// branch strips a base URL's own trailing "/openai" segment before appending one, so setup/
// readiness and production share the same corrected URL instead of the same malformed one.
function readinessChatCompletionsUrl(provider: ModelProviderConfig): string {
  if (provider.endpointStyle === "azure-openai-deployment") {
    const trimmed = trimTrailingAzureOpenAiSegment(provider.baseUrl);
    return `${trimmed}/openai/deployments/${encodeURIComponent(
      provider.modelId,
    )}/chat/completions?api-version=${encodeURIComponent(provider.apiVersion ?? "")}`;
  }
  return `${trimTrailingSlash(provider.baseUrl)}/chat/completions`;
}

function withoutOutputTokenLimits(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const bounded = { ...body };
  delete bounded.max_tokens;
  delete bounded.max_completion_tokens;
  return bounded;
}

// #3640: mirrors openai-adapter.ts's reasoningEffortField exactly — a GPT-5.6 deployment requires
// reasoning_effort: "none" whenever a Chat Completions request includes function tools. The forced
// tool-calling probe (packages/keiko-server's gateway-tool-calling-probe.ts) sends
// `tools`/`tool_choice` with no effort at all; without this override every such probe against a
// GPT-5.6 deployment is rejected and it is recorded as not supporting tool calling, even though a
// plain chat probe (no tools) succeeds. Other models are probed as before.
function readinessReasoningEffortOverride(
  body: Readonly<Record<string, unknown>>,
  provider: ModelProviderConfig,
): { readonly reasoning_effort?: "none" } {
  return body.tools !== undefined && requiresNoReasoningWithTools(provider.modelId)
    ? { reasoning_effort: "none" }
    : {};
}

function readinessRequestBody(
  request: GatewayReadinessChatCompletionRequest,
  includeUsage: boolean,
): string {
  const { provider, body, stream, maxOutputTokens } = request;
  return JSON.stringify({
    model: provider.modelId,
    ...withoutOutputTokenLimits(body),
    ...providerOutputTokenLimit(maxOutputTokens, provider),
    ...readinessReasoningEffortOverride(body, provider),
    ...(stream === true
      ? { stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) }
      : {}),
  });
}

function dispatchReadinessChatCompletion(
  request: GatewayReadinessChatCompletionRequest,
  includeUsage: boolean,
): Promise<Response> {
  const { config, provider, fetchImpl, maxResponseBytes, correlationId } = request;
  return gatewayFetch(readinessChatCompletionsUrl(provider), {
    method: "POST",
    headers: providerHeaders(provider),
    body: readinessRequestBody(request, includeUsage),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    timeoutMs: provider.timeoutMs,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    ...(config.egress !== undefined ? { egress: config.egress } : {}),
    ...(request.log === undefined ? {} : { log: request.log }),
    ...(correlationId === undefined ? {} : { logContext: { correlationId } }),
  });
}

// #3641: a streamed probe that a strict gateway rejects (400/422) is retried once without the
// optional `stream_options` field, like the production adapter's own compatibility fallback
// (OpenAiAdapter.dispatchCompatibleStream); otherwise a gateway whose production traffic streams
// after that fallback was recorded as "streaming unsupported" by this probe alone. Every such
// rejection is retried, not only one naming the field, so the probe never parses an untrusted
// error body: a rejection for any other reason comes back unchanged and keeps its verdict.
async function requestWithStreamFallback(
  request: GatewayReadinessChatCompletionRequest,
): Promise<Response> {
  const first = await dispatchReadinessChatCompletion(request, true);
  if (request.stream !== true || first.ok || !isStrictChatShapeRejectionStatus(first.status)) {
    return first;
  }
  await first.body?.cancel();
  const retry = await dispatchReadinessChatCompletion(request, false);
  logReadinessCompatibilityRetry(request, "stream_options", first.status, retry);
  return retry;
}

// #3639: the default output-token field follows the model family, which a deployment alias hides
// (a GPT-5 deployment named "prod-chat" is sent max_tokens and rejects it). The same request with
// the other field, when the probe sent one it chose itself; an operator's explicit field stays.
function withOtherOutputTokenField(
  request: GatewayReadinessChatCompletionRequest,
): GatewayReadinessChatCompletionRequest | undefined {
  const { provider, maxOutputTokens } = request;
  if (maxOutputTokens === undefined || provider.outputTokenParameter !== undefined) {
    return undefined;
  }
  const sent = providerOutputTokenLimit(maxOutputTokens, provider);
  const other = "max_completion_tokens" in sent ? "max_tokens" : "max_completion_tokens";
  return { ...request, provider: { ...provider, outputTokenParameter: other } };
}

// Gateway-owned raw chat-completions probe for operational readiness checks. The server needs a raw
// provider-shaped response to verify streaming/tool/schema/multimodal capabilities, but credentialed
// HTTP egress still stays inside the model-gateway package and uses the central config-level egress
// policy instead of a caller-selected provider-local policy.
//
// A strict rejection is also retried once with the other output-token field (#3639), like the
// production adapter's fallback (OpenAiAdapter.dispatchWithOutputTokenFallback) but, as above,
// without parsing the error body: any other rejection comes back again and keeps its verdict.
export async function requestGatewayReadinessChatCompletion(
  request: GatewayReadinessChatCompletionRequest,
): Promise<Response> {
  const answer = await requestWithStreamFallback(request);
  const other = withOtherOutputTokenField(request);
  if (other === undefined || answer.ok || !isStrictChatShapeRejectionStatus(answer.status)) {
    return answer;
  }
  await answer.body?.cancel();
  const retry = await requestWithStreamFallback(other);
  logReadinessCompatibilityRetry(request, sentOutputTokenField(request), answer.status, retry);
  return retry;
}

function sentOutputTokenField(
  request: GatewayReadinessChatCompletionRequest,
): "max_tokens" | "max_completion_tokens" {
  return "max_completion_tokens" in
    providerOutputTokenLimit(request.maxOutputTokens, request.provider)
    ? "max_completion_tokens"
    : "max_tokens";
}
