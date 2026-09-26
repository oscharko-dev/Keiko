import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  trimTrailingAzureOpenAiSegment,
  trimTrailingSlash,
} from "./config.js";
import { gatewayFetch, readJsonCapped } from "./http.js";
import {
  activityLogErrorKind,
  logEndpointHost,
  logModelId,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogSink,
} from "./observability.js";
import {
  OTHER_OUTPUT_TOKEN_FIELD,
  providerOutputTokenLimit,
  rejectsOutputTokenField,
  requiresNoReasoningWithTools,
  type OutputTokenField,
} from "./output-token-limit.js";
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

// PR #3625 review: a readiness probe's compatibility retry, recorded BEFORE it is sent — which field
// it leaves out and the status that made it retry — so a retry that then throws is still
// reconstructable; the retry's own answer is the correlated fetch line after it, and a retry that
// throws adds the failed line below. Body-free: an endpoint digest and the safe model id only.
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

// The compatibility retry failed: the gateway rejected it too (with the status it answered) or it
// threw (a timeout, a transport or egress failure). Which field it had left out and the closed class
// of the failure, under the probe's correlation id.
const READINESS_COMPATIBILITY_RETRY_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.readiness.compatibility-retry.failed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "readiness-probe.logReadinessCompatibilityRetryFailed",
  fields: {
    endpointDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    omittedField: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["stream_options", "max_tokens", "max_completion_tokens"],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-chat-provider-call"],
  proofIds: ["gateway.readiness.compatibility-retry.failed.line"],
  releaseImpact: "patch",
});

// PR #3625 review: a rejected probe the probe did NOT answer with the other output-token field,
// because the rejection named another cause or could not be read — so an unrelated rejection never
// costs a second paid request, and the log says why no field retry followed.
const READINESS_COMPATIBILITY_RETRY_SKIPPED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.readiness.compatibility-retry.skipped",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "readiness-probe.logReadinessFieldRetrySkipped",
  fields: {
    endpointDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    sentField: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["max_tokens", "max_completion_tokens"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["other-cause", "unreadable-rejection"],
    },
    rejectedStatus: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-chat-provider-call"],
  proofIds: ["gateway.readiness.compatibility-retry.skipped.line"],
  releaseImpact: "patch",
});

// A provider rejection body is small; anything larger is not an error document worth reading.
const READINESS_REJECTION_MAX_BYTES = 64 * 1024;

type ReadinessOmittedField = "stream_options" | "max_tokens" | "max_completion_tokens";

function readinessLog(request: GatewayReadinessChatCompletionRequest): ModelGatewayLogSink {
  return withCorrelationId(resolveLogSink(request.log), request.correlationId);
}

function readinessRetryFields(
  request: GatewayReadinessChatCompletionRequest,
  omittedField: ReadinessOmittedField,
): {
  readonly endpointDigest: string;
  readonly modelId: string;
  readonly omittedField: ReadinessOmittedField;
} {
  const url = readinessChatCompletionsUrl(request.provider);
  return {
    endpointDigest: sha256Hex(logEndpointHost(url) ?? "invalid-endpoint"),
    modelId: logModelId(request.provider.modelId),
    omittedField,
  };
}

function correlationOf(request: GatewayReadinessChatCompletionRequest): {
  readonly correlationId?: string;
} {
  return request.correlationId === undefined ? {} : { correlationId: request.correlationId };
}

function logReadinessCompatibilityRetry(
  request: GatewayReadinessChatCompletionRequest,
  omittedField: ReadinessOmittedField,
  rejectedStatus: number,
): void {
  readinessLog(request).write(
    activityLogEvent(
      READINESS_COMPATIBILITY_RETRY_OPERATION,
      { level: "info", ...correlationOf(request) },
      { ...readinessRetryFields(request, omittedField), rejectedStatus },
    ),
  );
}

interface ReadinessRetryFailure {
  readonly errorKind: ActivityLogErrorKind;
  readonly status?: number;
}

function logReadinessCompatibilityRetryFailed(
  request: GatewayReadinessChatCompletionRequest,
  omittedField: ReadinessOmittedField,
  failure: ReadinessRetryFailure,
): void {
  readinessLog(request).write(
    activityLogEvent(
      READINESS_COMPATIBILITY_RETRY_FAILED_OPERATION,
      {
        level: "warn",
        ...correlationOf(request),
        errorKind: failure.errorKind,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      },
      readinessRetryFields(request, omittedField),
    ),
  );
}

// The closed class of a status a retried probe was answered with.
function readinessStatusErrorKind(status: number): ActivityLogErrorKind {
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "permission-denied";
  if (status === 409) return "conflict";
  return status >= 500 ? "unavailable" : "invalid-request";
}

function logReadinessFieldRetrySkipped(
  request: GatewayReadinessChatCompletionRequest,
  sentField: OutputTokenField,
  rejectedStatus: number,
  unreadable?: { readonly errorKind: ActivityLogErrorKind },
): void {
  const url = readinessChatCompletionsUrl(request.provider);
  readinessLog(request).write(
    activityLogEvent(
      READINESS_COMPATIBILITY_RETRY_SKIPPED_OPERATION,
      unreadable === undefined
        ? { level: "info", ...correlationOf(request) }
        : { level: "warn", ...correlationOf(request), errorKind: unreadable.errorKind },
      {
        endpointDigest: sha256Hex(logEndpointHost(url) ?? "invalid-endpoint"),
        modelId: logModelId(request.provider.modelId),
        sentField,
        reason: unreadable === undefined ? "other-cause" : "unreadable-rejection",
        rejectedStatus,
      },
    ),
  );
}

// A rejected answer handed back with its status and headers but without its body: readiness reads
// only the status of a rejected answer.
function withoutBody(answer: Response): Response {
  return new Response(null, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers,
  });
}

// The rejection read once from the answer itself, bounded, never from a clone: a clone tees the
// body, and cancelling one tee branch waits until the other is cancelled too, so a capped or failed
// read would stall on an original nobody reads (PR #3625 review). An unreadable rejection is
// recorded with its closed error kind.
async function readRejection(
  request: GatewayReadinessChatCompletionRequest,
  answer: Response,
  sentField: OutputTokenField,
): Promise<{ readonly payload: unknown } | undefined> {
  try {
    return { payload: await readJsonCapped(answer, READINESS_REJECTION_MAX_BYTES) };
  } catch (error) {
    logReadinessFieldRetrySkipped(request, sentField, answer.status, {
      errorKind: activityLogErrorKind(error),
    });
    return undefined;
  }
}

// Records the retry before sending it, and its failure if it throws, then rethrows.
async function sendReadinessRetry(
  request: GatewayReadinessChatCompletionRequest,
  omittedField: ReadinessOmittedField,
  rejectedStatus: number,
  send: () => Promise<Response>,
): Promise<Response> {
  logReadinessCompatibilityRetry(request, omittedField, rejectedStatus);
  let retry: Response;
  try {
    retry = await send();
  } catch (error) {
    logReadinessCompatibilityRetryFailed(request, omittedField, {
      errorKind: activityLogErrorKind(error),
    });
    throw error;
  }
  if (!retry.ok) {
    logReadinessCompatibilityRetryFailed(request, omittedField, {
      errorKind: readinessStatusErrorKind(retry.status),
      status: retry.status,
    });
  }
  return retry;
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
  return sendReadinessRetry(request, "stream_options", first.status, () =>
    dispatchReadinessChatCompletion(request, false),
  );
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
  const other = OTHER_OUTPUT_TOKEN_FIELD[sentOutputTokenField(request)];
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
  const sentField = sentOutputTokenField(request);
  const rejection = await readRejection(request, answer, sentField);
  if (rejection === undefined) return withoutBody(answer);
  if (!rejectsOutputTokenField(rejection.payload, sentField)) {
    logReadinessFieldRetrySkipped(request, sentField, answer.status);
    return withoutBody(answer);
  }
  return sendReadinessRetry(request, sentField, answer.status, () =>
    requestWithStreamFallback(other),
  );
}

function sentOutputTokenField(request: GatewayReadinessChatCompletionRequest): OutputTokenField {
  return "max_completion_tokens" in
    providerOutputTokenLimit(request.maxOutputTokens, request.provider)
    ? "max_completion_tokens"
    : "max_tokens";
}
