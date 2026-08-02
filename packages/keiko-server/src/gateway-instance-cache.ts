import { Gateway, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

export interface RuntimeGatewayConfigSource {
  current(): GatewayConfig | undefined;
  generation(): number;
}

interface RuntimeGatewayEntry {
  readonly config: GatewayConfig;
  readonly gateway: Gateway;
  readonly generation: number;
}

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
      const previous = this.byRuntimeConfig.get(source);
      if (previous !== undefined) {
        this.byRuntimeConfig.delete(source);
        if (this.byConfig.get(previous.config) === previous.gateway) {
          this.byConfig.delete(previous.config);
        }
      }
      return undefined;
    }
    const generation = source.generation();
    const existing = this.byRuntimeConfig.get(source);
    if (existing?.generation === generation && existing.config === config) {
      return existing.gateway;
    }
    // A runtime generation change invalidates circuit-breaker and request state even when a caller
    // reused the same parsed config object. Only the first runtime resolution may share a directly
    // created config-keyed gateway; every subsequent runtime invalidation starts fresh.
    const gateway = existing === undefined ? this.forConfig(config) : new Gateway(config);
    this.byConfig.set(config, gateway);
    this.byRuntimeConfig.set(source, { config, gateway, generation });
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
