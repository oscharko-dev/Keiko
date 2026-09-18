import { isAbsolute } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogFieldContract,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  GatewayCallRequest,
  GatewaySpendBudget,
  GatewaySpendReservation,
  ModelCapability,
  ModelCapabilityPricing,
  UsageMetadata,
} from "@oscharko-dev/keiko-model-gateway";
import { ModelSpendStore, type SpendCeilingReconciliation } from "./store/model-spend.js";
import { processServerLogSink } from "./process-log-sink.js";
import { errorKindOf, type ServerLogSink } from "./observability/server-log.js";
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

const REJECTION_REASON_VALUES = [
  "spend-budget-invalid",
  "spend-pricing-unavailable",
  "spend-bound-unavailable",
  "spend-budget-exceeded",
  "spend-ledger-unavailable",
] as const satisfies readonly Rejection[];
const REJECTION_REASONS = new Set<Rejection>(REJECTION_REASON_VALUES);

type GatewaySpendOperationHeader = Pick<
  ActivityLogOperationRegistration,
  "contractKind" | "schemaVersion"
>;
type GatewaySpendOperationOwnership = Pick<ActivityLogOperationRegistration, "category" | "owner">;

const GATEWAY_SPEND_OPERATION_HEADER = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
} as const satisfies GatewaySpendOperationHeader;
const GATEWAY_SPEND_OPERATION_OWNERSHIP = {
  category: "gateway",
  owner: "keiko-server",
} as const satisfies GatewaySpendOperationOwnership;

const REJECTION_FRAMES_FIELD_CONTRACT = {
  type: "string-array",
  dataClass: "safe-platform-class",
  required: false,
  maxLength: 512,
  maxItems: 8,
} as const satisfies ActivityLogFieldContract;
const REJECTION_CAUSE_CHAIN_FIELD_CONTRACT = {
  type: "string-array",
  dataClass: "error-kind",
  required: false,
  maxLength: 128,
  maxItems: 5,
} as const satisfies ActivityLogFieldContract;

const GATEWAY_SPEND_REJECTED_OPERATION = defineActivityLogOperation({
  ...GATEWAY_SPEND_OPERATION_HEADER,
  op: "gateway.spend.rejected",
  ...GATEWAY_SPEND_OPERATION_OWNERSHIP,
  emitter: "gateway-spend-budget.reject",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REJECTION_REASON_VALUES,
    },
    frames: REJECTION_FRAMES_FIELD_CONTRACT,
    causeChain: REJECTION_CAUSE_CHAIN_FIELD_CONTRACT,
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["gateway-spend-policy"],
  proofIds: ["gateway.spend.rejected.line"],
  releaseImpact: "patch",
});

const GATEWAY_SPEND_SETTLED_OPERATION = defineActivityLogOperation({
  ...GATEWAY_SPEND_OPERATION_HEADER,
  op: "gateway.spend.settled",
  ...GATEWAY_SPEND_OPERATION_OWNERSHIP,
  emitter: "gateway-spend-budget.reservation.settle",
  fields: {
    chargedNanoUsd: { type: "integer", dataClass: "count", required: true },
    measured: { type: "boolean", dataClass: "closed-enum", required: true },
    boundExceeded: { type: "boolean", dataClass: "closed-enum", required: true },
    measurementErrorKind: {
      type: "string",
      dataClass: "error-kind",
      required: false,
      maxLength: 64,
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-spend-measurement"],
  proofIds: ["gateway.spend.settled.line"],
  releaseImpact: "patch",
});

const GATEWAY_SPEND_CEILING_OPERATION = defineActivityLogOperation({
  ...GATEWAY_SPEND_OPERATION_HEADER,
  op: "gateway.spend.ceiling",
  ...GATEWAY_SPEND_OPERATION_OWNERSHIP,
  emitter: "gateway-spend-budget.PersistentGatewaySpendBudget.reportCeiling",
  fields: {
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unchanged", "lowered", "raised", "raise-refused"],
    },
    ceilingNanoUsd: { type: "integer", dataClass: "count", required: true },
    configuredNanoUsd: { type: "integer", dataClass: "count", required: true },
    chargedNanoUsd: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-spend-ceiling"],
  proofIds: ["gateway.spend.ceiling.line"],
  releaseImpact: "patch",
});

const GATEWAY_SPEND_RESERVED_OPERATION = defineActivityLogOperation({
  ...GATEWAY_SPEND_OPERATION_HEADER,
  op: "gateway.spend.reserved",
  ...GATEWAY_SPEND_OPERATION_OWNERSHIP,
  emitter: "gateway-spend-budget.PersistentGatewaySpendBudget.reserve",
  fields: {
    reservedNanoUsd: { type: "integer", dataClass: "count", required: true },
    ceilingNanoUsd: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-spend-reservation"],
  proofIds: ["gateway.spend.reserved.line"],
  releaseImpact: "patch",
});

export function gatewaySpendRejectionReason(error: unknown): Rejection | undefined {
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
  const outputBoundValid =
    capability.kind === "embedding"
      ? capability.maxOutputTokens === 0 && output === 0
      : positiveInteger(capability.maxOutputTokens) && positiveInteger(output);
  if (
    !positiveInteger(capability.contextWindow) ||
    !outputBoundValid ||
    output > capability.maxOutputTokens
  ) {
    throw new ConfigInvalidError("spend-bound-unavailable");
  }
  // Reserve the declared full context, not a text-length/token estimate. The configured prices
  // must be upper rates for every admitted tier, including long-context and reasoning tokens.
  return cost(pricing, capability.contextWindow, output);
}

/** A usage report the pricing cannot turn into a safe charge must not discard the response the
 * model already produced: `settle` runs in a `finally`, and an exception escaping from there
 * replaced a successful call with a raw error. The reserved upper bound stays charged -- the
 * conservative outcome -- and the failure is named on the settlement line. */
function measureCharge(
  pricing: ModelCapabilityPricing,
  usage: UsageMetadata | undefined,
  upper: number,
): { readonly charged: number; readonly errorKind?: string } {
  try {
    return { charged: measuredCharge(pricing, usage, upper) };
  } catch (error) {
    return { charged: upper, errorKind: errorKindOf(error) };
  }
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
  return cost(pricing, usage.promptTokens, usage.completionTokens);
}

function reject(
  log: ServerLogSink,
  correlationId: string,
  reason: Rejection,
  error?: unknown,
): never {
  const rejection = new ConfigInvalidError(reason);
  const diagnosticError = error ?? rejection;
  log.write(
    activityLogEvent(
      GATEWAY_SPEND_REJECTED_OPERATION,
      { level: "warn", correlationId, errorKind: "validation-failed" },
      {
        reason,
        frames: keikoStackFrames(diagnosticError),
        causeChain: causeChain(diagnosticError),
      },
    ),
  );
  throw rejection;
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
      const measurement = measureCharge(pricing, usage, upper);
      const charged = measurement.charged;
      try {
        if (charged > upper) store.exhaust(charged - upper);
        else store.refund(upper - charged);
      } catch (error) {
        reject(log, correlationId, "spend-ledger-unavailable", error);
      }
      log.write(
        activityLogEvent(
          GATEWAY_SPEND_SETTLED_OPERATION,
          {
            level: measurement.errorKind === undefined ? "info" : "warn",
            correlationId,
          },
          {
            chargedNanoUsd: charged,
            measured:
              usage !== undefined && charged !== upper && measurement.errorKind === undefined,
            boundExceeded: charged > upper,
            ...(measurement.errorKind === undefined
              ? {}
              : { measurementErrorKind: measurement.errorKind }),
          },
        ),
      );
      if (charged > upper) reject(log, correlationId, "spend-bound-unavailable");
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
      error,
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
      if (this.store === undefined) {
        this.store = new ModelSpendStore(this.path, this.ceiling);
        this.reportCeiling(this.store.reconciliation, correlationId);
      }
      return this.store;
    } catch (error) {
      reject(this.log, correlationId, "spend-ledger-unavailable", error);
    }
  }

  /**
   * Reports what opening the ledger did to its ceiling. Without this line, an operator who raised
   * their configured limit on a closed ledger sees only "budget exceeded" against a number they are
   * nowhere near, and the log cannot tell them which ceiling actually applied.
   */
  private reportCeiling(reconciliation: SpendCeilingReconciliation, correlationId: string): void {
    this.log.write(
      activityLogEvent(
        GATEWAY_SPEND_CEILING_OPERATION,
        {
          level: reconciliation.disposition === "raise-refused" ? "warn" : "info",
          correlationId,
        },
        {
          disposition: reconciliation.disposition,
          ceilingNanoUsd: reconciliation.ceilingNanoUsd,
          configuredNanoUsd: reconciliation.configuredNanoUsd,
          chargedNanoUsd: reconciliation.chargedNanoUsd,
        },
      ),
    );
  }

  reserve(
    capability: ModelCapability,
    request: GatewayCallRequest,
    correlationId: string,
  ): GatewaySpendReservation {
    const store = this.ledger(correlationId);
    const effectiveCeiling = store.reconciliation.ceilingNanoUsd;
    const { pricing, upper } = chargeForAttempt(capability, request, this.log, correlationId);
    let admitted: boolean;
    try {
      admitted = effectiveCeiling > 0 && store.reserve(upper);
    } catch (error) {
      reject(this.log, correlationId, "spend-ledger-unavailable", error);
    }
    if (!admitted) reject(this.log, correlationId, "spend-budget-exceeded");
    this.log.write(
      activityLogEvent(
        GATEWAY_SPEND_RESERVED_OPERATION,
        { level: "info", correlationId },
        // The ledger's own ceiling, never the configured one: they differ whenever a reused ledger
        // holds a lower ceiling, and reporting the configured number there hides exactly that case.
        { reservedNanoUsd: upper, ceilingNanoUsd: effectiveCeiling },
      ),
    );
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
  const ceiling = raw.trim() === "" ? Number.NaN : Number(raw) * NANO_USD;
  return new PersistentGatewaySpendBudget(ceiling, env[QUALIFICATION_SPEND_LEDGER_PATH_ENV], log);
}

const budgetsByEnvironment = new WeakMap<object, GatewaySpendBudget | undefined>();

export function gatewaySpendBudgetForEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): GatewaySpendBudget | undefined {
  if (env === undefined) return undefined;
  if (!budgetsByEnvironment.has(env)) budgetsByEnvironment.set(env, createGatewaySpendBudget(env));
  return budgetsByEnvironment.get(env);
}

export function reserveGatewaySpendForAttempt(
  env: Readonly<Record<string, string | undefined>> | undefined,
  capability: ModelCapability | undefined,
  request: GatewayCallRequest,
  correlationId: string,
): GatewaySpendReservation | undefined {
  const budget = gatewaySpendBudgetForEnv(env);
  if (budget === undefined) return undefined;
  if (capability === undefined)
    reject(processServerLogSink(), correlationId, "spend-bound-unavailable");
  return budget.reserve(capability, request, correlationId);
}
