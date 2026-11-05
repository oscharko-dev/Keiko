import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

export function toolCallingConfigurationFingerprint(provider: ModelProviderConfig): string {
  // Credential header spelling controls authentication transport, not the provider protocol or its
  // tool-call semantics. Deliberately exclude it: hashing a request-supplied header name creates a
  // misleading password-hash dataflow and cannot make a capability verdict more authoritative.
  const binding = [
    provider.modelId,
    provider.baseUrl,
    provider.endpointStyle ?? "openai-compatible",
    provider.apiVersion ?? "",
    ...(provider.reasoningContinuation === undefined ? [] : [provider.reasoningContinuation]),
    // The deployment the gateway reports behind the alias (#3905). Appended only once observed, so
    // a provider whose discovery never saw one keeps the digest its earlier proofs were issued for.
    ...(provider.deploymentIdentitySha256 === undefined ? [] : [provider.deploymentIdentitySha256]),
  ];
  return sha256Hex(canonicalise(binding));
}

/** Native aliases can retain private reasoning only while every underlying model route matches. */
export function reasoningContinuationRouteDigest(
  config: GatewayConfig,
  primaryModel: string,
): string | undefined {
  if (
    !config.providers.some((provider) => provider.reasoningContinuation === "required-with-tools")
  )
    return undefined;
  const routes = config.providers
    .filter(
      (provider) =>
        provider.modelId === primaryModel ||
        provider.reasoningContinuation === "required-with-tools",
    )
    .map((provider) => [provider.modelId, toolCallingConfigurationFingerprint(provider)])
    .sort(([left = ""], [right = ""]) => (left < right ? -1 : Number(left > right)));
  return sha256Hex(canonicalise({ primaryModel, routes }));
}
