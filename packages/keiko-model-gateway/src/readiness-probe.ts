import { apiKeyHeaderValue, DEFAULT_API_KEY_HEADER_NAME } from "./config.js";
import { gatewayFetch } from "./http.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

export interface GatewayReadinessChatCompletionRequest {
  readonly config: GatewayConfig;
  readonly provider: ModelProviderConfig;
  readonly body: Readonly<Record<string, unknown>>;
  readonly stream?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly maxResponseBytes?: number | undefined;
}

function providerHeaders(provider: ModelProviderConfig): Record<string, string> {
  const headerName = provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
  return {
    "content-type": "application/json",
    [headerName]: apiKeyHeaderValue(headerName, provider.apiKey),
  };
}

// Gateway-owned raw chat-completions probe for operational readiness checks. The server needs a raw
// provider-shaped response to verify streaming/tool/schema/multimodal capabilities, but credentialed
// HTTP egress still stays inside the model-gateway package and uses the central config-level egress
// policy instead of a caller-selected provider-local policy.
export function requestGatewayReadinessChatCompletion(
  request: GatewayReadinessChatCompletionRequest,
): Promise<Response> {
  const { config, provider, body, stream, fetchImpl, maxResponseBytes } = request;
  const requestBody = JSON.stringify({
    model: provider.modelId,
    ...body,
    ...(stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
  return gatewayFetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: providerHeaders(provider),
    body: requestBody,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    timeoutMs: provider.timeoutMs,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    ...(config.egress !== undefined ? { egress: config.egress } : {}),
  });
}
