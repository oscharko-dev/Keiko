import {
  createDefaultChatCapability,
  createDefaultCodexLocalSessionCapability,
  createDefaultEmbeddingCapability,
  isLikelyEmbeddingModelId,
  listCapabilities,
} from "./capabilities.js";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayConfig, ModelCapability, ModelKind } from "./types.js";
import { isOpenAiCodexLocalSessionProviderConfig } from "./types.js";

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;

export interface ModelSelectionQuery {
  readonly kind: ModelKind;
  readonly toolCalling?: boolean | undefined;
  readonly structuredOutput?: boolean | undefined;
  readonly minContextWindow?: number | undefined;
  // Issue #810: require image-input (multimodal) capability. When true, only configured
  // models that advertise supportsImageInput === true are eligible.
  readonly supportsImageInput?: boolean | undefined;
}

function matches(capability: ModelCapability, query: ModelSelectionQuery): boolean {
  if (capability.kind !== query.kind) {
    return false;
  }
  if (query.toolCalling === true && !capability.toolCalling) {
    return false;
  }
  if (query.structuredOutput === true && !capability.structuredOutput) {
    return false;
  }
  if (query.supportsImageInput === true && !capability.supportsImageInput) {
    return false;
  }
  if (query.minContextWindow !== undefined && capability.contextWindow < query.minContextWindow) {
    return false;
  }
  return true;
}

export function assertConfiguredModel(config: GatewayConfig, modelId: string): void {
  if (!config.providers.some((provider) => provider.modelId === modelId)) {
    throw new ConfigInvalidError(`model '${modelId}' is not configured as a provider`);
  }
}

export function findConfiguredCapability(
  config: GatewayConfig,
  modelId: string,
): ModelCapability | undefined {
  const configuredProvider = config.providers.find((provider) => provider.modelId === modelId);
  return (
    config.capabilities?.find((capability) => capability.id === modelId) ??
    listCapabilities().find((capability) => capability.id === modelId) ??
    (configuredProvider !== undefined
      ? isOpenAiCodexLocalSessionProviderConfig(configuredProvider)
        ? createDefaultCodexLocalSessionCapability(modelId)
        : isLikelyEmbeddingModelId(modelId)
        ? createDefaultEmbeddingCapability(modelId)
        : createDefaultChatCapability(modelId)
      : undefined)
  );
}

export function listConfiguredCapabilities(config: GatewayConfig): readonly ModelCapability[] {
  return config.providers
    .map((provider) => findConfiguredCapability(config, provider.modelId))
    .filter((capability): capability is ModelCapability => capability !== undefined);
}

export function selectConfiguredModel(
  config: GatewayConfig,
  query: ModelSelectionQuery,
): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!matches(capability, query)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}
