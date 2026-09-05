// Gateway config loading, hand-rolled validation, and redaction-aware serialisation.
// No schema library: validation is explicit if/throw with actionable messages.
// API keys are sourced only from environment or the config file, never CLI flags,
// and are excluded from every serialisation path.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  DEFAULT_GROUNDING_LIMITS,
  DEFAULT_SAFE_CIRCUIT_BREAKER_CONFIG,
  resolveGroundingLimits,
  type GroundingLimits,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { VOICE_PERSONAS, VOICE_PROVIDER_LOCALITIES } from "./types.js";
import {
  MODEL_REASONING_EFFORTS,
  PROVIDER_ENDPOINT_STYLES,
  REALTIME_AUTH_MODES,
  isToolCallingVerificationFresh,
  isVoiceCapability,
  modelSupportsSpeechOutput,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { outboundTargetBlockedReason } from "./egress-policy.js";
import { projectSafeCapabilities, type SafeModelCapability } from "./model-selection.js";
import { validatedPrDescriptionLogoUrl } from "./prDescription/render.js";
import type { PrDescriptionBranding } from "./prDescription/types.js";
import type {
  CircuitBreakerConfig,
  CostClass,
  FigmaConnectorConfig,
  GatewayBrandingConfig,
  GatewayConfig,
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
  ModelCapabilityPricing,
  ModelKind,
  ModelReasoningEffort,
  ModelProviderConfig,
  ModelTokenAccounting,
  OutputTokenParameter,
  OutboundHttpEgressConfig,
  ProviderEndpointStyle,
  RealtimeAuthMode,
  RerankerConfig,
  ToolCallingVerification,
  VoicePersona,
  VoicePersonaVoice,
  VoiceProviderLocality,
} from "./types.js";

export function toolCallingConfigurationFingerprint(provider: ModelProviderConfig): string {
  // Credential header spelling controls authentication transport, not the provider protocol or its
  // tool-call semantics. Deliberately exclude it: hashing a request-supplied header name creates a
  // misleading password-hash dataflow and cannot make a capability verdict more authoritative.
  const binding = [
    provider.modelId,
    provider.baseUrl,
    provider.endpointStyle ?? "openai-compatible",
    provider.apiVersion ?? "",
  ];
  return sha256Hex(canonicalise(binding));
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
// KEIKO-0572: exported so gateway-setup.ts / grounded-retrieval-eval.ts can import the shared
// defaults instead of restating the literal `{ failureThreshold: 5, cooldownMs: 30_000,
// halfOpenProbes: 2 }` at three call sites. #2906 round 3: the VALUES themselves now come from
// keiko-contracts's DEFAULT_SAFE_CIRCUIT_BREAKER_CONFIG (the one place keiko-ui's
// gatewayConfigParsing.ts can also reach across the ADR-0019 package boundary), so this package no
// longer holds an independent copy that could drift from the wire default silently.
export const DEFAULT_FAILURE_THRESHOLD = DEFAULT_SAFE_CIRCUIT_BREAKER_CONFIG.failureThreshold;
export const DEFAULT_COOLDOWN_MS = DEFAULT_SAFE_CIRCUIT_BREAKER_CONFIG.cooldownMs;
export const DEFAULT_HALF_OPEN_PROBES = DEFAULT_SAFE_CIRCUIT_BREAKER_CONFIG.halfOpenProbes;
export const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  halfOpenProbes: DEFAULT_HALF_OPEN_PROBES,
} as const;
export const DEFAULT_API_KEY_HEADER_NAME = "authorization";
export { TOOL_CALLING_VERIFICATION_MAX_AGE_MS } from "@oscharko-dev/keiko-contracts/runtime/gateway";
export { isToolCallingVerificationFresh };
const MAX_API_KEY_HEADER_NAME_LENGTH = 64;
const API_KEY_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
export const SUPPORTED_API_KEY_HEADER_NAMES = [
  DEFAULT_API_KEY_HEADER_NAME,
  "x-litellm-key",
  "x-api-key",
  "api-key",
] as const;
const SUPPORTED_API_KEY_HEADER_NAME_SET = new Set<string>(SUPPORTED_API_KEY_HEADER_NAMES);
const BEARER_API_KEY_HEADER_NAME_SET = new Set<string>([
  DEFAULT_API_KEY_HEADER_NAME,
  "x-litellm-key",
]);
// The endpoint-protocol value arrays come from the contract seam — one source for the UI upload
// parser, the server setup route, and this parser (#3037 follow-up).
const OUTPUT_TOKEN_PARAMETERS: readonly OutputTokenParameter[] = [
  "max_tokens",
  "max_completion_tokens",
];
const API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u;
const MODEL_TOKEN_ACCOUNTING_SOURCES: readonly ModelTokenAccounting["source"][] = ["calibrated"];
const TOKEN_ACCOUNTING_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "source",
  "counterId",
  "scaleMilli",
  "offsetTokens",
]);
const PRICING_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "inputUsdPerMillionTokens",
  "outputUsdPerMillionTokens",
]);

export type EnvSource = Readonly<Record<string, string | undefined>>;

const ENV_MODEL_PREFIX = "KEIKO_MODEL_";
const ENV_MODEL_API_KEY_SUFFIX = "_API_KEY";

function envModelProviderTokenQualifies(token: string, env: EnvSource): boolean {
  const apiKey = env[`${ENV_MODEL_PREFIX}${token}${ENV_MODEL_API_KEY_SUFFIX}`];
  const baseUrl = env[`${ENV_MODEL_PREFIX}${token}_BASE_URL`];
  return (apiKey?.length ?? 0) > 0 && (baseUrl?.length ?? 0) > 0;
}

/**
 * The ONE env-only Model Gateway provider-admission formula: a `KEIKO_MODEL_<TOKEN>_API_KEY` /
 * `KEIKO_MODEL_<TOKEN>_BASE_URL` pair counts as a configured provider only when BOTH are present
 * and non-empty — never the API key alone. Every caller that needs to know whether an env-only
 * provider is configured (keiko-server's production Gateway composition, and the #3390 real-model
 * qualification harness) shares this exact check, so none of them can drift into accepting a
 * profile the others would refuse.
 *
 * Pass `modelId` to check one specific provider (its token is derived the same way production
 * derives it: non-alphanumeric characters become `_`, then upper-cased); omit it to ask whether
 * ANY env-only provider in `env` qualifies.
 */
export function hasConfiguredEnvModelProvider(env: EnvSource, modelId?: string): boolean {
  if (modelId !== undefined) {
    return envModelProviderTokenQualifies(modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase(), env);
  }
  return Object.keys(env).some((key) => {
    if (!key.startsWith(ENV_MODEL_PREFIX) || !key.endsWith(ENV_MODEL_API_KEY_SUFFIX)) return false;
    const token = key.slice(ENV_MODEL_PREFIX.length, -ENV_MODEL_API_KEY_SUFFIX.length);
    return token.length > 0 && envModelProviderTokenQualifies(token, env);
  });
}

// Resolves an opaque, NON-SECRET credential reference (persisted in the config file as a provider's
// `apiKeySecretRef`) to its plaintext secret, or undefined when the reference is unknown. The gateway
// stays crypto-free and deterministic: keiko-server / keiko-cli inject a vault-backed resolver
// (Issue #1320), while in-memory configs and tests pass none. A resolver that throws or returns
// undefined degrades to the next credential source, so a missing/locked vault surfaces as the
// existing "apiKey must be set" config error rather than a crash.
export type ProviderSecretResolver = (reference: string) => string | undefined;

export interface ParseGatewayConfigOptions {
  readonly secretResolver?: ProviderSecretResolver | undefined;
  // Narrow, explicit egress fields layered on top of whatever `raw.egress`/env resolves to.
  // Deliberately NOT a generic env-var mapping (unlike the rest of `OutboundHttpEgressConfig`,
  // which is resolved uniformly from `raw.egress` + well-known env vars for every caller): this
  // exists solely so the model-gateway setup route can pass `allowLinkLocalAndMetadata: true`
  // for one already-approved candidate baseUrl (AUDIT-SEC-002 follow-up) without widening the
  // egress every other `parseGatewayConfig`/`resolveOutboundHttpEgressConfig` caller resolves.
  readonly egressOverride?: Pick<OutboundHttpEgressConfig, "allowLinkLocalAndMetadata"> | undefined;
}

export interface SafeProviderConfig {
  readonly modelId: string;
  readonly credentialHeaderName: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface SafeRerankerConfig {
  readonly modelId: string;
  readonly credentialHeaderName: string;
  readonly timeoutMs: number;
}

export interface SafeGatewayConfig {
  readonly providers: readonly SafeProviderConfig[];
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly capabilities?: readonly SafeModelCapability[] | undefined;
  readonly grounding?: Partial<GroundingLimits> | undefined;
  readonly reranker?: SafeRerankerConfig | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigInvalidError(`${path} must be a positive integer`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigInvalidError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireNonEmptyTrimmedString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ConfigInvalidError(`${path} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ConfigInvalidError(`${path} must be a non-empty string`);
  }
  return trimmed;
}

function optionalStringArray(
  value: unknown,
  path: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigInvalidError(`${path} must be an array of strings`);
  }
  return value as readonly string[];
}

function optionalNonNegativeInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigInvalidError(`${path} must be a non-negative integer`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigInvalidError(`${path} must be a boolean`);
  }
  return value;
}

function optionalEgressBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    throw new ConfigInvalidError(`${path} must be a boolean`);
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigInvalidError(`${path} must be a boolean`);
}

function optionalNonEmptyString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  return requireNonEmptyString(value, path);
}

function optionalTrimmedString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigInvalidError(`${path} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function validateProxyUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigInvalidError(`${path} must be a valid absolute proxy URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigInvalidError(`${path} must use the http or https scheme`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigInvalidError(`${path} must not embed credentials`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigInvalidError(`${path} must not contain a query string or fragment`);
  }
  return url.toString();
}

function optionalProxyUrl(value: unknown, path: string): string | undefined {
  const raw = optionalTrimmedString(value, path);
  return raw === undefined ? undefined : validateProxyUrl(raw, path);
}

function optionalCaBundlePath(value: unknown, path: string): string | undefined {
  return optionalTrimmedString(value, path);
}

function normalizeNoProxyItems(values: readonly string[]): readonly string[] {
  return Array.from(
    new Set(
      values
        .flatMap((item) => item.split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function optionalNoProxy(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return normalizeNoProxyItems([value]);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return normalizeNoProxyItems(value);
  }
  throw new ConfigInvalidError(`${path} must be a string or an array of strings`);
}

function egressBlock(raw: unknown): Record<string, unknown> {
  if (raw !== undefined && !isRecord(raw)) {
    throw new ConfigInvalidError("egress must be an object");
  }
  return isRecord(raw) ? raw : {};
}

function emptyToUndefined(config: OutboundHttpEgressConfig): OutboundHttpEgressConfig | undefined {
  return Object.keys(config).length === 0 ? undefined : config;
}

type MutableEgressConfig = {
  -readonly [K in keyof OutboundHttpEgressConfig]?: OutboundHttpEgressConfig[K];
};

interface EgressField<K extends keyof OutboundHttpEgressConfig> {
  readonly key: K;
  readonly envNames: readonly string[];
  readonly parser: (value: unknown, path: string) => OutboundHttpEgressConfig[K] | undefined;
}

const EGRESS_FIELDS: readonly EgressField<keyof OutboundHttpEgressConfig>[] = [
  {
    key: "httpProxy",
    envNames: ["KEIKO_HTTP_PROXY", "HTTP_PROXY", "http_proxy"],
    parser: optionalProxyUrl,
  },
  {
    key: "httpsProxy",
    envNames: ["KEIKO_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"],
    parser: optionalProxyUrl,
  },
  {
    key: "noProxy",
    envNames: ["KEIKO_NO_PROXY", "NO_PROXY", "no_proxy"],
    parser: optionalNoProxy,
  },
  {
    key: "caBundlePath",
    envNames: ["KEIKO_CA_BUNDLE_PATH"],
    parser: optionalCaBundlePath,
  },
  {
    key: "allowPrivateNetwork",
    envNames: ["KEIKO_ALLOW_PRIVATE_EGRESS"],
    parser: optionalEgressBoolean,
  },
  {
    key: "acknowledgeProxiedHostnamePolicy",
    envNames: [],
    parser: optionalEgressBoolean,
  },
];

function setEgressField<K extends keyof OutboundHttpEgressConfig>(
  config: MutableEgressConfig,
  key: K,
  value: OutboundHttpEgressConfig[K] | undefined,
): void {
  if (value !== undefined) {
    config[key] = value;
  }
}

function envVarForField(
  env: EnvSource,
  envNames: readonly string[],
): { readonly name: string; readonly value: string } | undefined {
  for (const name of envNames) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return { name, value };
  }
  return undefined;
}

function warnInvalidEgressEnvVar(name: string, key: keyof OutboundHttpEgressConfig): void {
  // Log the variable name only — never the value (may contain credentials).
  // eslint-disable-next-line no-console
  console.warn(
    `[keiko-model-gateway] Ignoring invalid egress env var ${name} (reason: ${key} parse failed)`,
  );
}

export function resolveOutboundHttpEgressConfig(
  raw: unknown,
  env: EnvSource = {},
): OutboundHttpEgressConfig | undefined {
  const block = egressBlock(raw);
  const result: MutableEgressConfig = {};
  for (const { key, parser } of EGRESS_FIELDS) {
    setEgressField(result, key, parser(block[key], `egress.${key}`));
  }
  for (const { key, envNames, parser } of EGRESS_FIELDS) {
    const envVar = envVarForField(env, envNames);
    if (envVar === undefined) continue;
    try {
      setEgressField(result, key, parser(envVar.value, `egress.${key}`));
    } catch {
      warnInvalidEgressEnvVar(envVar.name, key);
    }
  }
  return emptyToUndefined(result);
}

// Parses the four egress env vars INDEPENDENTLY so a malformed proxy URL (e.g. a
// credentialed HTTPS_PROXY) never silently discards a valid caBundlePath or noProxy.
// Each field is parsed in isolation; invalid fields are skipped with a console.warn
// (naming the var, never the value) and the rest are still applied.
export function parseEnvEgressConfigFaultTolerant(env: EnvSource): OutboundHttpEgressConfig {
  return resolveOutboundHttpEgressConfig(undefined, env) ?? {};
}

export function normalizeApiKeyHeaderName(
  value: unknown,
  path: string,
  fallback = DEFAULT_API_KEY_HEADER_NAME,
): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new ConfigInvalidError(`${path} must be a string`);
  }
  const headerName = value.trim().toLowerCase();
  if (headerName.length === 0) {
    return fallback;
  }
  if (
    headerName.length > MAX_API_KEY_HEADER_NAME_LENGTH ||
    !API_KEY_HEADER_NAME_RE.test(headerName)
  ) {
    throw new ConfigInvalidError(`${path} must be a valid HTTP header name`);
  }
  if (!SUPPORTED_API_KEY_HEADER_NAME_SET.has(headerName)) {
    throw new ConfigInvalidError(
      `${path} must be one of ${SUPPORTED_API_KEY_HEADER_NAMES.join(", ")}`,
    );
  }
  return headerName;
}

export function apiKeyHeaderValue(headerName: string, apiKey: string): string {
  if (
    BEARER_API_KEY_HEADER_NAME_SET.has(headerName) &&
    !apiKey.toLowerCase().startsWith("bearer ")
  ) {
    return `Bearer ${apiKey}`;
  }
  return apiKey;
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ConfigInvalidError(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function assertKnownTokenAccountingKeys(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!TOKEN_ACCOUNTING_KNOWN_KEYS.has(key)) {
      throw new ConfigInvalidError(`${path}.${key} is not a recognised token accounting field`);
    }
  }
}

function parseTokenAccounting(value: unknown, path: string): ModelTokenAccounting | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  assertKnownTokenAccountingKeys(value, path);
  const source = requireEnum<ModelTokenAccounting["source"]>(
    value.source,
    `${path}.source`,
    MODEL_TOKEN_ACCOUNTING_SOURCES,
  );
  const counterId = requireNonEmptyTrimmedString(value.counterId, `${path}.counterId`);
  const scaleMilli = requirePositiveInt(value.scaleMilli, `${path}.scaleMilli`);
  const offsetTokens = optionalNonNegativeInt(value.offsetTokens, `${path}.offsetTokens`, 0);
  return {
    source,
    counterId,
    scaleMilli,
    ...(value.offsetTokens === undefined ? {} : { offsetTokens }),
  };
}

function optionalTokenAccountingField(
  value: unknown,
  path: string,
): Partial<Pick<ModelCapability, "tokenAccounting">> {
  const tokenAccounting = parseTokenAccounting(value, path);
  return tokenAccounting === undefined ? {} : { tokenAccounting };
}

function assertKnownPricingKeys(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!PRICING_KNOWN_KEYS.has(key)) {
      throw new ConfigInvalidError(`${path}.${key} is not a recognised pricing field`);
    }
  }
}

function requireNonNegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigInvalidError(`${path} must be a non-negative finite number`);
  }
  return value;
}

// live-journey-readiness-1: public per-million-token USD list price, optional on every capability.
// A model without this block carries no known dollar cost — a spend-budget check on an un-priced
// model must fail closed, never assume free (see coding-sidecar-gateway.ts's
// "spend-pricing-unavailable" reason).
function parsePricing(value: unknown, path: string): ModelCapabilityPricing | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ConfigInvalidError(`${path} must be an object`);
  assertKnownPricingKeys(value, path);
  return {
    inputUsdPerMillionTokens: requireNonNegativeFiniteNumber(
      value.inputUsdPerMillionTokens,
      `${path}.inputUsdPerMillionTokens`,
    ),
    outputUsdPerMillionTokens: requireNonNegativeFiniteNumber(
      value.outputUsdPerMillionTokens,
      `${path}.outputUsdPerMillionTokens`,
    ),
  };
}

function optionalPricingField(
  value: unknown,
  path: string,
): Partial<Pick<ModelCapability, "pricing">> {
  const pricing = parsePricing(value, path);
  return pricing === undefined ? {} : { pricing };
}

// Model id → KEIKO_MODEL_<UPPER>_ form: non-alphanumerics become "_", uppercased.
function envModelToken(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function resolveSecret(modelId: string, fileValue: string, env: EnvSource, suffix: string): string {
  const perModel = env[`KEIKO_MODEL_${envModelToken(modelId)}_${suffix}`];
  if (perModel !== undefined && perModel.length > 0) {
    return perModel;
  }
  if (fileValue.length > 0) {
    return fileValue;
  }
  const fallback = env[`KEIKO_DEFAULT_${suffix}`];
  return fallback ?? "";
}

function resolveSecretRef(
  rawRef: unknown,
  resolver: ProviderSecretResolver | undefined,
): string | undefined {
  if (resolver === undefined || typeof rawRef !== "string" || rawRef.length === 0) {
    return undefined;
  }
  // A resolver fault (e.g. a tampered or unreadable vault) must not crash config parsing; degrade to
  // the next credential source so the provider either resolves elsewhere or fails the explicit
  // "apiKey must be set" check below — never leaking a stack trace or partial key material.
  try {
    const resolved = resolver(rawRef);
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

// Resolves a provider's effective apiKey. Precedence (highest first):
//   1. per-model env  KEIKO_MODEL_<id>_API_KEY        — transient operator override, never persisted
//   2. vault          secretResolver(apiKeySecretRef) — durable encrypted store (Issue #1320)
//   3. file plaintext raw.apiKey                      — legacy, tolerated until migrated to the vault
//   4. default env    KEIKO_DEFAULT_API_KEY           — final fallback
// The env tiers keep their existing positions so environment credentials stay transient and win as
// runtime overrides; the vault simply occupies the slot the legacy plaintext file value used to own.
function resolveProviderApiKey(
  raw: Record<string, unknown>,
  modelId: string,
  fileApiKey: string,
  env: EnvSource,
  options: ParseGatewayConfigOptions,
): string {
  const perModel = env[`KEIKO_MODEL_${envModelToken(modelId)}_API_KEY`];
  if (perModel !== undefined && perModel.length > 0) {
    return perModel;
  }
  const fromVault = resolveSecretRef(raw.apiKeySecretRef, options.secretResolver);
  if (fromVault !== undefined) {
    return fromVault;
  }
  if (fileApiKey.length > 0) {
    return fileApiKey;
  }
  return env.KEIKO_DEFAULT_API_KEY ?? "";
}

function resolveApiKeyHeaderName(
  rawValue: unknown,
  path: string,
  modelId: string,
  env: EnvSource,
): string {
  const token = envModelToken(modelId);
  const perModelName = `KEIKO_MODEL_${token}_API_KEY_HEADER_NAME`;
  const perModel = env[perModelName];
  if (perModel !== undefined && perModel.length > 0) {
    return normalizeApiKeyHeaderName(perModel, perModelName);
  }
  if (rawValue !== undefined) {
    return normalizeApiKeyHeaderName(rawValue, path);
  }
  return normalizeApiKeyHeaderName(
    env.KEIKO_DEFAULT_API_KEY_HEADER_NAME,
    "KEIKO_DEFAULT_API_KEY_HEADER_NAME",
  );
}

// Shared precedence for a per-model override: the per-model env var wins when set and
// non-empty, otherwise the raw config value wins when present at all (even empty string),
// otherwise the default-env fallback applies. Used by resolveProviderEndpointStyle,
// resolveProviderApiVersion, and resolveRealtimeAuthMode, which all resolve a value from the
// same three-source precedence.
function resolvePerModelValue(
  perModel: string | undefined,
  rawValue: unknown,
  defaultValue: string | undefined,
): unknown {
  if (perModel !== undefined && perModel.length > 0) {
    return perModel;
  }
  if (rawValue !== undefined) {
    return rawValue;
  }
  return defaultValue;
}

function resolveProviderEndpointStyle(
  rawValue: unknown,
  path: string,
  modelId: string,
  env: EnvSource,
): ProviderEndpointStyle | undefined {
  const token = envModelToken(modelId);
  const perModelName = `KEIKO_MODEL_${token}_ENDPOINT_STYLE`;
  const perModel = env[perModelName];
  const defaultValue = env.KEIKO_DEFAULT_ENDPOINT_STYLE;
  const value = resolvePerModelValue(perModel, rawValue, defaultValue);
  if (value === undefined || value === "") {
    return undefined;
  }
  return requireEnum<ProviderEndpointStyle>(value, path, PROVIDER_ENDPOINT_STYLES);
}

function resolveProviderApiVersion(
  rawValue: unknown,
  providerPath: string,
  modelId: string,
  env: EnvSource,
  endpointStyle: ProviderEndpointStyle | undefined,
): string | undefined {
  const path = `${providerPath}.apiVersion`;
  const token = envModelToken(modelId);
  const perModelName = `KEIKO_MODEL_${token}_API_VERSION`;
  const perModel = env[perModelName];
  // The GLOBAL default applies only where an api version is meaningful: a provider whose
  // resolved style is not the Azure deployment path must not inherit it, or one
  // KEIKO_DEFAULT_API_VERSION would make every explicitly openai-compatible provider on the
  // same server unparseable through the pairing rule below (review finding on #3042 —
  // per-model and file values stay authoritative and still fail the pairing loudly).
  const defaultValue =
    endpointStyle === "azure-openai-deployment" ? env.KEIKO_DEFAULT_API_VERSION : undefined;
  const value = resolvePerModelValue(perModel, rawValue, defaultValue);
  if (value === undefined || value === "") {
    return undefined;
  }
  const apiVersion = requireNonEmptyString(value, path);
  if (!API_VERSION_RE.test(apiVersion)) {
    throw new ConfigInvalidError(`${path} must be YYYY-MM-DD or YYYY-MM-DD-preview`);
  }
  return apiVersion;
}

function assertProviderEndpointVersion(
  endpointStyle: ProviderEndpointStyle | undefined,
  apiVersion: string | undefined,
  path: string,
): void {
  if (endpointStyle === "azure-openai-deployment" && apiVersion === undefined) {
    throw new ConfigInvalidError(
      `${path}.apiVersion is required when ${path}.endpointStyle is "azure-openai-deployment"`,
    );
  }
  if (endpointStyle !== "azure-openai-deployment" && apiVersion !== undefined) {
    throw new ConfigInvalidError(
      `${path}.apiVersion requires ${path}.endpointStyle to be "azure-openai-deployment"`,
    );
  }
}

function resolveRealtimeAuthMode(
  rawValue: unknown,
  path: string,
  modelId: string,
  env: EnvSource,
): RealtimeAuthMode | undefined {
  const token = envModelToken(modelId);
  const perModelName = `KEIKO_MODEL_${token}_REALTIME_AUTH_MODE`;
  const perModel = env[perModelName];
  const defaultValue = env.KEIKO_DEFAULT_REALTIME_AUTH_MODE;
  const value = resolvePerModelValue(perModel, rawValue, defaultValue);
  if (value === undefined || value === "") {
    return undefined;
  }
  return requireEnum<RealtimeAuthMode>(value, path, REALTIME_AUTH_MODES);
}

function outputTokenParameterConfig(
  value: unknown,
  path: string,
): Pick<ModelProviderConfig, "outputTokenParameter"> {
  if (value === undefined) return {};
  return {
    outputTokenParameter: requireEnum<OutputTokenParameter>(
      value,
      `${path}.outputTokenParameter`,
      OUTPUT_TOKEN_PARAMETERS,
    ),
  };
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  // Real IPv4 loopback only. isIP === 4 guarantees a well-formed dotted-quad, so a "127." prefix
  // here is the 127.0.0.0/8 block — never a domain such as "127.evil.com" or "127.0.0.1.evil.com".
  // The WHATWG URL parser has already canonicalised IPv4 shorthand/hex into url.hostname.
  return isIP(hostname) === 4 && hostname.startsWith("127.");
}

/**
 * Removes ONE trailing slash before a path is joined onto a base URL. A file- or env-authored
 * base URL ending in "/" otherwise yields "//chat/completions", which LiteLLM answers with a
 * 404 (LiteLLM production audit). Deliberately not a normalizer: it strips a single trailing
 * slash and returns everything else untouched, which is exactly what each adapter's inline
 * expression did before this became their single owner (review finding on #3042).
 */
export function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

// eslint-disable-next-line complexity -- URL policy validation intentionally enumerates each reject reason for operator clarity.
export function validateBaseUrl(
  baseUrl: string,
  path: string,
  egress?: OutboundHttpEgressConfig,
): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigInvalidError(`${path}.baseUrl must be a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigInvalidError(`${path}.baseUrl must use the http or https scheme`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigInvalidError(`${path}.baseUrl must not contain a query string or fragment`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ConfigInvalidError(
      `${path}.baseUrl must use https unless it targets localhost or loopback`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigInvalidError(
      `${path}.baseUrl must not embed credentials in the URL; provide the key via apiKey`,
    );
  }
  const blockedReason = outboundTargetBlockedReason(url, egress);
  if (blockedReason !== undefined) {
    throw new ConfigInvalidError(
      `${path}.baseUrl targets a ${blockedReason}; set egress.allowPrivateNetwork=true only for approved customer-hosted providers`,
    );
  }
}

interface ParsedProvider {
  readonly provider: ModelProviderConfig;
  readonly capability?: ModelCapability | undefined;
}

interface ProviderConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

// Modality + determinism capability flags, defaulted to false (lenient provider-inline form).
function providerCapabilityFlags(
  raw: Record<string, unknown>,
  path: string,
): Pick<
  ModelCapability,
  | "toolCalling"
  | "structuredOutput"
  | "streaming"
  | "supportsImageInput"
  | "supportsDocumentInput"
  | "supportsSeeding"
  | "supportsResponseFormat"
  | "supportsInfilling"
> {
  return {
    toolCalling: optionalBoolean(raw.toolCalling, `${path}.toolCalling`, false),
    structuredOutput: optionalBoolean(raw.structuredOutput, `${path}.structuredOutput`, false),
    streaming: optionalBoolean(raw.streaming, `${path}.streaming`, false),
    supportsImageInput: optionalBoolean(
      raw.supportsImageInput,
      `${path}.supportsImageInput`,
      false,
    ),
    supportsDocumentInput: optionalBoolean(
      raw.supportsDocumentInput,
      `${path}.supportsDocumentInput`,
      false,
    ),
    supportsSeeding: optionalBoolean(raw.supportsSeeding, `${path}.supportsSeeding`, false),
    supportsResponseFormat: optionalBoolean(
      raw.supportsResponseFormat,
      `${path}.supportsResponseFormat`,
      false,
    ),
    supportsInfilling: optionalBoolean(raw.supportsInfilling, `${path}.supportsInfilling`, false),
  };
}

// Resolves the optional `infillingAlignment` enum and enforces the two FIM invariants (Issue #1210),
// shared by the lenient inline parser and the strict top-level parser:
//   1. suffix-aware completion is a chat-only capability — `supportsInfilling` must be false for any
//      non-chat kind (defence in depth alongside the contract predicates);
//   2. an alignment posture is meaningless without the capability — `infillingAlignment` requires
//      `supportsInfilling: true`.
// Returns the alignment only when declared so a capability record round-trips exactly.
function resolveInfillingAlignment(
  raw: Record<string, unknown>,
  path: string,
  supportsInfilling: boolean,
  kind: ModelKind,
): { infillingAlignment?: InfillingAlignment } {
  if (supportsInfilling && kind !== "chat") {
    throw new ConfigInvalidError(
      `${path}.supportsInfilling must be false when ${path}.kind is not "chat"`,
    );
  }
  if (raw.infillingAlignment === undefined) {
    return {};
  }
  if (!supportsInfilling) {
    throw new ConfigInvalidError(
      `${path}.infillingAlignment requires ${path}.supportsInfilling to be true`,
    );
  }
  return {
    infillingAlignment: requireEnum<InfillingAlignment>(
      raw.infillingAlignment,
      `${path}.infillingAlignment`,
      ["base", "instruct", "edit-tuned"],
    ),
  };
}

function assertWorkflowEligibleForKind(
  kind: ModelKind,
  workflowEligible: boolean,
  path: string,
): void {
  if (kind !== "chat" && workflowEligible) {
    throw new ConfigInvalidError(
      `${path}.workflowEligible must be false when ${path}.kind is not "chat"`,
    );
  }
}

// Mirrors assertWorkflowEligibleForKind: a chat capability without a positive contextWindow is a
// degraded sentinel that only surfaces later through disconnected downstream symptoms
// (GEN-GATE-CONTEXT-001/004). Voice capabilities deliberately declare contextWindow: 0
// (createDefaultVoiceCapabilityForSetup in gateway-setup.ts), and embedding/ocr-vision have
// their own zero-conventions; both remain unrestricted here. Audit KEIKO-0520.
function assertContextWindowForKind(kind: ModelKind, contextWindow: number, path: string): void {
  if (kind === "chat" && contextWindow <= 0) {
    throw new ConfigInvalidError(
      `${path}.contextWindow must be greater than 0 when ${path}.kind is "chat"`,
    );
  }
}

// PR-review follow-ups on KEIKO-0520 + Codex threads 3770357725 + 3770517473 + 3772192295:
// gateway configs persisted by pre-KEIKO-0520 releases can carry `kind: "chat"` capabilities
// with `contextWindow: 0` because the OLD `createDefaultChatCapability` returned that value
// and gateway setup persisted it. Rejecting them outright at file load would prevent the
// gateway from starting after an upgrade. Migration therefore runs at the FILE-LOAD boundary
// (loadConfigFromFile) and rewrites the raw JSON before it reaches the strict parser.
//
// The migration is gated on TWO conditions that together prove the record is legacy:
//   1. `contextWindow` is the exact legacy value 0 (the pre-KEIKO-0520 factory's output).
//   2. The config root is missing `schemaVersion`, OR carries `schemaVersion: 1` — the
//      pre-KEIKO-0520 shape never wrote this field, and every modern setup / test emits
//      `schemaVersion: 2` or higher (see `GATEWAY_CONFIG_SCHEMA_VERSION`). A modern file with
//      `contextWindow: 0` is a real bug and MUST fail strict parsing so the operator sees
//      the rejection instead of an invented 4096-token capacity.
//
// Direct callers of parseGatewayConfig (setup wizard saves, live validation) never invoke
// this migration, so a wizard bug that emits 0 is still caught. The migration is idempotent
// on legacy files: a fresh run of gateway-setup will overwrite the migrated default with the
// discovered value and stamp `schemaVersion: 2`.
const LEGACY_CHAT_CONTEXT_WINDOW_DEFAULT = 4096;
export const GATEWAY_CONFIG_SCHEMA_VERSION = 2;

function isLegacySchemaRoot(root: Record<string, unknown>): boolean {
  const version = root.schemaVersion;
  if (version === undefined) return true;
  return version === 1;
}

function migrateChatCapabilityContextWindow(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.kind !== "chat") return raw;
  if (raw.contextWindow !== 0) return raw;
  return { ...raw, contextWindow: LEGACY_CHAT_CONTEXT_WINDOW_DEFAULT };
}

export function migrateLegacyChatContextWindows(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (!isLegacySchemaRoot(raw)) return raw;
  const migrated: Record<string, unknown> = { ...raw };
  if (Array.isArray(migrated.capabilities)) {
    migrated.capabilities = (migrated.capabilities as unknown[]).map(
      migrateChatCapabilityContextWindow,
    );
  }
  if (Array.isArray(migrated.providers)) {
    migrated.providers = (migrated.providers as unknown[]).map(migrateProviderCapability);
  }
  return migrated;
}

function migrateProviderCapability(provider: unknown): unknown {
  if (!isRecord(provider) || !isRecord(provider.capability)) return provider;
  return { ...provider, capability: migrateChatCapabilityContextWindow(provider.capability) };
}

// ─── Voice capability parsing (Issue #493, ADR-0100 D5/D7) ─────────────────────
// Shared by both the lenient inline parser and the strict top-level parser so the voice invariants
// are enforced identically. Voice fields are preserved only when declared, so a non-voice capability
// carries no voice fields at all and a record round-trips exactly (same discipline as the infilling
// and determinism optionals).

interface DeclaredVoiceFlags {
  readonly speechInput: boolean | undefined;
  readonly speechOutput: boolean | undefined;
  readonly realtimeVoice: boolean | undefined;
  readonly synthesisInstructions: boolean | undefined;
  readonly semanticTurnDetection: boolean | undefined;
  readonly realtimeTranscriptionModel: string | undefined;
}

// Reads each voice sub-capability flag, present-only (undefined when the operator omitted it).
function readDeclaredVoiceFlags(raw: Record<string, unknown>, path: string): DeclaredVoiceFlags {
  return {
    speechInput:
      raw.supportsSpeechInput !== undefined
        ? requireBoolean(raw.supportsSpeechInput, `${path}.supportsSpeechInput`)
        : undefined,
    speechOutput:
      raw.supportsSpeechOutput !== undefined
        ? requireBoolean(raw.supportsSpeechOutput, `${path}.supportsSpeechOutput`)
        : undefined,
    realtimeVoice:
      raw.supportsRealtimeVoice !== undefined
        ? requireBoolean(raw.supportsRealtimeVoice, `${path}.supportsRealtimeVoice`)
        : undefined,
    synthesisInstructions:
      raw.supportsSpeechSynthesisInstructions !== undefined
        ? requireBoolean(
            raw.supportsSpeechSynthesisInstructions,
            `${path}.supportsSpeechSynthesisInstructions`,
          )
        : undefined,
    semanticTurnDetection:
      raw.supportsSemanticTurnDetection !== undefined
        ? requireBoolean(raw.supportsSemanticTurnDetection, `${path}.supportsSemanticTurnDetection`)
        : undefined,
    realtimeTranscriptionModel:
      raw.realtimeTranscriptionModel !== undefined
        ? requireNonEmptyTrimmedString(
            raw.realtimeTranscriptionModel,
            `${path}.realtimeTranscriptionModel`,
          )
        : undefined,
  };
}

// Voice fields are meaningful only for `kind: "voice"`. A non-voice capability that declares any of
// them is rejected — defence in depth alongside the contract predicates, with a clear error.
function assertNoVoiceFieldsForNonVoiceKind(
  flags: DeclaredVoiceFlags,
  localityDeclared: boolean,
  path: string,
): void {
  const anyDeclared =
    flags.speechInput !== undefined ||
    flags.speechOutput !== undefined ||
    flags.realtimeVoice !== undefined ||
    flags.synthesisInstructions !== undefined ||
    flags.semanticTurnDetection !== undefined ||
    flags.realtimeTranscriptionModel !== undefined ||
    localityDeclared;
  if (anyDeclared) {
    throw new ConfigInvalidError(
      `${path}: voice capability fields require ${path}.kind to be "voice"`,
    );
  }
}

type ParsedVoiceFields = Partial<
  Pick<
    ModelCapability,
    | "supportsSpeechInput"
    | "supportsSpeechOutput"
    | "supportsSpeechSynthesisInstructions"
    | "supportsRealtimeVoice"
    | "supportsSemanticTurnDetection"
    | "realtimeTranscriptionModel"
    | "voiceProviderLocality"
  >
>;

function assertVoiceTuningInvariants(flags: DeclaredVoiceFlags, path: string): void {
  if (flags.synthesisInstructions !== undefined && flags.speechOutput !== true) {
    throw new ConfigInvalidError(
      `${path}.supportsSpeechSynthesisInstructions requires supportsSpeechOutput to be true`,
    );
  }
  if (flags.semanticTurnDetection !== undefined && flags.realtimeVoice !== true) {
    throw new ConfigInvalidError(
      `${path}.supportsSemanticTurnDetection requires supportsRealtimeVoice to be true`,
    );
  }
  if (flags.realtimeTranscriptionModel !== undefined && flags.realtimeVoice !== true) {
    throw new ConfigInvalidError(
      `${path}.realtimeTranscriptionModel requires supportsRealtimeVoice to be true`,
    );
  }
}

function parsedVoiceFlags(flags: DeclaredVoiceFlags): ParsedVoiceFields {
  return {
    ...(flags.speechInput !== undefined ? { supportsSpeechInput: flags.speechInput } : {}),
    ...(flags.speechOutput !== undefined ? { supportsSpeechOutput: flags.speechOutput } : {}),
    ...(flags.synthesisInstructions !== undefined
      ? { supportsSpeechSynthesisInstructions: flags.synthesisInstructions }
      : {}),
    ...(flags.realtimeVoice !== undefined ? { supportsRealtimeVoice: flags.realtimeVoice } : {}),
    ...(flags.semanticTurnDetection !== undefined
      ? { supportsSemanticTurnDetection: flags.semanticTurnDetection }
      : {}),
    ...(flags.realtimeTranscriptionModel !== undefined
      ? { realtimeTranscriptionModel: flags.realtimeTranscriptionModel }
      : {}),
  };
}

// Resolves the voice fields for a `kind: "voice"` capability, enforcing the two voice invariants:
//   1. at least one of speech input / speech output / realtime must be advertised (a voice model
//      with no advertised capability is meaningless — fail-closed);
//   2. the provider locality must be declared (providers are represented explicitly, never inferred
//      from an endpoint URL or environment name — ADR-0100 D7 / the epic invariant).
function resolveVoiceKindFields(
  raw: Record<string, unknown>,
  path: string,
  flags: DeclaredVoiceFlags,
): ParsedVoiceFields {
  if (flags.speechInput !== true && flags.speechOutput !== true && flags.realtimeVoice !== true) {
    throw new ConfigInvalidError(
      `${path} with kind "voice" must advertise at least one of supportsSpeechInput, supportsSpeechOutput, or supportsRealtimeVoice`,
    );
  }
  if (raw.voiceProviderLocality === undefined) {
    throw new ConfigInvalidError(`${path} with kind "voice" must declare voiceProviderLocality`);
  }
  assertVoiceTuningInvariants(flags, path);
  const voiceProviderLocality = requireEnum<VoiceProviderLocality>(
    raw.voiceProviderLocality,
    `${path}.voiceProviderLocality`,
    VOICE_PROVIDER_LOCALITIES,
  );
  return {
    ...parsedVoiceFlags(flags),
    voiceProviderLocality,
  };
}

function parseVoiceCapabilityFields(
  raw: Record<string, unknown>,
  path: string,
  kind: ModelKind,
): ParsedVoiceFields {
  const flags = readDeclaredVoiceFlags(raw, path);
  const localityDeclared = raw.voiceProviderLocality !== undefined;
  if (kind !== "voice") {
    assertNoVoiceFieldsForNonVoiceKind(flags, localityDeclared, path);
    return {};
  }
  return resolveVoiceKindFields(raw, path, flags);
}

// Parses one provider `voiceProfiles` entry into a structurally-valid `VoicePersonaVoice` (Issue
// #1557, ADR-0094 D2): `persona` ∈ VOICE_PERSONAS, `voiceId` a non-empty trimmed string. The
// capability cross-check (voice kind + speech-output/realtime) happens later in `buildGatewayConfig`
// against the MERGED capability, not here.
function parseVoiceProfileEntry(raw: unknown, path: string): VoicePersonaVoice {
  if (!isRecord(raw)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  const persona = requireEnum<VoicePersona>(raw.persona, `${path}.persona`, VOICE_PERSONAS);
  const trimmed = typeof raw.voiceId === "string" ? raw.voiceId.trim() : "";
  if (trimmed.length === 0) {
    throw new ConfigInvalidError(`${path}.voiceId must be a non-empty string`);
  }
  return { persona, voiceId: trimmed };
}

// Parses a provider's optional `voiceProfiles` array (present-only). Rejects a duplicate persona so
// a persona maps to exactly one voice id. Returns undefined when the key is absent so the provider
// record round-trips exactly.
function parseVoiceProfiles(raw: unknown, path: string): readonly VoicePersonaVoice[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ConfigInvalidError(`${path} must be an array`);
  }
  const seen = new Set<VoicePersona>();
  const profiles = raw.map((entry, index) =>
    parseVoiceProfileEntry(entry, `${path}[${String(index)}]`),
  );
  for (const profile of profiles) {
    if (seen.has(profile.persona)) {
      throw new ConfigInvalidError(`${path} declares persona "${profile.persona}" more than once`);
    }
    seen.add(profile.persona);
  }
  return profiles;
}

function buildProviderCapabilityBody(
  raw: Record<string, unknown>,
  path: string,
  id: string,
  kind: ModelKind,
  workflowEligible: boolean,
): ModelCapability {
  const flags = providerCapabilityFlags(raw, path);
  const tokenAccounting = parseTokenAccounting(raw.tokenAccounting, `${path}.tokenAccounting`);
  const contextWindow = optionalNonNegativeInt(raw.contextWindow, `${path}.contextWindow`, 0);
  assertContextWindowForKind(kind, contextWindow, path);
  return {
    id,
    kind,
    contextWindow,
    maxOutputTokens: optionalNonNegativeInt(raw.maxOutputTokens, `${path}.maxOutputTokens`, 0),
    ...(tokenAccounting === undefined ? {} : { tokenAccounting }),
    ...flags,
    ...optionalToolCallingVerification(raw, path, kind),
    ...optionalChatModeDeclaredFlag(raw, path),
    ...optionalReasoningEfforts(raw.reasoningEfforts, `${path}.reasoningEfforts`, kind),
    ...resolveInfillingAlignment(raw, path, flags.supportsInfilling ?? false, kind),
    ...parseVoiceCapabilityFields(raw, path, kind),
    workflowEligible,
    costClass: requireEnum<CostClass>(raw.costClass ?? "medium", `${path}.costClass`, [
      "low",
      "medium",
      "high",
    ]),
    latencyClass: requireEnum<LatencyClass>(
      raw.latencyClass ?? "standard",
      `${path}.latencyClass`,
      ["fast", "standard", "slow"],
    ),
    throughputHint: optionalNonEmptyString(
      raw.throughputHint,
      `${path}.throughputHint`,
      "runtime-configured",
    ),
    preferredUseCases: optionalStringArray(raw.preferredUseCases, `${path}.preferredUseCases`, [
      "Runtime-configured model",
    ]),
    knownLimitations: optionalStringArray(raw.knownLimitations, `${path}.knownLimitations`, [
      "Capabilities are runtime-declared and should be verified in the target environment",
    ]),
  };
}

function parseProviderCapability(
  raw: unknown,
  path: string,
  modelId: string,
): ModelCapability | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  const id = optionalNonEmptyString(raw.id, `${path}.id`, modelId);
  if (id !== modelId) {
    throw new ConfigInvalidError(`${path}.id must match the provider modelId`);
  }
  const kind = requireEnum<ModelKind>(raw.kind, `${path}.kind`, [
    "chat",
    "embedding",
    "ocr-vision",
    "voice",
  ]);
  // Conservative defaults for the per-provider inline capability path (Issue #143).
  // The strict, no-default surface is parseModelCapability for the top-level
  // `capabilities` array. Workflow eligibility is also gated by the chat invariant
  // here so an inline embedding/ocr-vision declaration cannot opt itself in.
  const workflowEligible = optionalBoolean(raw.workflowEligible, `${path}.workflowEligible`, false);
  assertWorkflowEligibleForKind(kind, workflowEligible, path);
  return buildProviderCapabilityBody(raw, path, id, kind, workflowEligible);
}

// Strict, fail-closed parser for explicit wire-facing capability records (Issue #143).
// Used by `parseCapabilityList` against the top-level `capabilities` array. Every
// boolean is REQUIRED here — callers that want a default chat capability call
// `createDefaultChatCapability` instead. Error messages identify the field path
// and never echo sibling-field values; the `ConfigInvalidError` base also runs
// `redact()` so apiKey-shaped substrings are scrubbed defensively.
const MODEL_CAPABILITY_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "contextWindow",
  "maxOutputTokens",
  "toolCalling",
  "toolCallingVerification",
  "structuredOutput",
  "streaming",
  "supportsImageInput",
  "supportsDocumentInput",
  "supportsSeeding",
  "supportsResponseFormat",
  "reasoningEfforts",
  "supportsInfilling",
  "infillingAlignment",
  "chatModeDeclared",
  "supportsSpeechInput",
  "supportsSpeechOutput",
  "supportsSpeechSynthesisInstructions",
  "supportsRealtimeVoice",
  "supportsSemanticTurnDetection",
  "realtimeTranscriptionModel",
  "voiceProviderLocality",
  "workflowEligible",
  "costClass",
  "latencyClass",
  "throughputHint",
  "preferredUseCases",
  "knownLimitations",
  "tokenAccounting",
  "pricing",
]);

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigInvalidError(`${path} must be a boolean`);
  }
  return value;
}

function requireNonNegativeIntStrict(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigInvalidError(`${path} must be a non-negative integer`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigInvalidError(`${path} must be an array of strings`);
  }
  return value as readonly string[];
}

function optionalReasoningEfforts(
  value: unknown,
  path: string,
  kind: ModelKind,
): Partial<Pick<ModelCapability, "reasoningEfforts">> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new ConfigInvalidError(`${path} must be an array`);
  const efforts = value.map((entry, index) =>
    requireEnum<ModelReasoningEffort>(entry, `${path}[${String(index)}]`, MODEL_REASONING_EFFORTS),
  );
  if (kind !== "chat" && efforts.length > 0) {
    throw new ConfigInvalidError(`${path} is only valid for chat models`);
  }
  if (new Set(efforts).size !== efforts.length) {
    throw new ConfigInvalidError(`${path} must not contain duplicates`);
  }
  return efforts.length === 0 ? {} : { reasoningEfforts: efforts };
}

// Optional discovery-mode flag — preserved only when declared so a capability record round-trips
// exactly. Records whether discovery explicitly declared a chat-compatible mode for this model
// (LiteLLM `/model/info` `mode`); the conversation-default preference in keiko-contracts ranks
// mode-declared models ahead of mode-less ones (customer field incident: a mode-less OCR model
// first in the configured list captured the default for every new chat).
function optionalChatModeDeclaredFlag(
  value: Record<string, unknown>,
  path: string,
): Partial<Pick<ModelCapability, "chatModeDeclared">> {
  return value.chatModeDeclared !== undefined
    ? { chatModeDeclared: requireBoolean(value.chatModeDeclared, `${path}.chatModeDeclared`) }
    : {};
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const TOOL_CALLING_VERIFICATION_KEYS = new Set([
  "status",
  "checkedAt",
  "probe",
  "configurationFingerprint",
]);
const TOOL_CALLING_VERIFICATION_STATUSES = new Set<ToolCallingVerification["status"]>([
  "verified",
  "unsupported",
  "unverified",
]);

function isToolCallingVerificationStatus(
  value: unknown,
): value is ToolCallingVerification["status"] {
  return (
    typeof value === "string" &&
    TOOL_CALLING_VERIFICATION_STATUSES.has(value as ToolCallingVerification["status"])
  );
}

function requiredToolCallingVerification(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigInvalidError(`${path}.toolCallingVerification must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !TOOL_CALLING_VERIFICATION_KEYS.has(key));
  if (unknown !== undefined) {
    throw new ConfigInvalidError(`${path}.toolCallingVerification.${unknown} is not recognised`);
  }
  return value;
}

function requiredToolCallingStatus(
  value: unknown,
  path: string,
): ToolCallingVerification["status"] {
  if (!isToolCallingVerificationStatus(value)) {
    throw new ConfigInvalidError(`${path}.toolCallingVerification.status is invalid`);
  }
  return value;
}

function requiredToolCallingTimestamp(value: unknown, path: string): string {
  if (!isCanonicalIsoTimestamp(value)) {
    throw new ConfigInvalidError(
      `${path}.toolCallingVerification.checkedAt must be an ISO-8601 instant`,
    );
  }
  return value;
}

function requiredToolCallingFingerprint(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ConfigInvalidError(
      `${path}.toolCallingVerification.configurationFingerprint must be a SHA-256 hex digest`,
    );
  }
  return value;
}

function optionalToolCallingVerification(
  value: Record<string, unknown>,
  path: string,
  kind: ModelKind,
): Partial<Pick<ModelCapability, "toolCallingVerification">> {
  const raw = value.toolCallingVerification;
  if (raw === undefined) return {};
  if (kind !== "chat") {
    throw new ConfigInvalidError(`${path}.toolCallingVerification is only valid for chat models`);
  }
  const verification = requiredToolCallingVerification(raw, path);
  if (verification.probe !== "gateway-tool-calling-v1") {
    throw new ConfigInvalidError(`${path}.toolCallingVerification.probe is invalid`);
  }
  return {
    toolCallingVerification: {
      status: requiredToolCallingStatus(verification.status, path),
      checkedAt: requiredToolCallingTimestamp(verification.checkedAt, path),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: requiredToolCallingFingerprint(
        verification.configurationFingerprint,
        path,
      ),
    },
  };
}

// Optional determinism flags for the strict list parser — preserved only when declared so a
// capability record round-trips exactly (Epic #761).
function optionalDeterminismFlags(
  value: Record<string, unknown>,
  path: string,
): Partial<Pick<ModelCapability, "supportsSeeding" | "supportsResponseFormat">> {
  return {
    ...(value.supportsSeeding !== undefined
      ? { supportsSeeding: requireBoolean(value.supportsSeeding, `${path}.supportsSeeding`) }
      : {}),
    ...(value.supportsResponseFormat !== undefined
      ? {
          supportsResponseFormat: requireBoolean(
            value.supportsResponseFormat,
            `${path}.supportsResponseFormat`,
          ),
        }
      : {}),
  };
}

// Optional infilling/FIM flags for the strict list parser — preserved only when declared so a
// capability record round-trips exactly (Issue #1210). The two FIM invariants are enforced by the
// shared `resolveInfillingAlignment`.
function optionalInfillingFlags(
  value: Record<string, unknown>,
  path: string,
  kind: ModelKind,
): Partial<Pick<ModelCapability, "supportsInfilling" | "infillingAlignment">> {
  const supportsInfilling =
    value.supportsInfilling !== undefined
      ? requireBoolean(value.supportsInfilling, `${path}.supportsInfilling`)
      : undefined;
  return {
    ...(supportsInfilling !== undefined ? { supportsInfilling } : {}),
    ...resolveInfillingAlignment(value, path, supportsInfilling === true, kind),
  };
}

// Reject unknown top-level keys so an adversarial config cannot smuggle future-named fields past
// the parser. The first offending key is reported by name; values are NEVER echoed.
function assertKnownCapabilityKeys(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!MODEL_CAPABILITY_KNOWN_KEYS.has(key)) {
      throw new ConfigInvalidError(`${path}.${key} is not a recognised capability field`);
    }
  }
}

function parseCapabilityCore(
  value: Record<string, unknown>,
  path: string,
): { id: string; kind: ModelKind; workflowEligible: boolean; contextWindow: number } {
  const id = requireNonEmptyString(value.id, `${path}.id`);
  const kind = requireEnum<ModelKind>(value.kind, `${path}.kind`, [
    "chat",
    "embedding",
    "ocr-vision",
    "voice",
  ]);
  const workflowEligible = requireBoolean(value.workflowEligible, `${path}.workflowEligible`);
  assertWorkflowEligibleForKind(kind, workflowEligible, path);
  const contextWindow = requireNonNegativeIntStrict(value.contextWindow, `${path}.contextWindow`);
  assertContextWindowForKind(kind, contextWindow, path);
  return { id, kind, workflowEligible, contextWindow };
}

export function parseModelCapability(value: unknown, path: string): ModelCapability {
  if (!isRecord(value)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  assertKnownCapabilityKeys(value, path);
  const { id, kind, workflowEligible, contextWindow } = parseCapabilityCore(value, path);
  return {
    id,
    kind,
    contextWindow,
    maxOutputTokens: requireNonNegativeIntStrict(value.maxOutputTokens, `${path}.maxOutputTokens`),
    toolCalling: requireBoolean(value.toolCalling, `${path}.toolCalling`),
    structuredOutput: requireBoolean(value.structuredOutput, `${path}.structuredOutput`),
    streaming: requireBoolean(value.streaming, `${path}.streaming`),
    ...optionalTokenAccountingField(value.tokenAccounting, `${path}.tokenAccounting`),
    ...optionalPricingField(value.pricing, `${path}.pricing`),
    ...optionalToolCallingVerification(value, path, kind),
    supportsImageInput: requireBoolean(value.supportsImageInput, `${path}.supportsImageInput`),
    supportsDocumentInput: requireBoolean(
      value.supportsDocumentInput,
      `${path}.supportsDocumentInput`,
    ),
    ...optionalDeterminismFlags(value, path),
    ...optionalReasoningEfforts(value.reasoningEfforts, `${path}.reasoningEfforts`, kind),
    ...optionalChatModeDeclaredFlag(value, path),
    ...optionalInfillingFlags(value, path, kind),
    ...parseVoiceCapabilityFields(value, path, kind),
    workflowEligible,
    costClass: requireEnum<CostClass>(value.costClass, `${path}.costClass`, [
      "low",
      "medium",
      "high",
    ]),
    latencyClass: requireEnum<LatencyClass>(value.latencyClass, `${path}.latencyClass`, [
      "fast",
      "standard",
      "slow",
    ]),
    throughputHint: requireNonEmptyString(value.throughputHint, `${path}.throughputHint`),
    preferredUseCases: requireStringArray(value.preferredUseCases, `${path}.preferredUseCases`),
    knownLimitations: requireStringArray(value.knownLimitations, `${path}.knownLimitations`),
  };
}

export function parseCapabilityList(value: unknown, path: string): readonly ModelCapability[] {
  if (!Array.isArray(value)) {
    throw new ConfigInvalidError(`${path} must be an array`);
  }
  return value.map((entry, index) => parseModelCapability(entry, `${path}[${String(index)}]`));
}

function resolveProviderConnection(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
  options: ParseGatewayConfigOptions,
): ProviderConnection {
  const fileBaseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
  const fileApiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
  const baseUrl = resolveSecret(modelId, fileBaseUrl, env, "BASE_URL");
  const apiKey = resolveProviderApiKey(raw, modelId, fileApiKey, env, options);
  if (baseUrl.length === 0) {
    throw new ConfigInvalidError(`${path}.baseUrl must be set via config or environment`);
  }
  if (apiKey.length === 0) {
    throw new ConfigInvalidError(
      `${path}.apiKey must be set via config, secret reference, or environment`,
    );
  }
  validateBaseUrl(baseUrl, path, egress);
  return { baseUrl, apiKey };
}

interface ProviderProtocolConfig {
  readonly endpointStyle?: ReturnType<typeof resolveProviderEndpointStyle>;
  readonly apiVersion?: ReturnType<typeof resolveProviderApiVersion>;
  readonly realtimeAuthMode?: ReturnType<typeof resolveRealtimeAuthMode>;
}

function resolveProviderProtocol(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
  env: EnvSource,
): ProviderProtocolConfig {
  const endpointStyle = resolveProviderEndpointStyle(
    raw.endpointStyle,
    `${path}.endpointStyle`,
    modelId,
    env,
  );
  const apiVersion = resolveProviderApiVersion(raw.apiVersion, path, modelId, env, endpointStyle);
  assertProviderEndpointVersion(endpointStyle, apiVersion, path);
  const realtimeAuthMode = resolveRealtimeAuthMode(
    raw.realtimeAuthMode,
    `${path}.realtimeAuthMode`,
    modelId,
    env,
  );
  return { endpointStyle, apiVersion, realtimeAuthMode };
}

function parseProviderConfig(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
  options: ParseGatewayConfigOptions,
): ModelProviderConfig {
  const { baseUrl, apiKey } = resolveProviderConnection(raw, path, modelId, env, egress, options);
  const voiceProfiles = parseVoiceProfiles(raw.voiceProfiles, `${path}.voiceProfiles`);
  const { endpointStyle, apiVersion, realtimeAuthMode } = resolveProviderProtocol(
    raw,
    path,
    modelId,
    env,
  );
  const circuitBreaker = parseOptionalProviderCircuitBreaker(
    raw.circuitBreaker,
    `${path}.circuitBreaker`,
  );
  return {
    modelId,
    baseUrl,
    apiKey,
    apiKeyHeaderName: resolveApiKeyHeaderName(
      raw.apiKeyHeaderName,
      `${path}.apiKeyHeaderName`,
      modelId,
      env,
    ),
    ...(endpointStyle === undefined ? {} : { endpointStyle }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(realtimeAuthMode === undefined ? {} : { realtimeAuthMode }),
    ...outputTokenParameterConfig(raw.outputTokenParameter, path),
    timeoutMs: requirePositiveInt(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS, `${path}.timeoutMs`),
    maxRetries: requireNonNegativeInt(raw.maxRetries ?? DEFAULT_MAX_RETRIES, `${path}.maxRetries`),
    retryBaseDelayMs: requirePositiveInt(
      raw.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      `${path}.retryBaseDelayMs`,
    ),
    ...(voiceProfiles === undefined ? {} : { voiceProfiles }),
    ...(circuitBreaker === undefined ? {} : { circuitBreaker }),
  };
}

function parseProvider(
  raw: unknown,
  index: number,
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
  options: ParseGatewayConfigOptions,
): ParsedProvider {
  const path = `providers[${String(index)}]`;
  if (!isRecord(raw)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  const modelId = requireNonEmptyString(raw.modelId, `${path}.modelId`);
  const capability = parseProviderCapability(raw.capability, `${path}.capability`, modelId);
  return {
    provider: parseProviderConfig(raw, path, modelId, env, egress, options),
    ...(capability === undefined ? {} : { capability }),
  };
}

function requireNonNegativeInt(value: unknown, path: string): number {
  return requireNonNegativeIntStrict(value, path);
}

function parseGroundingLimits(raw: unknown): GroundingLimits | undefined {
  if (!isRecord(raw) || raw.grounding === undefined) {
    return undefined;
  }
  const block = raw.grounding;
  if (!isRecord(block)) {
    throw new ConfigInvalidError("grounding must be an object");
  }
  const partial: { -readonly [K in keyof GroundingLimits]?: number } = {};
  for (const key of Object.keys(DEFAULT_GROUNDING_LIMITS) as (keyof GroundingLimits)[]) {
    const value = block[key];
    if (value !== undefined) {
      // Reject non-integer / non-positive — resolveGroundingLimits silently coerces,
      // but the config layer must fail loudly on a malformed explicit value.
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ConfigInvalidError(`grounding.${key} must be a positive integer`);
      }
      // Over-ceiling values are clamped (not rejected) by resolveGroundingLimits.
      // Record the validated value; the resolver applies the ceiling.
      partial[key] = value;
    }
    // Unknown keys in the grounding block are ignored (forward-compat).
  }
  return resolveGroundingLimits(partial);
}

function rerankerSecret(
  block: Record<string, unknown>,
  env: EnvSource,
  options: ParseGatewayConfigOptions,
): string {
  const envValue = env.KEIKO_RERANKER_API_KEY;
  if (envValue !== undefined && envValue.length > 0) return envValue;
  const fromVault = resolveSecretRef(block.apiKeySecretRef, options.secretResolver);
  if (fromVault !== undefined) return fromVault;
  if (typeof block.apiKey === "string" && block.apiKey.length > 0) return block.apiKey;
  return env.KEIKO_DEFAULT_API_KEY ?? "";
}

function rerankerModelId(block: Record<string, unknown>, env: EnvSource): string {
  const envValue = env.KEIKO_RERANKER_MODEL_ID;
  if (envValue !== undefined && envValue.length > 0) return envValue;
  return requireNonEmptyString(block.modelId, "reranker.modelId");
}

function rerankerBaseUrl(
  block: Record<string, unknown>,
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
): string {
  const envValue = env.KEIKO_RERANKER_BASE_URL;
  let baseUrl: string;
  if (envValue !== undefined && envValue.length > 0) {
    baseUrl = envValue;
  } else if (typeof block.baseUrl === "string") {
    baseUrl = block.baseUrl;
  } else {
    baseUrl = "";
  }
  if (baseUrl.length === 0) {
    throw new ConfigInvalidError("reranker.baseUrl must be set via config or environment");
  }
  validateBaseUrl(baseUrl, "reranker", egress);
  return baseUrl;
}

function rerankerTimeoutMs(block: Record<string, unknown>, env: EnvSource): number {
  const envValue = env.KEIKO_RERANKER_TIMEOUT_MS;
  if (envValue !== undefined && envValue.length > 0) {
    return requirePositiveInt(Number(envValue), "KEIKO_RERANKER_TIMEOUT_MS");
  }
  return requirePositiveInt(block.timeoutMs ?? DEFAULT_TIMEOUT_MS, "reranker.timeoutMs");
}

function rerankerHeaderName(block: Record<string, unknown>, env: EnvSource): string {
  const envValue = env.KEIKO_RERANKER_API_KEY_HEADER_NAME;
  if (envValue !== undefined && envValue.length > 0) {
    return normalizeApiKeyHeaderName(envValue, "KEIKO_RERANKER_API_KEY_HEADER_NAME");
  }
  return normalizeApiKeyHeaderName(block.apiKeyHeaderName, "reranker.apiKeyHeaderName");
}

function parseRerankerConfig(
  raw: unknown,
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
  options: ParseGatewayConfigOptions,
): RerankerConfig | undefined {
  if (!isRecord(raw) || raw.reranker === undefined) {
    return undefined;
  }
  const block = raw.reranker;
  if (!isRecord(block)) {
    throw new ConfigInvalidError("reranker must be an object");
  }
  const apiKey = rerankerSecret(block, env, options);
  if (apiKey.length === 0) {
    throw new ConfigInvalidError(
      "reranker.apiKey must be set via config, secret reference, or environment",
    );
  }
  const config: RerankerConfig = {
    modelId: rerankerModelId(block, env),
    baseUrl: rerankerBaseUrl(block, env, egress),
    apiKey,
    apiKeyHeaderName: rerankerHeaderName(block, env),
    timeoutMs: rerankerTimeoutMs(block, env),
    ...(egress !== undefined ? { egress } : {}),
  };
  return config;
}

function parseFigmaConnectorConfig(raw: unknown): FigmaConnectorConfig | undefined {
  if (!isRecord(raw) || raw.figma === undefined) {
    return undefined;
  }
  const block = raw.figma;
  if (!isRecord(block)) {
    throw new ConfigInvalidError("figma must be an object");
  }
  const accessToken = optionalTrimmedString(block.accessToken, "figma.accessToken");
  return accessToken === undefined ? {} : { accessToken };
}

// Issue #3398: the operator declares a candidate logo URL only. Whether it actually renders is
// decided once, downstream, by `resolvePrDescriptionBrandingFromConfig` reusing
// `validatedPrDescriptionLogoUrl` — never restated here, and never rejected at load time, because
// a bad branding value must degrade to Keiko's text-only attribution, not break config loading.
function parseGatewayBrandingConfig(raw: unknown): GatewayBrandingConfig | undefined {
  if (!isRecord(raw) || raw.branding === undefined) {
    return undefined;
  }
  const block = raw.branding;
  if (!isRecord(block)) {
    throw new ConfigInvalidError("branding must be an object");
  }
  const logoUrl = optionalTrimmedString(block.logoUrl, "branding.logoUrl");
  return logoUrl === undefined ? {} : { logoUrl };
}

/**
 * Resolves the server-configured branding into the exact shape the PR-description renderer
 * consumes. `validatedPrDescriptionLogoUrl` is the single owner of "is this a safe, immutable,
 * publicly hosted HTTPS SVG"; an absent or invalid `branding.logoUrl` yields `{}`, which the
 * renderer's own fallback turns into text-only "by Keiko" attribution — never a thrown error.
 */
export function resolvePrDescriptionBrandingFromConfig(
  config: GatewayConfig,
): PrDescriptionBranding {
  const logoUrl = config.branding?.logoUrl;
  if (logoUrl === undefined) {
    return {};
  }
  const candidate: PrDescriptionBranding = { immutableLogoUrl: logoUrl, availability: "public" };
  return validatedPrDescriptionLogoUrl(candidate) === undefined ? {} : candidate;
}

function parseCircuitBreaker(raw: unknown, path = "circuitBreaker"): CircuitBreakerConfig {
  const source = isRecord(raw) ? raw : {};
  return {
    failureThreshold: requirePositiveInt(
      source.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      `${path}.failureThreshold`,
    ),
    cooldownMs: requirePositiveInt(source.cooldownMs ?? DEFAULT_COOLDOWN_MS, `${path}.cooldownMs`),
    halfOpenProbes: requirePositiveInt(
      source.halfOpenProbes ?? DEFAULT_HALF_OPEN_PROBES,
      `${path}.halfOpenProbes`,
    ),
  };
}

// Per-provider circuitBreaker override (audit KEIKO-0167). Parsed present-only: absent when the
// operator did not declare a provider-level block, so a mixed deployment can leave most providers
// on the shared top-level policy and single out only the ones that need a different threshold
// (e.g. a flakier LiteLLM proxy vs. a strict-latency direct Azure).
//
// PR-review follow-up: an explicit provider-level override must be a real object with only the
// three supported keys. `parseCircuitBreaker` would otherwise coerce a non-record (e.g. the
// string "off") to `{}` and quietly install the built-in defaults as a per-provider override —
// silently replacing a deliberately-tuned top-level policy on `Gateway.breakerFor`. Reject
// malformed shapes explicitly here so validation errors surface at config-parse time.
const CIRCUIT_BREAKER_KEYS = new Set(["failureThreshold", "cooldownMs", "halfOpenProbes"]);
function parseOptionalProviderCircuitBreaker(
  raw: unknown,
  path: string,
): CircuitBreakerConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new ConfigInvalidError(`${path} must be an object when provided`);
  }
  const unknownKey = Object.keys(raw).find((key) => !CIRCUIT_BREAKER_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new ConfigInvalidError(`${path} has unsupported key ${unknownKey}`);
  }
  return parseCircuitBreaker(raw, path);
}

function providersWithEgress(
  parsed: readonly ParsedProvider[],
  egress: OutboundHttpEgressConfig | undefined,
): readonly ModelProviderConfig[] {
  if (egress === undefined) {
    return parsed.map((item) => item.provider);
  }
  return parsed.map((item) => ({ ...item.provider, egress }));
}

function inlineCapabilities(parsed: readonly ParsedProvider[]): readonly ModelCapability[] {
  return parsed
    .map((item) => item.capability)
    .filter((item): item is ModelCapability => item !== undefined);
}

function topLevelCapabilities(raw: Record<string, unknown>): readonly ModelCapability[] {
  // Top-level `capabilities` array is the wire-facing surface for explicit
  // capability records (Issue #143). Validated by the strict parser so a
  // malformed entry fails closed before reaching any consumer.
  return raw.capabilities === undefined
    ? []
    : parseCapabilityList(raw.capabilities, "capabilities");
}

function mergeCapabilities(
  inlineItems: readonly ModelCapability[],
  topLevelItems: readonly ModelCapability[],
): readonly ModelCapability[] {
  const mergedCapabilities = new Map<string, ModelCapability>();
  for (const capability of inlineItems) {
    mergedCapabilities.set(capability.id, capability);
  }
  // Explicit top-level capability records are the authoritative surface for a
  // model id. They must override the inline provider defaults when both exist.
  for (const capability of topLevelItems) {
    mergedCapabilities.set(capability.id, capability);
  }
  return [...mergedCapabilities.values()];
}

// Personas of a provider's voiceProfiles, sorted in canonical VOICE_PERSONAS order and deduped
// (the parser already rejects duplicates; the sort makes the wire surface deterministic).
function personasFromVoiceProfiles(
  voiceProfiles: readonly VoicePersonaVoice[],
): readonly VoicePersona[] {
  const present = new Set<VoicePersona>(voiceProfiles.map((profile) => profile.persona));
  return VOICE_PERSONAS.filter((persona) => present.has(persona));
}

// Derives `supportedVoicePersonas` onto the EFFECTIVE merged capability for one voice provider
// (Issue #1557, ADR-0094 D2 / HAZARD-1): validates against the MERGED capability (not the inline
// one) so a top-level `capabilities` override is the surface personas attach to. Returns a new
// capability carrying the derived field; throws when the provider/capability cannot carry personas.
function deriveSupportedPersonas(
  merged: ReadonlyMap<string, ModelCapability>,
  provider: ModelProviderConfig,
): ModelCapability {
  const { modelId } = provider;
  const capability = merged.get(modelId);
  if (
    capability === undefined ||
    !isVoiceCapability(capability) ||
    !modelSupportsSpeechOutput(capability)
  ) {
    throw new ConfigInvalidError(
      `provider '${modelId}' voiceProfiles requires a kind:"voice" capability that advertises supportsSpeechOutput`,
    );
  }
  return {
    ...capability,
    supportedVoicePersonas: personasFromVoiceProfiles(provider.voiceProfiles ?? []),
  };
}

// Applies persona derivation to the merged capability set: each provider with `voiceProfiles` has
// its effective capability replaced by one carrying `supportedVoicePersonas`. Providers without
// voiceProfiles, and capabilities with no matching provider, pass through unchanged.
function applyVoicePersonaDerivation(
  capabilities: readonly ModelCapability[],
  providers: readonly ModelProviderConfig[],
): readonly ModelCapability[] {
  const byId = new Map<string, ModelCapability>(capabilities.map((cap) => [cap.id, cap]));
  for (const provider of providers) {
    if (provider.voiceProfiles !== undefined) {
      byId.set(provider.modelId, deriveSupportedPersonas(byId, provider));
    }
  }
  return [...byId.values()];
}

function hasCurrentToolCallingVerification(
  verification: ToolCallingVerification | undefined,
  provider: ModelProviderConfig,
  now: number,
): boolean {
  if (
    verification?.status !== "verified" ||
    verification.configurationFingerprint !== toolCallingConfigurationFingerprint(provider)
  ) {
    return false;
  }
  return isToolCallingVerificationFresh(verification, now);
}

function verifiedToolCallingCapability(
  capability: ModelCapability,
  provider: ModelProviderConfig | undefined,
): ModelCapability {
  if (capability.kind !== "chat") return capability;
  if (provider === undefined) return { ...capability, toolCalling: false };
  return hasCurrentToolCallingVerification(
    capability.toolCallingVerification,
    provider,
    Date.now(),
  ) && capability.toolCalling
    ? capability
    : { ...capability, toolCalling: false };
}

function applyToolCallingVerification(
  capabilities: readonly ModelCapability[],
  providers: readonly ModelProviderConfig[],
): readonly ModelCapability[] {
  const providersByModelId = new Map(providers.map((provider) => [provider.modelId, provider]));
  return capabilities.map((capability) =>
    verifiedToolCallingCapability(capability, providersByModelId.get(capability.id)),
  );
}

// Rejects a config in which any two provider entries share the same modelId across the
// merged chat/embedding/voice set (#2906 KEIKO-0567). Gateway's constructor builds a
// modelId→provider Map — a duplicate silently lets the later entry win and routes chat
// requests to the wrong (e.g. voice) provider with no error at setup time.
function assertUniqueProviderModelIds(providers: readonly { readonly modelId: string }[]): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.modelId)) {
      throw new ConfigInvalidError(`duplicate provider modelId '${provider.modelId}'`);
    }
    seen.add(provider.modelId);
  }
}

function buildGatewayConfig(
  raw: Record<string, unknown>,
  providersRaw: readonly unknown[],
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
  options: ParseGatewayConfigOptions,
): GatewayConfig {
  const parsed = providersRaw.map((item, index) =>
    parseProvider(item, index, env, egress, options),
  );
  const providers = providersWithEgress(parsed, egress);
  assertUniqueProviderModelIds(providers);
  const merged = mergeCapabilities(inlineCapabilities(parsed), topLevelCapabilities(raw));
  const capabilities = applyToolCallingVerification(
    applyVoicePersonaDerivation(merged, providers),
    providers,
  );
  const grounding = parseGroundingLimits(raw);
  const reranker = parseRerankerConfig(raw, env, egress, options);
  const figma = parseFigmaConnectorConfig(raw);
  const branding = parseGatewayBrandingConfig(raw);
  return {
    providers,
    circuitBreaker: parseCircuitBreaker(raw.circuitBreaker),
    ...(capabilities.length === 0 ? {} : { capabilities }),
    ...(grounding !== undefined ? { grounding } : {}),
    ...(reranker !== undefined ? { reranker } : {}),
    ...(egress !== undefined ? { egress } : {}),
    ...(figma !== undefined ? { figma } : {}),
    ...(branding !== undefined ? { branding } : {}),
  };
}

export function parseGatewayConfig(
  raw: unknown,
  env: EnvSource = {},
  options: ParseGatewayConfigOptions = {},
): GatewayConfig {
  if (!isRecord(raw)) {
    throw new ConfigInvalidError("config root must be a JSON object");
  }
  const resolvedEgress = resolveOutboundHttpEgressConfig(raw.egress, env);
  const egress =
    options.egressOverride === undefined
      ? resolvedEgress
      : { ...resolvedEgress, ...options.egressOverride };
  const providersRaw = raw.providers;
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    throw new ConfigInvalidError("providers must be a non-empty array");
  }
  return buildGatewayConfig(raw, providersRaw, env, egress, options);
}

function readGatewayConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigInvalidError(`config file could not be read: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigInvalidError(`config file is not valid JSON: ${path}`);
  }
  return parsed;
}

export function loadConfigFromFile(
  path: string,
  env: EnvSource = {},
  options: ParseGatewayConfigOptions = {},
): GatewayConfig {
  // PR-review follow-up (Codex thread 3770357725): migration for pre-KEIKO-0520 persisted
  // configs runs HERE at the file-load boundary — not inside parseGatewayConfig — so a
  // fresh setup wizard save with contextWindow:0 still gets the strict rejection.
  return parseGatewayConfig(
    migrateLegacyChatContextWindows(readGatewayConfigFile(path)),
    env,
    options,
  );
}

export function loadEgressConfigFromFile(
  path: string,
  env: EnvSource = {},
): OutboundHttpEgressConfig | undefined {
  const parsed = readGatewayConfigFile(path);
  if (!isRecord(parsed)) {
    throw new ConfigInvalidError("config root must be a JSON object");
  }
  return resolveOutboundHttpEgressConfig(parsed.egress, env);
}

// Credential- and endpoint-free projection for logging, CLI output, and serialisation.
export function toSafeObject(config: GatewayConfig): SafeGatewayConfig {
  return {
    providers: config.providers.map((provider) => ({
      modelId: provider.modelId,
      credentialHeaderName: provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      retryBaseDelayMs: provider.retryBaseDelayMs,
    })),
    circuitBreaker: config.circuitBreaker,
    // INVARIANT (ADR-0019 / ADR-0094 D2): provider-sensitive data (apiKey, baseUrl, voiceProfiles
    // voice ids, calibrated counter ids) stays on `ModelProviderConfig` or is projected out here.
    // Browser-safe capabilities preserve content-free accounting fields but omit counterId.
    ...(config.capabilities === undefined
      ? {}
      : { capabilities: projectSafeCapabilities(config.capabilities) }),
    ...(config.grounding !== undefined ? { grounding: config.grounding } : {}),
    ...(config.reranker === undefined
      ? {}
      : {
          reranker: {
            modelId: config.reranker.modelId,
            credentialHeaderName: config.reranker.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
            timeoutMs: config.reranker.timeoutMs,
          },
        }),
  };
}
