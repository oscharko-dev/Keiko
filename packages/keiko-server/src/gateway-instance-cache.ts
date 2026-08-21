import { Gateway, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

import { getServerLogger } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";

// Every Gateway this cache hands out logs into the process activity log. Constructed without it,
// `GatewayDeps.log` resolves to the frozen no-op and the whole retry / circuit-breaker /
// route-rejection lane is unreachable — the instance lines below would then describe which
// gateway was selected while saying nothing about what it did.
const GATEWAY_LOG_DEPS = { log: processServerLogSink() };

function newGateway(config: GatewayConfig): Gateway {
  return new Gateway(config, GATEWAY_LOG_DEPS);
}

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

// Why this lookup did what it did. This is the whole decision the cache makes, and it is invisible
// from the outside: two callers holding "the gateway" may be holding two different instances with
// two different circuit-breaker states, and only the reason below explains when that happened.
type RuntimeSelectionReason =
  | "reused" // same generation, same config object: the cached instance, breaker state intact
  | "rebound" // same generation, a different parsed config: converges on the config-keyed instance
  | "created" // first lookup for this source
  | "recovered" // the previous lookup found no config at all
  | "generation-changed"; // runtime setup replaced the config: breaker and request state discarded

// The two reasons that DISCARD live circuit-breaker and in-flight request state. A Set rather than
// an array membership test (SonarJS S7776).
const LIFECYCLE_RESET_REASONS = new Set<RuntimeSelectionReason>([
  "recovered",
  "generation-changed",
]);

function runtimeSelectionReason(
  existing: RuntimeGatewayEntry | undefined,
  generation: number,
  config: GatewayConfig,
): RuntimeSelectionReason {
  if (existing === undefined) return "created";
  if (existing.kind === "unavailable") return "recovered";
  if (existing.generation !== generation) return "generation-changed";
  return existing.config === config ? "reused" : "rebound";
}

function logRuntimeSelection(reason: RuntimeSelectionReason, generation: number): void {
  const log = getServerLogger();
  if (reason === "reused") {
    // The steady state, once per gateway-touching request. Deferred so it costs nothing at `info`.
    log.debug(() => ({
      category: "gateway",
      op: "gateway.instance.reused",
      extra: { generation },
    }));
    return;
  }
  const lifecycleReset = LIFECYCLE_RESET_REASONS.has(reason);
  log.info({
    category: "gateway",
    op: lifecycleReset ? "gateway.instance.reset" : "gateway.instance.bound",
    extra: { generation, reason, lifecycleReset },
  });
}

function logRuntimeUnavailable(
  existing: RuntimeGatewayEntry | undefined,
  generation: number,
): void {
  const log = getServerLogger();
  if (existing?.kind === "unavailable") {
    // Already known unavailable: an unconfigured install would otherwise warn on every request.
    log.debug(() => ({
      category: "gateway",
      op: "gateway.instance.unavailable",
      extra: { generation, reason: "still-unconfigured" },
    }));
    return;
  }
  log.warn({
    category: "gateway",
    op: "gateway.instance.unavailable",
    extra: { generation, reason: existing === undefined ? "unconfigured" : "config-withdrawn" },
  });
}

class GatewayInstanceCache {
  private readonly byConfig = new WeakMap<GatewayConfig, Gateway>();
  private readonly byRuntimeConfig = new WeakMap<RuntimeGatewayConfigSource, RuntimeGatewayEntry>();

  forConfig(config: GatewayConfig): Gateway {
    const existing = this.byConfig.get(config);
    if (existing !== undefined) return existing;
    const gateway = newGateway(config);
    this.byConfig.set(config, gateway);
    return gateway;
  }

  forRuntimeConfig(source: RuntimeGatewayConfigSource): Gateway | undefined {
    const config = source.current();
    const generation = source.generation();
    const existing = this.byRuntimeConfig.get(source);
    if (config === undefined) {
      logRuntimeUnavailable(existing, generation);
      this.byRuntimeConfig.set(source, { kind: "unavailable", generation });
      return undefined;
    }
    const reason = runtimeSelectionReason(existing, generation, config);
    logRuntimeSelection(reason, generation);
    if (reason === "reused" && existing?.kind === "available") return existing.gateway;
    // A runtime generation change invalidates circuit-breaker and request state even when a caller
    // reused the same parsed config object. A config change inside the SAME generation is not an
    // invalidation, so it must still converge with direct callers on the config-keyed instance.
    const gateway = LIFECYCLE_RESET_REASONS.has(reason)
      ? newGateway(config)
      : this.forConfig(config);
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
