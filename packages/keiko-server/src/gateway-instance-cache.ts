import {
  Gateway,
  type GatewayConfig,
  type GatewaySpendBudget,
} from "@oscharko-dev/keiko-model-gateway";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { getServerLogger } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";

// Every Gateway this cache hands out logs into the process activity log. Constructed without it,
// `GatewayDeps.log` resolves to the frozen no-op and the whole retry / circuit-breaker /
// route-rejection lane is unreachable — the instance lines below would then describe which
// gateway was selected while saying nothing about what it did.
const GATEWAY_LOG_DEPS = { log: processServerLogSink() };

function newGateway(
  config: GatewayConfig,
  spendBudget?: GatewaySpendBudget,
  configurationCorrelationId?: string,
): Gateway {
  return new Gateway(config, {
    ...GATEWAY_LOG_DEPS,
    spendBudget,
    ...(configurationCorrelationId === undefined ? {} : { configurationCorrelationId }),
  });
}

export interface RuntimeGatewayConfigSource {
  readonly spendBudget?: GatewaySpendBudget | undefined;
  readonly initializationCorrelationId?: string | undefined;
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
type LifecycleResetReason = Extract<RuntimeSelectionReason, "recovered" | "generation-changed">;

// The two reasons that DISCARD live circuit-breaker and in-flight request state. A Set rather than
// an array membership test (SonarJS S7776).
const LIFECYCLE_RESET_REASONS = new Set<RuntimeSelectionReason>([
  "recovered",
  "generation-changed",
]);

function isLifecycleResetReason(reason: RuntimeSelectionReason): reason is LifecycleResetReason {
  return LIFECYCLE_RESET_REASONS.has(reason);
}

const GATEWAY_INSTANCE_REUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.instance.reused",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-instance-cache.logRuntimeSelection.reused",
  fields: {
    generation: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-instance-lifecycle"],
  proofIds: ["gateway.instance.reused.line"],
  releaseImpact: "patch",
});

const GATEWAY_INSTANCE_RESET_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.instance.reset",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-instance-cache.logRuntimeSelection.reset",
  fields: {
    generation: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["recovered", "generation-changed"],
    },
    lifecycleReset: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-instance-lifecycle"],
  proofIds: ["gateway.instance.reset.line"],
  releaseImpact: "patch",
});

const GATEWAY_INSTANCE_BOUND_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.instance.bound",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-instance-cache.logRuntimeSelection.bound",
  fields: {
    generation: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["created", "rebound"],
    },
    lifecycleReset: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-instance-lifecycle"],
  proofIds: ["gateway.instance.bound.line"],
  releaseImpact: "patch",
});

const GATEWAY_INSTANCE_UNAVAILABLE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.instance.unavailable",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-instance-cache.logRuntimeUnavailable",
  fields: {
    generation: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["still-unconfigured", "unconfigured", "config-withdrawn"],
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["gateway-instance-unavailable"],
  proofIds: ["gateway.instance.unavailable.line"],
  releaseImpact: "patch",
});

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

function logRuntimeSelection(
  reason: RuntimeSelectionReason,
  generation: number,
  initializationCorrelationId?: string,
): void {
  const root = getServerLogger();
  const log =
    initializationCorrelationId === undefined
      ? root
      : root.child({ correlationId: initializationCorrelationId });
  if (reason === "reused") {
    // The steady state, once per gateway-touching request. Deferred so it costs nothing at `info`.
    log.debug(() => activityLogEvent(GATEWAY_INSTANCE_REUSED_OPERATION, {}, { generation }));
    return;
  }
  const lifecycleReset = isLifecycleResetReason(reason);
  if (lifecycleReset) {
    log.info(
      activityLogEvent(
        GATEWAY_INSTANCE_RESET_OPERATION,
        {},
        { generation, reason, lifecycleReset },
      ),
    );
    return;
  }
  log.info(
    activityLogEvent(GATEWAY_INSTANCE_BOUND_OPERATION, {}, { generation, reason, lifecycleReset }),
  );
}

function logRuntimeUnavailable(
  existing: RuntimeGatewayEntry | undefined,
  generation: number,
): void {
  const log = getServerLogger();
  if (existing?.kind === "unavailable") {
    // Already known unavailable: an unconfigured install would otherwise warn on every request.
    log.debug(() =>
      activityLogEvent(
        GATEWAY_INSTANCE_UNAVAILABLE_OPERATION,
        {},
        { generation, reason: "still-unconfigured" },
      ),
    );
    return;
  }
  log.warn(
    activityLogEvent(
      GATEWAY_INSTANCE_UNAVAILABLE_OPERATION,
      {},
      { generation, reason: existing === undefined ? "unconfigured" : "config-withdrawn" },
    ),
  );
}

class GatewayInstanceCache {
  constructor(private readonly spendBudget?: GatewaySpendBudget) {}
  private readonly byConfig = new WeakMap<GatewayConfig, Gateway>();
  private readonly byRuntimeConfig = new WeakMap<RuntimeGatewayConfigSource, RuntimeGatewayEntry>();

  forConfig(config: GatewayConfig, configurationCorrelationId?: string): Gateway {
    const existing = this.byConfig.get(config);
    if (existing !== undefined) return existing;
    const gateway = newGateway(config, this.spendBudget, configurationCorrelationId);
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
    const initializationCorrelationId =
      reason === "created" && generation === 0 ? source.initializationCorrelationId : undefined;
    logRuntimeSelection(reason, generation, initializationCorrelationId);
    if (reason === "reused" && existing?.kind === "available") return existing.gateway;
    // A runtime generation change invalidates circuit-breaker and request state even when a caller
    // reused the same parsed config object. A config change inside the SAME generation is not an
    // invalidation, so it must still converge with direct callers on the config-keyed instance.
    const gateway = isLifecycleResetReason(reason)
      ? newGateway(config, this.spendBudget)
      : this.forConfig(config, initializationCorrelationId);
    this.byRuntimeConfig.set(source, { kind: "available", config, gateway, generation });
    return gateway;
  }
}

let sharedGateways = new GatewayInstanceCache();
let budgetedGateways = new WeakMap<GatewaySpendBudget, GatewayInstanceCache>();

function cacheForBudget(budget: GatewaySpendBudget | undefined): GatewayInstanceCache {
  if (budget === undefined) return sharedGateways;
  let cache = budgetedGateways.get(budget);
  if (cache === undefined) {
    cache = new GatewayInstanceCache(budget);
    budgetedGateways.set(budget, cache);
  }
  return cache;
}

export function gatewayForConfig(config: GatewayConfig, budget?: GatewaySpendBudget): Gateway {
  return cacheForBudget(budget).forConfig(config);
}

export function gatewayForRuntimeConfig(source: RuntimeGatewayConfigSource): Gateway | undefined {
  return cacheForBudget(source.spendBudget).forRuntimeConfig(source);
}

/** Clears the process-wide cache between tests that exercise gateway instance isolation. */
export function resetGatewayInstanceCacheForTests(): void {
  sharedGateways = new GatewayInstanceCache();
  budgetedGateways = new WeakMap<GatewaySpendBudget, GatewayInstanceCache>();
}
