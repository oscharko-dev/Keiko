import type { ModelCapability } from "./gateway.js";

export const PROVIDER_TYPES = [
  "gateway-openai-compatible",
  "openai-codex-local-session",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_VALIDATION_STATES = ["configured", "runtime-only"] as const;

export type ProviderValidationState = (typeof PROVIDER_VALIDATION_STATES)[number];

export interface ProviderSelection {
  readonly providerId: string;
  readonly modelId: string;
}

interface SafeProviderConfigBase {
  readonly providerId: string;
  readonly providerType: ProviderType;
  readonly modelId: string;
  readonly validationState: ProviderValidationState;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface SafeGatewayOpenAiCompatibleProviderConfig extends SafeProviderConfigBase {
  readonly providerType: "gateway-openai-compatible";
  readonly validationState: "configured";
  readonly credentialHeaderName: string;
}

export interface SafeOpenAiCodexLocalSessionProviderConfig extends SafeProviderConfigBase {
  readonly providerType: "openai-codex-local-session";
  readonly validationState: "runtime-only";
  readonly credentialHeaderName?: undefined;
}

export type SafeProviderConfig =
  | SafeGatewayOpenAiCompatibleProviderConfig
  | SafeOpenAiCodexLocalSessionProviderConfig;

export interface SafeCircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface SafeGatewayConfig {
  readonly providers: readonly SafeProviderConfig[];
  readonly circuitBreaker: SafeCircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[] | undefined;
}

export interface ProviderContractValidationOk {
  readonly ok: true;
}

export interface ProviderContractValidationFail {
  readonly ok: false;
  readonly reason: string;
}

export type ProviderContractValidation =
  | ProviderContractValidationOk
  | ProviderContractValidationFail;

function ok(): ProviderContractValidationOk {
  return { ok: true };
}

function fail(reason: string): ProviderContractValidationFail {
  return { ok: false, reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasExpectedValidationState(
  value: { readonly validationState: ProviderValidationState },
  expected: ProviderValidationState,
): boolean {
  return value.validationState === expected;
}

export function validateProviderSelection(value: ProviderSelection): ProviderContractValidation {
  if (!isNonEmptyString(value.providerId)) {
    return fail("providerSelection.providerId must be a non-empty string");
  }
  if (!isNonEmptyString(value.modelId)) {
    return fail("providerSelection.modelId must be a non-empty string");
  }
  return ok();
}

export function validateSafeProviderConfig(value: SafeProviderConfig): ProviderContractValidation {
  if (!isNonEmptyString(value.providerId)) {
    return fail("safeProviderConfig.providerId must be a non-empty string");
  }
  if (!isNonEmptyString(value.modelId)) {
    return fail("safeProviderConfig.modelId must be a non-empty string");
  }
  if (!isPositiveInteger(value.timeoutMs)) {
    return fail("safeProviderConfig.timeoutMs must be a positive integer");
  }
  if (!isNonNegativeInteger(value.maxRetries)) {
    return fail("safeProviderConfig.maxRetries must be a non-negative integer");
  }
  if (!isPositiveInteger(value.retryBaseDelayMs)) {
    return fail("safeProviderConfig.retryBaseDelayMs must be a positive integer");
  }
  if (value.providerType === "gateway-openai-compatible") {
    if (!hasExpectedValidationState(value, "configured")) {
      return fail(
        "safeProviderConfig.validationState must be 'configured' for gateway-openai-compatible providers",
      );
    }
    if (!isNonEmptyString(value.credentialHeaderName)) {
      return fail(
        "safeProviderConfig.credentialHeaderName must be a non-empty string for gateway-openai-compatible providers",
      );
    }
    return ok();
  }
  if (!hasExpectedValidationState(value, "runtime-only")) {
    return fail(
      "safeProviderConfig.validationState must be 'runtime-only' for openai-codex-local-session providers",
    );
  }
  return ok();
}

export function validateSafeGatewayConfig(value: SafeGatewayConfig): ProviderContractValidation {
  for (let index = 0; index < value.providers.length; index += 1) {
    const provider = value.providers[index];
    if (provider === undefined) {
      return fail(`safeGatewayConfig.providers[${String(index)}] must be present`);
    }
    const result = validateSafeProviderConfig(provider);
    if (!result.ok) {
      return fail(`safeGatewayConfig.providers[${String(index)}]: ${result.reason}`);
    }
  }
  if (!isPositiveInteger(value.circuitBreaker.failureThreshold)) {
    return fail("safeGatewayConfig.circuitBreaker.failureThreshold must be a positive integer");
  }
  if (!isPositiveInteger(value.circuitBreaker.cooldownMs)) {
    return fail("safeGatewayConfig.circuitBreaker.cooldownMs must be a positive integer");
  }
  if (!isPositiveInteger(value.circuitBreaker.halfOpenProbes)) {
    return fail("safeGatewayConfig.circuitBreaker.halfOpenProbes must be a positive integer");
  }
  return ok();
}
