import { Gateway, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

export interface RuntimeGatewayConfigSource {
  current(): GatewayConfig | undefined;
  generation(): number;
}

type RuntimeGatewayEntry =
  | {
      readonly kind: "available";
      readonly config: GatewayConfig;
      readonly gateway: Gateway;
      readonly generation: number;
    }
  | { readonly kind: "unavailable"; readonly generation: number };

class GatewayInstanceCache {
  private readonly byConfig = new WeakMap<GatewayConfig, Gateway>();
  private readonly byRuntimeConfig = new WeakMap<RuntimeGatewayConfigSource, RuntimeGatewayEntry>();

  forConfig(config: GatewayConfig): Gateway {
    const existing = this.byConfig.get(config);
    if (existing !== undefined) return existing;
    const gateway = new Gateway(config);
    this.byConfig.set(config, gateway);
    return gateway;
  }

  forRuntimeConfig(source: RuntimeGatewayConfigSource): Gateway | undefined {
    const config = source.current();
    if (config === undefined) {
      this.byRuntimeConfig.set(source, { kind: "unavailable", generation: source.generation() });
      return undefined;
    }
    const generation = source.generation();
    const existing = this.byRuntimeConfig.get(source);
    if (
      existing?.kind === "available" &&
      existing.generation === generation &&
      existing.config === config
    ) {
      return existing.gateway;
    }
    // A runtime generation change invalidates circuit-breaker and request state even when a caller
    // reused the same parsed config object. A config change inside the SAME generation is not an
    // invalidation, so it must still converge with direct callers on the config-keyed instance.
    const lifecycleReset =
      existing?.kind === "unavailable" ||
      (existing !== undefined && existing.generation !== generation);
    const gateway = lifecycleReset ? new Gateway(config) : this.forConfig(config);
    this.byRuntimeConfig.set(source, { kind: "available", config, gateway, generation });
    return gateway;
  }
}

let sharedGateways = new GatewayInstanceCache();

export function gatewayForConfig(config: GatewayConfig): Gateway {
  return sharedGateways.forConfig(config);
}

export function gatewayForRuntimeConfig(source: RuntimeGatewayConfigSource): Gateway | undefined {
  return sharedGateways.forRuntimeConfig(source);
}

/** Clears the process-wide cache between tests that exercise gateway instance isolation. */
export function resetGatewayInstanceCacheForTests(): void {
  sharedGateways = new GatewayInstanceCache();
}
