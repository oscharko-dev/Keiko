import { trimTrailingSlash } from "./config.js";
import type { ProviderEndpointStyle } from "./types.js";

interface SpeechProviderEndpoint {
  readonly endpoint: string;
  readonly endpointStyle?: ProviderEndpointStyle;
  readonly modelId: string;
  readonly apiVersion?: string;
}

type SpeechOperation = "transcriptions" | "speech";

function azureSpeechUrl(
  endpoint: string,
  modelId: string,
  apiVersion: string,
  operation: SpeechOperation,
): string {
  const trimmed = trimTrailingSlash(endpoint);
  return `${trimmed}/openai/deployments/${encodeURIComponent(
    modelId,
  )}/audio/${operation}?api-version=${encodeURIComponent(apiVersion)}`;
}

export function speechProviderUrl(
  request: SpeechProviderEndpoint,
  operation: SpeechOperation,
): string {
  if (request.endpointStyle === "azure-openai-deployment") {
    return azureSpeechUrl(request.endpoint, request.modelId, request.apiVersion ?? "", operation);
  }
  return `${trimTrailingSlash(request.endpoint)}/audio/${operation}`;
}
