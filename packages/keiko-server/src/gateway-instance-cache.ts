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
    if (config === undefined) return undefined;
    const generation = source.generation();
    const existing = this.byRuntimeConfig.get(source);
    if (existing?.generation === generation && existing.config === config) {
      return existing.gateway;
    }
    const gateway = new Gateway(config);
    this.byRuntimeConfig.set(source, { config, gateway, generation });
    this.byConfig.set(config, gateway);
    return gateway;
  }
}

const sharedGateways = new GatewayInstanceCache();

export function gatewayForConfig(config: GatewayConfig): Gateway {
  return sharedGateways.forConfig(config);
}

export function gatewayForRuntimeConfig(source: RuntimeGatewayConfigSource): Gateway | undefined {
  return sharedGateways.forRuntimeConfig(source);
}
