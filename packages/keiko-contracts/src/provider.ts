export const PROVIDER_TYPES = [
  "gateway-openai-compatible",
  "openai-codex-local-session",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderIdentity {
  readonly providerType: ProviderType;
  readonly modelId: string;
}

export const PROVIDER_VALIDATION_STATUSES = [
  "unknown",
  "ready",
  "invalid",
  "unavailable",
  "unsupported",
] as const;

export type ProviderValidationStatus = (typeof PROVIDER_VALIDATION_STATUSES)[number];

export interface ProviderValidationState {
  readonly status: ProviderValidationStatus;
  readonly checkedAt?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly message?: string | undefined;
}

export interface ProviderSelection extends ProviderIdentity {}
