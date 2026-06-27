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
import { VOICE_PERSONAS, VOICE_PROVIDER_LOCALITIES } from "./types.js";
import {
  isVoiceCapability,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechOutput,
} from "@oscharko-dev/keiko-contracts";
import type {
  CircuitBreakerConfig,
  CostClass,
  FigmaConnectorConfig,
  GatewayConfig,
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
  ModelKind,
  ModelProviderConfig,
  OutboundHttpEgressConfig,
  VoicePersona,
  VoicePersonaVoice,
  VoiceProviderLocality,
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

// Resolves an opaque, NON-SECRET credential reference (persisted in the config file as a provider's
// `apiKeySecretRef`) to its plaintext secret, or undefined when the reference is unknown. The gateway
// stays crypto-free and deterministic: keiko-server / keiko-cli inject a vault-backed resolver
// (Issue #1320), while in-memory configs and tests pass none. A resolver that throws or returns
// undefined degrades to the next credential source, so a missing/locked vault surfaces as the
// existing "apiKey must be set" config error rather than a crash.
export type ProviderSecretResolver = (reference: string) => string | undefined;

export interface ParseGatewayConfigOptions {
  readonly secretResolver?: ProviderSecretResolver | undefined;
}

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

// ─── Voice capability parsing (Issue #493, ADR-0058 D5/D7) ─────────────────────
// Shared by both the lenient inline parser and the strict top-level parser so the voice invariants
// are enforced identically. Voice fields are preserved only when declared, so a non-voice capability
// carries no voice fields at all and a record round-trips exactly (same discipline as the infilling
// and determinism optionals).

interface DeclaredVoiceFlags {
  readonly speechInput: boolean | undefined;
  readonly speechOutput: boolean | undefined;
  readonly realtimeVoice: boolean | undefined;
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
    | "supportsRealtimeVoice"
    | "voiceProviderLocality"
  >
>;

// Resolves the voice fields for a `kind: "voice"` capability, enforcing the two voice invariants:
//   1. at least one of speech input / speech output / realtime must be advertised (a voice model
//      with no advertised capability is meaningless — fail-closed);
//   2. the provider locality must be declared (providers are represented explicitly, never inferred
//      from an endpoint URL or environment name — ADR-0058 D7 / the epic invariant).
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
  const voiceProviderLocality = requireEnum<VoiceProviderLocality>(
    raw.voiceProviderLocality,
    `${path}.voiceProviderLocality`,
    VOICE_PROVIDER_LOCALITIES,
  );
  return {
    ...(flags.speechInput !== undefined ? { supportsSpeechInput: flags.speechInput } : {}),
    ...(flags.speechOutput !== undefined ? { supportsSpeechOutput: flags.speechOutput } : {}),
    ...(flags.realtimeVoice !== undefined ? { supportsRealtimeVoice: flags.realtimeVoice } : {}),
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
  return {
    id,
    kind,
    contextWindow: optionalNonNegativeInt(raw.contextWindow, `${path}.contextWindow`, 0),
    maxOutputTokens: optionalNonNegativeInt(raw.maxOutputTokens, `${path}.maxOutputTokens`, 0),
    ...flags,
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
  "supportsInfilling",
  "infillingAlignment",
  "supportsSpeechInput",
  "supportsSpeechOutput",
  "supportsRealtimeVoice",
  "voiceProviderLocality",
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
    "voice",
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
  validateBaseUrl(baseUrl, path);
  return { baseUrl, apiKey };
}

function parseProviderConfig(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
  env: EnvSource,
  options: ParseGatewayConfigOptions,
): ModelProviderConfig {
  const { baseUrl, apiKey } = resolveProviderConnection(raw, path, modelId, env, options);
  const voiceProfiles = parseVoiceProfiles(raw.voiceProfiles, `${path}.voiceProfiles`);
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
    ...(voiceProfiles === undefined ? {} : { voiceProfiles }),
  };
}

function parseProvider(
  raw: unknown,
  index: number,
  env: EnvSource,
  options: ParseGatewayConfigOptions,
): ParsedProvider {
  const path = `providers[${String(index)}]`;
  if (!isRecord(raw)) {
    throw new ConfigInvalidError(`${path} must be an object`);
  }
  const modelId = requireNonEmptyString(raw.modelId, `${path}.modelId`);
  const capability = parseProviderCapability(raw.capability, `${path}.capability`, modelId);
  return {
    provider: parseProviderConfig(raw, path, modelId, env, options),
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
    !(modelSupportsSpeechOutput(capability) || modelSupportsRealtimeVoice(capability))
  ) {
    throw new ConfigInvalidError(
      `provider '${modelId}' voiceProfiles requires a kind:"voice" capability that advertises supportsSpeechOutput or supportsRealtimeVoice`,
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

function buildGatewayConfig(
  raw: Record<string, unknown>,
  providersRaw: readonly unknown[],
  env: EnvSource,
  egress: OutboundHttpEgressConfig | undefined,
  options: ParseGatewayConfigOptions,
): GatewayConfig {
  const parsed = providersRaw.map((item, index) => parseProvider(item, index, env, options));
  const providers = providersWithEgress(parsed, egress);
  const merged = mergeCapabilities(inlineCapabilities(parsed), topLevelCapabilities(raw));
  const capabilities = applyVoicePersonaDerivation(merged, providers);
  const grounding = parseGroundingLimits(raw);
  const figma = parseFigmaConnectorConfig(raw);
  return {
    providers,
    circuitBreaker: parseCircuitBreaker(raw.circuitBreaker),
    ...(capabilities.length === 0 ? {} : { capabilities }),
    ...(grounding !== undefined ? { grounding } : {}),
    ...(egress !== undefined ? { egress } : {}),
    ...(figma !== undefined ? { figma } : {}),
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
  const egress = resolveOutboundHttpEgressConfig(raw.egress, env);
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
  return parseGatewayConfig(readGatewayConfigFile(path), env, options);
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
    // INVARIANT (ADR-0019 / ADR-0094 D2): `ModelCapability` is the wire-tier, browser-serialisable
    // shape and MUST NEVER carry a secret — all credential-/provider-sensitive data (apiKey, baseUrl,
    // voiceProfiles voice ids) lives on `ModelProviderConfig`, which the allowlisted provider
    // projection above drops. Capabilities are therefore passed through un-projected. Any future
    // sensitive field must go on `ModelProviderConfig`, never here, or this projection must change.
    ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
    ...(config.grounding !== undefined ? { grounding: config.grounding } : {}),
  };
}
