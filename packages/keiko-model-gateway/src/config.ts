// Gateway config loading, hand-rolled validation, and redaction-aware serialisation.
// No schema library: validation is explicit if/throw with actionable messages.
// API keys are sourced only from environment or the config file, never CLI flags,
// and are excluded from every serialisation path.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  DEFAULT_GROUNDING_LIMITS,
  resolveGroundingLimits,
  type GroundingLimits,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  CircuitBreakerConfig,
  CostClass,
  GatewayConfig,
  LatencyClass,
  ModelCapability,
  ModelKind,
  ModelProviderConfig,
  OutboundHttpEgressConfig,
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
  readonly grounding?: Partial<GroundingLimits> | undefined;
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

function envValue(env: EnvSource, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

function egressBlock(raw: unknown): Record<string, unknown> {
  if (raw !== undefined && !isRecord(raw)) {
    throw new ConfigInvalidError("egress must be an object");
  }
  return isRecord(raw) ? raw : {};
}

function egressValue(
  block: Record<string, unknown>,
  key: string,
  env: EnvSource,
  ...names: readonly string[]
): unknown {
  return block[key] ?? envValue(env, ...names);
}

function emptyToUndefined(config: OutboundHttpEgressConfig): OutboundHttpEgressConfig | undefined {
  return Object.keys(config).length === 0 ? undefined : config;
}

// Parses the four egress env vars INDEPENDENTLY so a malformed proxy URL (e.g. a
// credentialed HTTPS_PROXY) never silently discards a valid caBundlePath or noProxy.
// Each field is parsed in isolation; invalid fields are skipped with a console.warn
// (naming the var, never the value) and the rest are still applied.
export function parseEnvEgressConfigFaultTolerant(env: EnvSource): OutboundHttpEgressConfig {
  const fields: {
    key: keyof OutboundHttpEgressConfig;
    envNames: readonly string[];
    parser: (value: unknown, path: string) => string | readonly string[] | undefined;
  }[] = [
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
  ];
  const result: { -readonly [K in keyof OutboundHttpEgressConfig]?: OutboundHttpEgressConfig[K] } =
    {};
  for (const { key, envNames, parser } of fields) {
    const rawVar = envNames.find((n) => {
      const v = env[n];
      return v !== undefined && v.trim().length > 0;
    });
    if (rawVar === undefined) continue;
    try {
      const parsed = parser(env[rawVar], `egress.${key}`);
      if (parsed !== undefined) {
        // The conditional cast is safe: each branch's parser returns the correct type for that key.
        (result as Record<string, unknown>)[key] = parsed;
      }
    } catch {
      // Log the variable name only — never the value (may contain credentials).
      // eslint-disable-next-line no-console
      console.warn(
        `[keiko-model-gateway] Ignoring invalid egress env var ${rawVar} (reason: ${key} parse failed)`,
      );
    }
  }
  return result;
}

function parseEgressConfig(raw: unknown, env: EnvSource): OutboundHttpEgressConfig | undefined {
  const block = egressBlock(raw);
  const httpProxy = optionalProxyUrl(
    egressValue(block, "httpProxy", env, "KEIKO_HTTP_PROXY", "HTTP_PROXY", "http_proxy"),
    "egress.httpProxy",
  );
  const httpsProxy = optionalProxyUrl(
    egressValue(block, "httpsProxy", env, "KEIKO_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"),
    "egress.httpsProxy",
  );
  const noProxy = optionalNoProxy(
    egressValue(block, "noProxy", env, "KEIKO_NO_PROXY", "NO_PROXY", "no_proxy"),
    "egress.noProxy",
  );
  const caBundlePath = optionalCaBundlePath(
    egressValue(block, "caBundlePath", env, "KEIKO_CA_BUNDLE_PATH"),
    "egress.caBundlePath",
  );
  const config: OutboundHttpEgressConfig = {
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    ...(noProxy !== undefined ? { noProxy } : {}),
    ...(caBundlePath !== undefined ? { caBundlePath } : {}),
  };
  return emptyToUndefined(config);
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
  };
}

function buildProviderCapabilityBody(
  raw: Record<string, unknown>,
  path: string,
  id: string,
  kind: ModelKind,
  workflowEligible: boolean,
): ModelCapability {
  return {
    id,
    kind,
    contextWindow: optionalNonNegativeInt(raw.contextWindow, `${path}.contextWindow`, 0),
    maxOutputTokens: optionalNonNegativeInt(raw.maxOutputTokens, `${path}.maxOutputTokens`, 0),
    ...providerCapabilityFlags(raw, path),
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
  ]);
  // Conservative defaults for the per-provider inline capability path (Issue #143).
  // The strict, no-default surface is parseModelCapability for the top-level
  // `capabilities` array. Workflow eligibility is also gated by the chat invariant
  // here so an inline embedding/ocr-vision declaration cannot opt itself in.
  const workflowEligible = optionalBoolean(raw.workflowEligible, `${path}.workflowEligible`, false);
  if (kind !== "chat" && workflowEligible) {
    throw new ConfigInvalidError(
      `${path}.workflowEligible must be false when ${path}.kind is not "chat"`,
    );
  }
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
  "structuredOutput",
  "streaming",
  "supportsImageInput",
  "supportsDocumentInput",
  "supportsSeeding",
  "supportsResponseFormat",
  "workflowEligible",
  "costClass",
  "latencyClass",
  "throughputHint",
  "preferredUseCases",
  "knownLimitations",
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

// Reject unknown top-level keys so an adversarial config cannot smuggle future-named fields past
// the parser. The first offending key is reported by name; values are NEVER echoed.
function assertKnownCapabilityKeys(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!MODEL_CAPABILITY_KNOWN_KEYS.has(key)) {
      throw new ConfigInvalidError(`${path}.${key} is not a recognised capability field`);
    }
  }
}

export function parseModelCapability(value: unknown, path: string): ModelCapability {
  if (!isRecord(value)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  assertKnownCapabilityKeys(value, path);
  const id = requireNonEmptyString(value.id, `${path}.id`);
  const kind = requireEnum<ModelKind>(value.kind, `${path}.kind`, [
    "chat",
    "embedding",
    "ocr-vision",
  ]);
  const workflowEligible = requireBoolean(value.workflowEligible, `${path}.workflowEligible`);
  if (kind !== "chat" && workflowEligible) {
    throw new ConfigInvalidError(
      `${path}.workflowEligible must be false when ${path}.kind is not "chat"`,
    );
  }
  return {
    id,
    kind,
    contextWindow: requireNonNegativeIntStrict(value.contextWindow, `${path}.contextWindow`),
    maxOutputTokens: requireNonNegativeIntStrict(value.maxOutputTokens, `${path}.maxOutputTokens`),
    toolCalling: requireBoolean(value.toolCalling, `${path}.toolCalling`),
    structuredOutput: requireBoolean(value.structuredOutput, `${path}.structuredOutput`),
    streaming: requireBoolean(value.streaming, `${path}.streaming`),
    supportsImageInput: requireBoolean(value.supportsImageInput, `${path}.supportsImageInput`),
    supportsDocumentInput: requireBoolean(
      value.supportsDocumentInput,
      `${path}.supportsDocumentInput`,
    ),
    ...optionalDeterminismFlags(value, path),
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

function buildGatewayConfig(
  raw: Record<string, unknown>,
  providersRaw: readonly unknown[],
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
): GatewayConfig {
  const parsed = providersRaw.map((item, index) => parseProvider(item, index, env));
  const capabilities = mergeCapabilities(inlineCapabilities(parsed), topLevelCapabilities(raw));
  const grounding = parseGroundingLimits(raw);
  return {
    providers: providersWithEgress(parsed, egress),
    circuitBreaker: parseCircuitBreaker(raw.circuitBreaker),
    ...(capabilities.length === 0 ? {} : { capabilities }),
    ...(grounding !== undefined ? { grounding } : {}),
    ...(egress !== undefined ? { egress } : {}),
  };
}

export function parseGatewayConfig(raw: unknown, env: EnvSource = {}): GatewayConfig {
  if (!isRecord(raw)) {
    throw new ConfigInvalidError("config root must be a JSON object");
  }
  const egress = parseEgressConfig(raw.egress, env);
  const providersRaw = raw.providers;
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    throw new ConfigInvalidError("providers must be a non-empty array");
  }
  return buildGatewayConfig(raw, providersRaw, env, egress);
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
    ...(config.grounding !== undefined ? { grounding: config.grounding } : {}),
  };
}
