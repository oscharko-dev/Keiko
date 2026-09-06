import { isAbsolute } from "node:path";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  GatewayCallRequest,
  GatewaySpendBudget,
  GatewaySpendReservation,
  ModelCapability,
  ModelCapabilityPricing,
  UsageMetadata,
} from "@oscharko-dev/keiko-model-gateway";
import { ModelSpendStore } from "./store/model-spend.js";
import { processServerLogSink } from "./process-log-sink.js";
import type { ServerLogSink } from "./observability/server-log.js";
import { causeChain, keikoStackFrames } from "./observability/stack-frames.js";

export const QUALIFICATION_SPEND_BUDGET_USD_ENV = "KEIKO_QUALIFICATION_SPEND_BUDGET_USD";
export const QUALIFICATION_SPEND_LEDGER_PATH_ENV = "KEIKO_QUALIFICATION_SPEND_LEDGER_PATH";
const NANO_USD = 1_000_000_000;
type Rejection =
  | "spend-budget-invalid"
  | "spend-pricing-unavailable"
  | "spend-bound-unavailable"
  | "spend-budget-exceeded"
  | "spend-ledger-unavailable";

const REJECTION_REASONS = new Set<Rejection>([
  "spend-budget-invalid",
  "spend-pricing-unavailable",
  "spend-bound-unavailable",
  "spend-budget-exceeded",
  "spend-ledger-unavailable",
]);

export function gatewaySpendRejectionReason(error: unknown): string | undefined {
  if (!(error instanceof ConfigInvalidError)) return undefined;
  return [...REJECTION_REASONS].find((reason) => reason === error.message);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function cost(pricing: ModelCapabilityPricing, prompt: number, completion: number): number {
  const nanoUsd = Math.ceil(
    (prompt * pricing.inputUsdPerMillionTokens + completion * pricing.outputUsdPerMillionTokens) *
      1000,
  );
  if (!Number.isSafeInteger(nanoUsd) || nanoUsd < 0)
    throw new ConfigInvalidError("spend-bound-unavailable");
  return nanoUsd;
}

function validatedPricing(capability: ModelCapability): ModelCapabilityPricing {
  const pricing = capability.pricing;
  if (
    pricing === undefined ||
    ![pricing.inputUsdPerMillionTokens, pricing.outputUsdPerMillionTokens].every(
      (v) => Number.isFinite(v) && v >= 0,
    )
  ) {
    throw new ConfigInvalidError("spend-pricing-unavailable");
  }
  return pricing;
}

function upperCharge(
  capability: ModelCapability,
  request: GatewayCallRequest,
  pricing: ModelCapabilityPricing,
): number {
  const output = request.maxOutputTokens ?? capability.maxOutputTokens;
  if (
    !positiveInteger(capability.contextWindow) ||
    !positiveInteger(capability.maxOutputTokens) ||
    !positiveInteger(output) ||
    output > capability.maxOutputTokens
  ) {
    throw new ConfigInvalidError("spend-bound-unavailable");
  }
  // Reserve the declared full context, not a text-length/token estimate. The configured prices
  // must be upper rates for every admitted tier, including long-context and reasoning tokens.
  return cost(pricing, capability.contextWindow, output);
}

function measuredCharge(
  pricing: ModelCapabilityPricing,
  usage: UsageMetadata | undefined,
  upper: number,
): number {
  if (
    usage === undefined ||
    !Number.isSafeInteger(usage.promptTokens) ||
    !Number.isSafeInteger(usage.completionTokens) ||
    usage.promptTokens < 0 ||
    usage.completionTokens < 0 ||
    usage.promptTokens + usage.completionTokens === 0
  )
    return upper;
  return Math.min(upper, cost(pricing, usage.promptTokens, usage.completionTokens));
}

function reject(
  log: ServerLogSink,
  correlationId: string,
  reason: Rejection,
  error?: unknown,
): never {
  log.write({
    category: "gateway",
    level: "warn",
    op: "gateway.spend.rejected",
    correlationId,
    errorKind: "GATEWAY_CONFIG_INVALID",
    extra: {
      reason,
      ...(error === undefined
        ? {}
        : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
    },
  });
  throw new ConfigInvalidError(reason);
}

function reservation(
  store: ModelSpendStore,
  upper: number,
  pricing: ModelCapabilityPricing,
  log: ServerLogSink,
  correlationId: string,
): GatewaySpendReservation {
  let settled = false;
  return {
    settle(usage): void {
      if (settled) return;
      settled = true;
      const charged = measuredCharge(pricing, usage, upper);
      try {
        store.refund(upper - charged);
      } catch (error) {
        reject(log, correlationId, "spend-ledger-unavailable", error);
      }
      log.write({
        category: "gateway",
        level: "info",
        op: "gateway.spend.settled",
        correlationId,
        extra: { chargedNanoUsd: charged, measured: usage !== undefined && charged !== upper },
      });
    },
  };
}

function chargeForAttempt(
  capability: ModelCapability,
  request: GatewayCallRequest,
  log: ServerLogSink,
  correlationId: string,
): { pricing: ModelCapabilityPricing; upper: number } {
  try {
    const pricing = validatedPricing(capability);
    return { pricing, upper: upperCharge(capability, request, pricing) };
  } catch (error) {
    reject(
      log,
      correlationId,
      error instanceof ConfigInvalidError && error.message === "spend-pricing-unavailable"
        ? "spend-pricing-unavailable"
        : "spend-bound-unavailable",
    );
  }
}

class PersistentGatewaySpendBudget implements GatewaySpendBudget {
  private store: ModelSpendStore | undefined;
  constructor(
    private readonly ceiling: number,
    private readonly path: string | undefined,
    private readonly log: ServerLogSink,
  ) {}

  private ledger(correlationId: string): ModelSpendStore {
    if (!Number.isSafeInteger(this.ceiling) || this.ceiling < 0)
      reject(this.log, correlationId, "spend-budget-invalid");
    if (this.path === undefined || !isAbsolute(this.path))
      reject(this.log, correlationId, "spend-ledger-unavailable");
    try {
      return (this.store ??= new ModelSpendStore(this.path, this.ceiling));
    } catch (error) {
      reject(this.log, correlationId, "spend-ledger-unavailable", error);
    }
  }

  reserve(
    capability: ModelCapability,
    request: GatewayCallRequest,
    correlationId: string,
  ): GatewaySpendReservation {
    const store = this.ledger(correlationId);
    const { pricing, upper } = chargeForAttempt(capability, request, this.log, correlationId);
    let admitted: boolean;
    try {
      admitted = this.ceiling > 0 && store.reserve(upper);
    } catch (error) {
      reject(this.log, correlationId, "spend-ledger-unavailable", error);
    }
    if (!admitted) reject(this.log, correlationId, "spend-budget-exceeded");
    this.log.write({
      category: "gateway",
      level: "info",
      op: "gateway.spend.reserved",
      correlationId,
      extra: { reservedNanoUsd: upper, ceilingNanoUsd: this.ceiling },
    });
    return reservation(store, upper, pricing, this.log, correlationId);
  }
}

/** Lazily opens one stable ledger supplied by the local operator; never by model/request data. */
export function createGatewaySpendBudget(
  env: Readonly<Record<string, string | undefined>>,
  log: ServerLogSink = processServerLogSink(),
): GatewaySpendBudget | undefined {
  const raw = env[QUALIFICATION_SPEND_BUDGET_USD_ENV];
  if (raw === undefined) return undefined;
  const ceiling = raw.trim() === "" ? NaN : Number(raw) * NANO_USD;
  return new PersistentGatewaySpendBudget(ceiling, env[QUALIFICATION_SPEND_LEDGER_PATH_ENV], log);
}

const budgetsByEnvironment = new WeakMap<object, GatewaySpendBudget | undefined>();

export function gatewaySpendBudgetForEnv(
  env: Readonly<Record<string, string | undefined>>,
): GatewaySpendBudget | undefined {
  if (!budgetsByEnvironment.has(env)) budgetsByEnvironment.set(env, createGatewaySpendBudget(env));
  return budgetsByEnvironment.get(env);
}
