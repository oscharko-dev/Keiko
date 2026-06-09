// Internal provider-runtime registry for productive model dispatch (#462).
// Keeps generic Gateway orchestration free of provider-specific branching by
// resolving providerType -> runtime provider config + adapter factory in one place.

import type { ProviderType } from "@oscharko-dev/keiko-contracts";
import { UnknownModelError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  createCodexLocalSessionRuntimeResolver,
  type CodexLocalSessionRuntimeResolver,
} from "./codex-local-session.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import {
  isGatewayOpenAiCompatibleProvider,
  isOpenAiCodexLocalSessionProvider,
  providerTypeOf,
  type CostClass,
  type ModelProviderConfig,
  type ProviderAdapter,
  type RuntimeDispatchProviderConfig,
} from "./types.js";

export interface ProviderRuntimeFactoryDeps {
  readonly adapterOverride?: ProviderAdapter | undefined;
  readonly requestId: string;
  readonly costClass: CostClass;
  readonly now: () => number;
}

export interface ResolvedProviderRuntime {
  readonly provider: RuntimeDispatchProviderConfig;
  readonly adapter: ProviderAdapter;
}

interface ProviderRuntimeRegistration {
  readonly providerType: ProviderType;
  readonly selectRuntimeProvider: (
    provider: ModelProviderConfig,
  ) => RuntimeDispatchProviderConfig | undefined;
  readonly createAdapter?: ((deps: ProviderRuntimeFactoryDeps) => ProviderAdapter) | undefined;
}

export interface ProviderRuntimeRegistry {
  readonly registrations: readonly ProviderRuntimeRegistration[];
  readonly resolve: (
    modelId: string,
    provider: ModelProviderConfig,
    deps: ProviderRuntimeFactoryDeps,
  ) => ResolvedProviderRuntime;
}

export interface ProviderRuntimeRegistryDeps {
  readonly localSessionResolver?: CodexLocalSessionRuntimeResolver | undefined;
}

function notYetWired(modelId: string, providerType: ProviderType): never {
  throw new UnknownModelError(
    `model '${modelId}' is configured for provider type '${providerType}'; runtime dispatch for that provider type is not wired yet`,
  );
}

function gatewayOpenAiCompatibleRegistration(): ProviderRuntimeRegistration {
  return {
    providerType: "gateway-openai-compatible",
    selectRuntimeProvider: (provider) =>
      isGatewayOpenAiCompatibleProvider(provider) ? provider : undefined,
    createAdapter: (deps) =>
      deps.adapterOverride ??
      new OpenAiAdapter({
        requestId: deps.requestId,
        costClass: deps.costClass,
        now: deps.now,
      }),
  };
}

function localSessionRegistrationWithDeps(
  deps: ProviderRuntimeRegistryDeps,
): ProviderRuntimeRegistration {
  const resolveLocalSession = deps.localSessionResolver ?? createCodexLocalSessionRuntimeResolver();
  return {
    providerType: "openai-codex-local-session",
    selectRuntimeProvider: (provider) =>
      isOpenAiCodexLocalSessionProvider(provider) ? resolveLocalSession(provider) : undefined,
    createAdapter: (factoryDeps) =>
      factoryDeps.adapterOverride ??
      new OpenAiAdapter({
        requestId: factoryDeps.requestId,
        costClass: factoryDeps.costClass,
        now: factoryDeps.now,
      }),
  };
}

export function createDefaultProviderRuntimeRegistry(
  deps: ProviderRuntimeRegistryDeps = {},
): ProviderRuntimeRegistry {
  const registrations = Object.freeze([
    gatewayOpenAiCompatibleRegistration(),
    localSessionRegistrationWithDeps(deps),
  ]);
  const byType = new Map(registrations.map((registration) => [registration.providerType, registration]));
  return Object.freeze({
    registrations,
    resolve: (
      modelId: string,
      provider: ModelProviderConfig,
      deps: ProviderRuntimeFactoryDeps,
    ): ResolvedProviderRuntime => {
      const providerType = providerTypeOf(provider);
      const registration = byType.get(providerType);
      if (registration === undefined) {
        return notYetWired(modelId, providerType);
      }
      const runtimeProvider = registration.selectRuntimeProvider(provider);
      if (runtimeProvider === undefined || registration.createAdapter === undefined) {
        return notYetWired(modelId, providerType);
      }
      return {
        provider: runtimeProvider,
        adapter: registration.createAdapter(deps),
      };
    },
  });
}
