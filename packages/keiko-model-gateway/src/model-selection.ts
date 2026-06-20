import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  isLikelyEmbeddingModelId,
  listCapabilities,
  selectCompletionModelFromCapabilities,
  type CompletionSelectionOptions,
} from "./capabilities.js";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  CompletionModelSelection,
  GatewayConfig,
  ModelCapability,
  ModelKind,
} from "./types.js";

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
  return (
    config.capabilities?.find((capability) => capability.id === modelId) ??
    listCapabilities().find((capability) => capability.id === modelId) ??
    (config.providers.some((provider) => provider.modelId === modelId)
      ? isLikelyEmbeddingModelId(modelId)
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

// Completion-oriented model selection (Issue #1210, ADR-0042 D5). Resolves the configured
// capabilities and applies the infilling-aware decision tree (as-you-type → manual → deterministic)
// from `selectCompletionModelFromCapabilities`. Only configured providers are eligible, so a
// capability that names no provider can never be elected. The result is content-free.
export function selectCompletionModel(
  config: GatewayConfig,
  options: CompletionSelectionOptions = {},
): CompletionModelSelection {
  return selectCompletionModelFromCapabilities(listConfiguredCapabilities(config), options);
}
