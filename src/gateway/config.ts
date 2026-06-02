// Gateway config loading, hand-rolled validation, and redaction-aware serialisation.
// No schema library: validation is explicit if/throw with actionable messages.
// API keys are sourced only from environment or the config file, never CLI flags,
// and are excluded from every serialisation path.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { ConfigInvalidError } from "./errors.js";
import type {
  CircuitBreakerConfig,
  CostClass,
  GatewayConfig,
  LatencyClass,
  ModelCapability,
  ModelKind,
  ModelProviderConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_HALF_OPEN_PROBES = 2;
export const DEFAULT_API_KEY_HEADER_NAME = "authorization";
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

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface SafeProviderConfig {
  readonly modelId: string;
  readonly credentialHeaderName: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface SafeGatewayConfig {
  readonly providers: readonly SafeProviderConfig[];
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[] | undefined;
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

function optionalNonEmptyString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  return requireNonEmptyString(value, path);
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

// Validates a resolved baseUrl for scheme and credential hygiene. Host/IP is
// intentionally NOT restricted: Keiko addresses private network endpoints
// (private IPs are a valid, first-class target); this guard is scheme/credential
// hygiene + defence-in-depth, not host filtering.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  // Real IPv4 loopback only. isIP === 4 guarantees a well-formed dotted-quad, so a "127." prefix
  // here is the 127.0.0.0/8 block — never a domain such as "127.evil.com" or "127.0.0.1.evil.com".
  // The WHATWG URL parser has already canonicalised IPv4 shorthand/hex into url.hostname.
  return isIP(hostname) === 4 && hostname.startsWith("127.");
}

export function validateBaseUrl(baseUrl: string, path: string): void {
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
}

interface ParsedProvider {
  readonly provider: ModelProviderConfig;
  readonly capability?: ModelCapability | undefined;
}

interface ProviderConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
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
  return {
    id,
    kind: requireEnum<ModelKind>(raw.kind, `${path}.kind`, ["chat", "embedding", "ocr-vision"]),
    contextWindow: optionalNonNegativeInt(raw.contextWindow, `${path}.contextWindow`, 0),
    maxOutputTokens: optionalNonNegativeInt(raw.maxOutputTokens, `${path}.maxOutputTokens`, 0),
    toolCalling: optionalBoolean(raw.toolCalling, `${path}.toolCalling`, false),
    structuredOutput: optionalBoolean(raw.structuredOutput, `${path}.structuredOutput`, false),
    streaming: optionalBoolean(raw.streaming, `${path}.streaming`, false),
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

function resolveProviderConnection(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
  env: EnvSource,
): ProviderConnection {
  const fileBaseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
  const fileApiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
  const baseUrl = resolveSecret(modelId, fileBaseUrl, env, "BASE_URL");
  const apiKey = resolveSecret(modelId, fileApiKey, env, "API_KEY");
  if (baseUrl.length === 0) {
    throw new ConfigInvalidError(`${path}.baseUrl must be set via config or environment`);
  }
  if (apiKey.length === 0) {
    throw new ConfigInvalidError(`${path}.apiKey must be set via config or environment`);
  }
  validateBaseUrl(baseUrl, path);
  return { baseUrl, apiKey };
}

function parseProviderConfig(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
  env: EnvSource,
): ModelProviderConfig {
  const { baseUrl, apiKey } = resolveProviderConnection(raw, path, modelId, env);
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
    timeoutMs: requirePositiveInt(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS, `${path}.timeoutMs`),
    maxRetries: requireNonNegativeInt(raw.maxRetries ?? DEFAULT_MAX_RETRIES, `${path}.maxRetries`),
    retryBaseDelayMs: requirePositiveInt(
      raw.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      `${path}.retryBaseDelayMs`,
    ),
  };
}

function parseProvider(raw: unknown, index: number, env: EnvSource): ParsedProvider {
  const path = `providers[${String(index)}]`;
  if (!isRecord(raw)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  const modelId = requireNonEmptyString(raw.modelId, `${path}.modelId`);
  const capability = parseProviderCapability(raw.capability, `${path}.capability`, modelId);
  return {
    provider: parseProviderConfig(raw, path, modelId, env),
    ...(capability === undefined ? {} : { capability }),
  };
}

function requireNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigInvalidError(`${path} must be a non-negative integer`);
  }
  return value;
}

function parseCircuitBreaker(raw: unknown): CircuitBreakerConfig {
  const source = isRecord(raw) ? raw : {};
  return {
    failureThreshold: requirePositiveInt(
      source.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      "circuitBreaker.failureThreshold",
    ),
    cooldownMs: requirePositiveInt(
      source.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      "circuitBreaker.cooldownMs",
    ),
    halfOpenProbes: requirePositiveInt(
      source.halfOpenProbes ?? DEFAULT_HALF_OPEN_PROBES,
      "circuitBreaker.halfOpenProbes",
    ),
  };
}

export function parseGatewayConfig(raw: unknown, env: EnvSource = {}): GatewayConfig {
  if (!isRecord(raw)) {
    throw new ConfigInvalidError("config root must be a JSON object");
  }
  const providersRaw = raw.providers;
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    throw new ConfigInvalidError("providers must be a non-empty array");
  }
  const parsed = providersRaw.map((item, index) => parseProvider(item, index, env));
  const providers = parsed.map((item) => item.provider);
  const capabilities = parsed
    .map((item) => item.capability)
    .filter((item): item is ModelCapability => item !== undefined);
  return {
    providers,
    circuitBreaker: parseCircuitBreaker(raw.circuitBreaker),
    ...(capabilities.length === 0 ? {} : { capabilities }),
  };
}

export function loadConfigFromFile(path: string, env: EnvSource = {}): GatewayConfig {
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
  return parseGatewayConfig(parsed, env);
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
    ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
  };
}
