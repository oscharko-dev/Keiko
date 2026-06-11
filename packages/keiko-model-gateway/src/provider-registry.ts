import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { OpenAiAdapter, type AdapterDeps } from "./openai-adapter.js";
import type {
  GatewayOpenAiCompatibleProviderConfig,
  ModelProviderConfig,
  ProviderAdapter,
  ProviderAdapterFactory,
  ProviderAdapterFactoryContext,
  ProviderRegistry,
} from "./types.js";
import { isGatewayOpenAiCompatibleProviderConfig } from "./types.js";

class UnsupportedProviderAdapter implements ProviderAdapter {
  constructor(readonly providerType: ModelProviderConfig["providerType"]) {}

  call(): Promise<never> {
    return Promise.reject(
      new ConfigInvalidError(
        `provider type '${this.providerType}' is configured but no runtime adapter is registered yet`,
      ),
    );
  }

  callStream(): AsyncIterable<never> {
    const error = new ConfigInvalidError(
      `provider type '${this.providerType}' is configured but no runtime adapter is registered yet`,
    );
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next(): Promise<IteratorResult<never>> {
            return Promise.reject(error);
          },
        };
      },
    };
  }
}

function openAiAdapterFactory(context: ProviderAdapterFactoryContext): ProviderAdapter {
  const deps: AdapterDeps = {
    requestId: context.requestId,
    costClass: context.costClass,
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
  };
  return new OpenAiAdapter(deps);
}

function unsupportedAdapterFactory(
  providerType: ModelProviderConfig["providerType"],
): ProviderAdapterFactory {
  return () => new UnsupportedProviderAdapter(providerType);
}

export interface StaticProviderRegistryOptions {
  readonly adapters?: ReadonlyMap<string, ProviderAdapterFactory> | undefined;
}

export class StaticProviderRegistry implements ProviderRegistry {
  private readonly adapters: ReadonlyMap<string, ProviderAdapterFactory>;

  constructor(options: StaticProviderRegistryOptions = {}) {
    this.adapters = options.adapters ?? defaultAdapterFactories();
  }

  resolve(config: ModelProviderConfig, context: ProviderAdapterFactoryContext): ProviderAdapter {
    const providerType = config.providerType ?? "gateway-openai-compatible";
    const factory = this.adapters.get(providerType);
    if (factory === undefined) {
      throw new ConfigInvalidError(`no runtime adapter is registered for provider type '${providerType}'`);
    }
    const adapter = factory(context);
    adapter.validateConfig?.(config);
    return adapter;
  }
}

function gatewayConfigValidator(config: ModelProviderConfig): void {
  if (!isGatewayOpenAiCompatibleProviderConfig(config)) {
    throw new ConfigInvalidError(
      `provider '${config.modelId}' is not compatible with the OpenAI-compatible gateway adapter`,
    );
  }
}

export function defaultAdapterFactories(): ReadonlyMap<string, ProviderAdapterFactory> {
  return new Map<string, ProviderAdapterFactory>([
    [
      "gateway-openai-compatible",
      (context) => {
        const adapter = openAiAdapterFactory(context);
        return {
          ...adapter,
          providerType: "gateway-openai-compatible" as const,
          validateConfig: (config: ModelProviderConfig): void => gatewayConfigValidator(config),
        };
      },
    ],
    [
      "openai-codex-local-session",
      unsupportedAdapterFactory("openai-codex-local-session"),
    ],
  ]);
}

export interface DefaultProviderRegistryDeps {
  readonly fetchImpl?: typeof fetch | undefined;
}

export function createDefaultProviderRegistry(
  deps: DefaultProviderRegistryDeps = {},
): ProviderRegistry {
  const adapters = new Map(defaultAdapterFactories());
  const gatewayFactory = adapters.get("gateway-openai-compatible");
  if (gatewayFactory !== undefined && deps.fetchImpl !== undefined) {
    adapters.set("gateway-openai-compatible", (context) =>
      gatewayFactory({
        ...context,
        ...(context.fetchImpl === undefined ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    );
  }
  return new StaticProviderRegistry({ adapters });
}

export function asGatewayOpenAiCompatibleProviderConfig(
  config: ModelProviderConfig,
): GatewayOpenAiCompatibleProviderConfig {
  if (!isGatewayOpenAiCompatibleProviderConfig(config)) {
    throw new ConfigInvalidError(
      `provider '${config.modelId}' is not compatible with the OpenAI-compatible gateway adapter`,
    );
  }
  return config;
}
