// First-run gateway setup for non-technical UI users. The browser provides a base URL, API token,
// and optionally a Figma PAT; the loopback BFF builds the local provider config, performs a real
// chat-completions smoke call, stores the resulting config on disk with private permissions, and
// updates the in-memory runtime config without exposing credentials back to the browser.

import { resolveEvidenceDir } from "@oscharko-dev/keiko-evidence";
import {
  apiKeyHeaderValue,
  ConfigInvalidError,
  DEFAULT_API_KEY_HEADER_NAME,
  Gateway,
  createDefaultChatCapability,
  listConfiguredCapabilities,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  toSafeObject,
  validateBaseUrl,
} from "@oscharko-dev/keiko-model-gateway";
import { gatewayFetch, readJsonCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { redact } from "@oscharko-dev/keiko-security";
import type {
  EnvSource,
  GatewayConfig,
  ModelCapability,
  ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type {
  GatewayDiscoveredModels,
  GatewayModelDiscoveryOutput,
  RuntimeGatewayConfig,
  UiHandlerDeps,
} from "./deps.js";
import { currentGatewayConfig, currentGatewayEgressConfig } from "./deps.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import {
  classifyFigmaTransportError,
  FigmaConnectorError,
  type FigmaConnectorErrorCode,
} from "./qualityIntelligence/figma/figmaConnectorErrors.js";
import { classifyTokenFailure } from "./qualityIntelligence/figma/figmaTokenSource.js";
import { persistSealedGatewayConfig } from "./credentialPersistence.js";

const MAX_BODY_BYTES = 64_000;
// Issue #144: exported so discovery-normalization tests can pin the slice cap
// without hardcoding the number. The discovery surface is a public seam.
export const MAX_DISCOVERED_MODELS = 100;
const MAX_DEPLOYMENT_NAMES = 100;
const MAX_MODEL_ID_LENGTH = 160;
const DISCOVERED_MODEL_SMOKE_TIMEOUT_MS = 15_000;
const DEPLOYMENT_SMOKE_TIMEOUT_MS = 30_000;
const FIGMA_CREDENTIAL_SMOKE_TIMEOUT_MS = 15_000;
const FIGMA_CREDENTIAL_SMOKE_RESPONSE_BYTES = 64_000;
const SETUP_SMOKE_CONCURRENCY = 4;
const CHAT_COMPATIBLE_MODES = new Set(["chat", "completion", "responses"]);
const EMBEDDING_ID_PATTERN =
  /(?:^|[-_/. ])(?:text-)?embed(?:ding)?s?(?:[-_/. ]|$)|ada-002(?:$|[-_/. ])/i;

type GatewaySetupTester = NonNullable<UiHandlerDeps["gatewaySetupTester"]>;
type GatewayModelDiscovery = NonNullable<UiHandlerDeps["gatewayModelDiscovery"]>;
type FigmaCredentialTester = NonNullable<UiHandlerDeps["figmaCredentialTester"]>;
type GatewayEgressConfig = NonNullable<GatewayConfig["egress"]>;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number";
}

function readBody(req: RouteContext["req"]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/u, "");
  if (value.endsWith("/chat/completions")) {
    value = value.slice(0, -"/chat/completions".length).replace(/\/+$/u, "");
  }
  return value;
}

function candidateBaseUrls(baseUrl: string): readonly string[] {
  const primary = normalizeBaseUrl(baseUrl);
  const candidates = [primary];
  try {
    const url = new URL(primary);
    if (url.hostname.endsWith(".services.ai.azure.com")) {
      const openAiV1 = `${url.origin}/openai/v1`;
      if (url.pathname === "" || url.pathname === "/") {
        candidates.push(`${url.origin}/openai/v1`);
      } else if (primary.endsWith("/openai")) {
        candidates.push(`${primary}/v1`);
      } else if (primary !== openAiV1 && !primary.endsWith("/openai/v1")) {
        candidates.push(openAiV1);
      }
    } else if (!primary.endsWith("/v1")) {
      candidates.push(`${primary}/v1`);
    }
  } catch {
    if (!primary.endsWith("/v1")) {
      candidates.push(`${primary}/v1`);
    }
  }
  return Array.from(new Set(candidates));
}

function isAzureFoundryBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

interface ProviderRawOptions {
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retryBaseDelayMs?: number | undefined;
  readonly apiKeyHeaderName?: string | undefined;
  readonly imageInputModelIds?: readonly string[] | undefined;
  readonly embeddingModelIds?: readonly string[] | undefined;
}

function providerRaw(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  options: ProviderRawOptions = {},
): Record<string, unknown> {
  const defaultCapability =
    options.embeddingModelIds?.includes(modelId) === true
      ? createDefaultEmbeddingCapabilityForSetup(modelId)
      : createDefaultChatCapability(modelId);
  return {
    modelId,
    baseUrl,
    apiKey,
    apiKeyHeaderName: options.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
    capability:
      options.imageInputModelIds?.includes(modelId) === true
        ? { ...defaultCapability, supportsImageInput: true }
        : defaultCapability,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 2,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
  };
}

function isLikelyEmbeddingModelId(modelId: string): boolean {
  return EMBEDDING_ID_PATTERN.test(modelId);
}

function createDefaultEmbeddingCapabilityForSetup(modelId: string): ModelCapability {
  return {
    id: modelId,
    kind: "embedding",
    contextWindow: 8_191,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured embedding endpoint",
    preferredUseCases: ["Embeddings"],
    knownLimitations: [
      "Runtime-configured capability; validate against the target endpoint before production use",
    ],
  };
}

function mergeChatAndEmbeddingModelIds(
  chatModelIds: readonly string[],
  embeddingModelIds: readonly string[],
): readonly string[] {
  const merged = [...chatModelIds];
  const seen = new Set(merged);
  for (const modelId of embeddingModelIds) {
    if (seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    merged.push(modelId);
  }
  return merged;
}

function embeddingModelIdsFromDeployments(deploymentNames: readonly string[]): readonly string[] {
  return deploymentNames.filter(isLikelyEmbeddingModelId);
}

function buildRawConfig(
  baseUrl: string,
  apiKey: string,
  modelIds: readonly string[],
  options: ProviderRawOptions = {},
): Record<string, unknown> {
  return {
    providers: modelIds.map((modelId) => providerRaw(modelId, baseUrl, apiKey, options)),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function currentImageInputModelIds(config: GatewayConfig | undefined): readonly string[] {
  return (
    config?.capabilities
      ?.filter((capability) => capability.kind === "chat" && capability.supportsImageInput)
      .map((capability) => capability.id) ?? []
  );
}

function rawConfigFromCurrent(
  config: GatewayConfig,
  figmaAccessToken: string | undefined,
): Record<string, unknown> {
  return {
    providers: config.providers.map((provider) => {
      const capability = config.capabilities?.find((item) => item.id === provider.modelId);
      return {
        modelId: provider.modelId,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiKeyHeaderName: provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
        timeoutMs: provider.timeoutMs,
        maxRetries: provider.maxRetries,
        retryBaseDelayMs: provider.retryBaseDelayMs,
        ...(capability === undefined ? {} : { capability }),
      };
    }),
    circuitBreaker: config.circuitBreaker,
    ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
    ...(config.grounding === undefined ? {} : { grounding: config.grounding }),
    ...(figmaAccessToken === undefined ? {} : { figma: { accessToken: figmaAccessToken } }),
  };
}

function withInheritedEgress(
  rawConfig: Record<string, unknown>,
  egress: GatewayEgressConfig | undefined,
): Record<string, unknown> {
  if (egress === undefined || Object.hasOwn(rawConfig, "egress")) {
    return rawConfig;
  }
  return { ...rawConfig, egress };
}

function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl}/models`;
}

function modelInfoEndpointCandidates(baseUrl: string): readonly string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  return [`${normalized}/model/info`];
}

function apiKeyHeaders(apiKey: string, apiKeyHeaderName: string): Record<string, string> {
  return { [apiKeyHeaderName]: apiKeyHeaderValue(apiKeyHeaderName, apiKey) };
}

function hasDisallowedModelIdCharacter(id: string): boolean {
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function isUsableModelId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_MODEL_ID_LENGTH && !hasDisallowedModelIdCharacter(id);
}

function modelIdFromKnownFields(item: Record<string, unknown>): string | undefined {
  for (const field of ["id", "model_name", "model", "deployment_name", "deploymentName"]) {
    const value = item[field];
    if (typeof value === "string") {
      const id = value.trim();
      if (isUsableModelId(id)) {
        return id;
      }
    }
  }
  return undefined;
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function modelModeFromDiscoveryItem(item: Record<string, unknown>): string | undefined {
  const modelInfo = nestedRecord(item, "model_info");
  const litellmParams = nestedRecord(item, "litellm_params");
  const candidates = [item.mode, modelInfo?.mode, litellmParams?.mode];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

function isExplicitlyEmbeddingModel(item: Record<string, unknown>): boolean {
  return modelModeFromDiscoveryItem(item) === "embedding";
}

// Issue #144: exported as part of the discovery-normalization seam so a
// sibling test file can drive it with synthetic payloads. Behaviour unchanged
// — only the visibility is widened.
export function isExplicitlyNonChatModel(item: Record<string, unknown>): boolean {
  const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
  if (capabilities?.chat_completion === false) {
    return true;
  }
  const mode = modelModeFromDiscoveryItem(item);
  return mode !== undefined && !CHAT_COMPATIBLE_MODES.has(mode);
}

type DiscoveryModelKind = "chat" | "embedding";

interface ClassifiedDiscoveryModel {
  readonly id: string;
  readonly kind: DiscoveryModelKind;
}

function classifyDiscoveryItem(item: unknown): ClassifiedDiscoveryModel | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const id = modelIdFromKnownFields(item);
  if (id === undefined) {
    return undefined;
  }
  if (isExplicitlyEmbeddingModel(item)) {
    return { id, kind: "embedding" };
  }
  if (isExplicitlyNonChatModel(item)) {
    return isLikelyEmbeddingModelId(id) ? { id, kind: "embedding" } : undefined;
  }
  return isLikelyEmbeddingModelId(id) ? { id, kind: "embedding" } : { id, kind: "chat" };
}

// Issue #144: exported as part of the discovery-normalization seam. Gateway setup now returns
// embedding-capable records so setup can persist them for Local Knowledge while keeping them out of
// chat.
// Returns undefined for unknown/non-record/unsupported/malformed input so
// callers can drop the entry silently and keep healthy peers.
export function modelIdFromDiscoveryItem(item: unknown): string | undefined {
  return classifyDiscoveryItem(item)?.id;
}

// Issue #144: exported as part of the discovery-normalization seam. Throws on schema-level
// malformation (no data array) and on the "every entry filtered" terminal case so the caller
// (production path) returns an honest error rather than a silently-empty model list.
export function parseModelDiscovery(payload: unknown): GatewayDiscoveredModels {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("model discovery response must contain a data array");
  }
  const entries: ClassifiedDiscoveryModel[] = [];
  const seen = new Set<string>();
  for (const item of payload.data) {
    const classified = classifyDiscoveryItem(item);
    if (classified !== undefined && !seen.has(classified.id)) {
      seen.add(classified.id);
      entries.push(classified);
    }
  }
  const limited = entries.slice(0, MAX_DISCOVERED_MODELS);
  if (limited.length === 0) {
    throw new Error("model discovery returned no model ids");
  }
  return {
    modelIds: limited.map((entry) => entry.id),
    chatModelIds: limited.filter((entry) => entry.kind === "chat").map((entry) => entry.id),
    embeddingModelIds: limited
      .filter((entry) => entry.kind === "embedding")
      .map((entry) => entry.id),
  };
}

export function parseModelList(payload: unknown): readonly string[] {
  return parseModelDiscovery(payload).modelIds;
}

// Issue #144 AC #4: the public discovery-normalization seam. Test target. Pure
// wrapper around `parseModelList` so the AC ("Discovery handles additional
// customer gateway models without requiring code changes for each model name")
// can be pinned against a stable export name even if the internal helper is
// reshaped later.
export function normalizeDiscoveryPayload(payload: unknown): readonly string[] {
  return parseModelList(payload);
}

export function normalizeDiscoveryPayloadForSetup(payload: unknown): GatewayDiscoveredModels {
  return parseModelDiscovery(payload);
}

async function fetchDiscoveryJson(
  url: string,
  apiKey: string,
  apiKeyHeaderName: string,
  egress?: GatewayEgressConfig,
): Promise<unknown> {
  const response = await gatewayFetch(url, {
    method: "GET",
    headers: apiKeyHeaders(apiKey, apiKeyHeaderName),
    signal: AbortSignal.timeout(30_000),
    ...(egress !== undefined ? { egress } : {}),
  });
  if (!response.ok) {
    throw new Error(`model discovery returned HTTP ${String(response.status)}`);
  }
  try {
    return await readJsonCapped(response);
  } catch {
    throw new Error("model discovery response was not readable JSON");
  }
}

async function discoverLiteLlmModelInfo(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
  egress?: GatewayEgressConfig,
): Promise<GatewayDiscoveredModels | undefined> {
  for (const endpoint of modelInfoEndpointCandidates(baseUrl)) {
    try {
      return parseModelDiscovery(
        await fetchDiscoveryJson(endpoint, apiKey, apiKeyHeaderName, egress),
      );
    } catch {
      // /model/info is a LiteLLM-specific enrichment endpoint. If it is absent or blocked,
      // continue with OpenAI-compatible /models discovery so customer gateways are not broken.
    }
  }
  return undefined;
}

async function defaultGatewayModelDiscovery(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName = DEFAULT_API_KEY_HEADER_NAME,
  egress?: GatewayEgressConfig,
): Promise<GatewayDiscoveredModels> {
  const litellmModels = await discoverLiteLlmModelInfo(baseUrl, apiKey, apiKeyHeaderName, egress);
  if (litellmModels !== undefined) {
    return litellmModels;
  }
  return parseModelDiscovery(
    await fetchDiscoveryJson(modelsEndpoint(baseUrl), apiKey, apiKeyHeaderName, egress),
  );
}

function deploymentNameValues(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") {
    return value.split(/[\n,]/u);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

function normalizeDeploymentNames(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)));
}

function parseDeploymentNames(value: unknown): readonly string[] | RouteResult {
  if (value === undefined) {
    return [];
  }
  const values = deploymentNameValues(value);
  if (values === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "deploymentNames must be a string or an array of strings."),
    };
  }
  const names = normalizeDeploymentNames(values);
  if (names.length > MAX_DEPLOYMENT_NAMES) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "deploymentNames exceeds the model setup limit."),
    };
  }
  if (names.some((name) => !isUsableModelId(name))) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "deploymentNames contains an invalid model id."),
    };
  }
  return names;
}

function parseImageInputModelIds(value: unknown): readonly string[] | RouteResult {
  if (value === undefined) {
    return [];
  }
  const values = deploymentNameValues(value);
  if (values === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "imageInputModelIds must be a string or an array of strings."),
    };
  }
  const names = normalizeDeploymentNames(values);
  if (names.length > MAX_DEPLOYMENT_NAMES) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "imageInputModelIds exceeds the model setup limit."),
    };
  }
  if (names.some((name) => !isUsableModelId(name))) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "imageInputModelIds contains an invalid model id."),
    };
  }
  return names;
}

function validateSetupConnection(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
  env: EnvSource,
): RouteResult | undefined {
  try {
    parseGatewayConfig(
      buildRawConfig(baseUrl, apiKey, ["setup-validation"], { apiKeyHeaderName }),
      env,
    );
    return undefined;
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    throw error;
  }
}

// Issue #144: pure smoke-test loop extracted from `defaultGatewaySetupTester`
// for testability. Concurrency is a parameter so callers (tests) can pin peak
// in-flight count deterministically. Original-order preservation among
// survivors is part of the observable contract — pinned by gateway-setup tests
// that assert tested-model-id order matches input order with failed entries
// dropped.
//
// Throws with the exact error message that `defaultGatewaySetupTester` has
// always thrown so existing call sites and tests keep compiling.
export async function smokeTestCandidates(
  candidates: readonly string[],
  probe: (modelId: string) => Promise<void>,
  concurrency: number,
): Promise<readonly string[]> {
  const tested = Array<string | undefined>(candidates.length).fill(undefined);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const index = next;
      next += 1;
      const modelId = candidates[index];
      if (modelId === undefined) {
        continue;
      }
      try {
        await probe(modelId);
        tested[index] = modelId;
      } catch {
        // Probe rejection is the documented signal that this candidate is not
        // chat-callable. We drop it silently so healthy peers still surface.
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const accepted = tested.filter((modelId): modelId is string => modelId !== undefined);
  if (accepted.length === 0) {
    throw new Error("no discovered model accepted the chat-completions smoke test");
  }
  return accepted;
}

async function defaultGatewaySetupTester(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
): Promise<readonly string[]> {
  const gateway = new Gateway(config);
  return smokeTestCandidates(
    candidateModelIds,
    async (modelId) => {
      await gateway.chat({
        modelId,
        messages: [
          { role: "system", content: CONVERSATION_SYSTEM_PROMPT },
          { role: "user", content: "Reply with exactly: OK" },
        ],
      });
    },
    SETUP_SMOKE_CONCURRENCY,
  );
}

const FIGMA_ME_ENDPOINT = "https://api.figma.com/v1/me";

function figmaReason(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const reason = body.err ?? body.message;
  return typeof reason === "string" ? reason : undefined;
}

async function defaultFigmaCredentialTester(
  accessToken: string,
  egress?: GatewayEgressConfig,
): Promise<void> {
  try {
    const response = await gatewayFetch(FIGMA_ME_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Figma-Token": accessToken,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FIGMA_CREDENTIAL_SMOKE_TIMEOUT_MS),
      ...(egress !== undefined ? { egress } : {}),
    });
    let body: unknown;
    try {
      body = await readJsonCapped(response, FIGMA_CREDENTIAL_SMOKE_RESPONSE_BYTES);
    } catch {
      throw new FigmaConnectorError("FIGMA_RESPONSE_TOO_LARGE");
    }
    if (!response.ok) {
      throw classifyTokenFailure(response.status, figmaReason(body));
    }
    if (!isRecord(body)) {
      throw new FigmaConnectorError("FIGMA_INTERNAL");
    }
  } catch (error) {
    if (error instanceof FigmaConnectorError) {
      throw error;
    }
    throw new FigmaConnectorError(classifyFigmaTransportError(error));
  }
}

// Seals the verified raw config's secrets into their local vaults and writes a credential-free
// keiko.config.json (Issue #1320). `deps.evidenceDir` is the resolved evidence root used by the
// encrypted Figma PAT vault; it is resolved defensively so persistence never depends on the optional
// field being pre-populated.
function persistGatewayConfig(
  raw: Record<string, unknown>,
  storagePath: string,
  deps: UiHandlerDeps,
): void {
  persistSealedGatewayConfig(raw, {
    env: deps.env,
    storagePath,
    evidenceDir: resolveEvidenceDir(deps.evidenceDir, deps.env),
  });
}

interface SetupRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
  readonly figmaAccessToken: string | undefined;
  readonly verifyGateway: boolean;
  readonly verifyFigmaCredential: boolean;
}

interface SetupModelLists {
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
}

interface SetupGatewayCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
}

function normalizeSetupApiKeyHeaderName(value: unknown): string | RouteResult {
  try {
    return normalizeApiKeyHeaderName(value, "apiKeyHeaderName", DEFAULT_API_KEY_HEADER_NAME);
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    throw error;
  }
}

function readSetupModelLists(raw: Record<string, unknown>): SetupModelLists | RouteResult {
  const deploymentNames = parseDeploymentNames(raw.deploymentNames);
  if (isRouteResult(deploymentNames)) {
    return deploymentNames;
  }
  const imageInputModelIds = parseImageInputModelIds(raw.imageInputModelIds);
  if (isRouteResult(imageInputModelIds)) {
    return imageInputModelIds;
  }
  return { deploymentNames, imageInputModelIds };
}

function optionalSetupSecret(value: unknown, path: string): string | RouteResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return { status: 400, body: errorBody("BAD_REQUEST", `${path} must be a string.`) };
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function hasNonBlankStringField(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyListField(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value === "string") {
    return normalizeDeploymentNames(deploymentNameValues(value) ?? []).length > 0;
  }
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim());
}

function shouldPreserveExisting(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
): boolean {
  return raw.preserveExisting === true && current !== undefined;
}

function firstProvider(current: GatewayConfig | undefined): ModelProviderConfig | undefined {
  return current?.providers[0];
}

function trimmedSubmittedString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function submittedOrInheritedString(
  raw: Record<string, unknown>,
  key: string,
  inherited: string | undefined,
  preserveExisting: boolean,
): string {
  return trimmedSubmittedString(raw, key) ?? (preserveExisting ? (inherited ?? "") : "");
}

function setupApiKeyHeaderSource(
  raw: Record<string, unknown>,
  provider: ModelProviderConfig | undefined,
  preserveExisting: boolean,
): unknown {
  if (raw.apiKeyHeaderName !== undefined || !preserveExisting) {
    return raw.apiKeyHeaderName;
  }
  return provider?.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
}

function readSetupGatewayCredentials(
  raw: Record<string, unknown>,
  env: EnvSource,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
): SetupGatewayCredentials | RouteResult {
  const provider = firstProvider(current);
  const baseUrl = submittedOrInheritedString(raw, "baseUrl", provider?.baseUrl, preserveExisting);
  const apiKey = submittedOrInheritedString(raw, "apiKey", provider?.apiKey, preserveExisting);
  if (baseUrl.length === 0 || apiKey.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "baseUrl and apiKey are required.") };
  }
  const apiKeyHeaderSource = setupApiKeyHeaderSource(raw, provider, preserveExisting);
  const apiKeyHeaderName = normalizeSetupApiKeyHeaderName(apiKeyHeaderSource);
  if (isRouteResult(apiKeyHeaderName)) {
    return apiKeyHeaderName;
  }
  const invalidConnection = validateSetupConnection(baseUrl, apiKey, apiKeyHeaderName, env);
  if (invalidConnection !== undefined) {
    return invalidConnection;
  }
  return { baseUrl, apiKey, apiKeyHeaderName };
}

function resolveSetupModelLists(
  modelLists: SetupModelLists,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
): SetupModelLists {
  const existing = preserveExisting ? current : undefined;
  return {
    deploymentNames:
      existing !== undefined && modelLists.deploymentNames.length === 0
        ? existing.providers.map((item) => item.modelId)
        : modelLists.deploymentNames,
    imageInputModelIds:
      existing !== undefined && modelLists.imageInputModelIds.length === 0
        ? currentImageInputModelIds(existing)
        : modelLists.imageInputModelIds,
  };
}

function setupRequiresGatewayVerification(
  raw: Record<string, unknown>,
  preserveExisting: boolean,
): boolean {
  return (
    !preserveExisting ||
    hasNonBlankStringField(raw, "baseUrl") ||
    hasNonBlankStringField(raw, "apiKey") ||
    hasNonBlankStringField(raw, "apiKeyHeaderName") ||
    hasNonEmptyListField(raw, "deploymentNames") ||
    hasNonEmptyListField(raw, "imageInputModelIds")
  );
}

function readSetupRequest(
  raw: unknown,
  env: EnvSource,
  current: GatewayConfig | undefined,
): SetupRequest | RouteResult {
  if (!isRecord(raw)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  const preserveExisting = shouldPreserveExisting(raw, current);
  const credentials = readSetupGatewayCredentials(raw, env, current, preserveExisting);
  if (isRouteResult(credentials)) {
    return credentials;
  }
  const modelLists = readSetupModelLists(raw);
  if (isRouteResult(modelLists)) {
    return modelLists;
  }
  const figmaAccessToken = optionalSetupSecret(raw.figmaAccessToken, "figmaAccessToken");
  if (isRouteResult(figmaAccessToken)) {
    return figmaAccessToken;
  }
  const resolvedModelLists = resolveSetupModelLists(modelLists, current, preserveExisting);
  return {
    ...credentials,
    deploymentNames: resolvedModelLists.deploymentNames,
    imageInputModelIds: resolvedModelLists.imageInputModelIds,
    figmaAccessToken: figmaAccessToken ?? current?.figma?.accessToken,
    verifyGateway: setupRequiresGatewayVerification(raw, preserveExisting),
    verifyFigmaCredential: figmaAccessToken !== undefined,
  };
}

function safeError(error: unknown, secrets: readonly (string | undefined)[]): string {
  const concreteSecrets = secrets.filter((secret): secret is string => secret !== undefined);
  if (error instanceof Error) {
    return redact(error.message, concreteSecrets);
  }
  return "Gateway setup failed.";
}

interface VerifiedSetup {
  readonly rawConfig: Record<string, unknown>;
  readonly config: GatewayConfig;
  readonly testedModelIds: readonly string[];
  readonly skippedModelIds: readonly string[];
}

interface SetupVerificationInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
  readonly tester: GatewaySetupTester;
  readonly discovery: GatewayModelDiscovery;
  readonly env: EnvSource;
  readonly egress: GatewayEgressConfig | undefined;
  readonly figmaAccessToken: string | undefined;
  readonly current: GatewayConfig | undefined;
}

interface SetupCandidateModels {
  readonly modelIds: readonly string[];
  readonly chatModelIds: readonly string[];
  readonly embeddingModelIds: readonly string[];
}

function assertImageInputModelsWereTested(
  imageInputModelIds: readonly string[],
  testedModelIds: readonly string[],
): void {
  if (imageInputModelIds.length === 0) return;
  const tested = new Set(testedModelIds);
  if (imageInputModelIds.some((modelId) => !tested.has(modelId))) {
    throw new Error("imageInputModelIds must match tested chat-callable model ids.");
  }
}

function validationConfigForSetup(input: SetupVerificationInput): GatewayConfig {
  const validationRawConfig = buildRawConfig(input.baseUrl, input.apiKey, ["setup-validation"], {
    apiKeyHeaderName: input.apiKeyHeaderName,
    imageInputModelIds: input.imageInputModelIds,
  });
  return parseGatewayConfig(withInheritedEgress(validationRawConfig, input.egress), input.env);
}

function normalizeLegacyDiscoveryResult(modelIds: readonly string[]): SetupCandidateModels {
  const embeddingModelIds = embeddingModelIdsFromDeployments(modelIds);
  const embeddingSet = new Set(embeddingModelIds);
  return {
    modelIds,
    chatModelIds: modelIds.filter((modelId) => !embeddingSet.has(modelId)),
    embeddingModelIds,
  };
}

function isStructuredDiscoveryResult(
  result: GatewayModelDiscoveryOutput,
): result is GatewayDiscoveredModels {
  if (Array.isArray(result)) {
    return false;
  }
  const candidate = result as Partial<GatewayDiscoveredModels>;
  return (
    Array.isArray(candidate.modelIds) &&
    Array.isArray(candidate.chatModelIds) &&
    Array.isArray(candidate.embeddingModelIds)
  );
}

function normalizeDiscoveryResult(result: GatewayModelDiscoveryOutput): SetupCandidateModels {
  if (isStructuredDiscoveryResult(result)) {
    return {
      modelIds: result.modelIds,
      chatModelIds: result.chatModelIds,
      embeddingModelIds: result.embeddingModelIds,
    };
  }
  return normalizeLegacyDiscoveryResult(result);
}

function candidateModelsFromDeploymentNames(
  deploymentNames: readonly string[],
): SetupCandidateModels {
  const embeddingModelIds = embeddingModelIdsFromDeployments(deploymentNames);
  const embeddingSet = new Set(embeddingModelIds);
  return {
    modelIds: deploymentNames,
    chatModelIds: deploymentNames.filter((modelId) => !embeddingSet.has(modelId)),
    embeddingModelIds,
  };
}

async function candidateModelIdsForSetup(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
): Promise<SetupCandidateModels> {
  if (input.deploymentNames.length > 0) {
    return candidateModelsFromDeploymentNames(input.deploymentNames);
  }
  return normalizeDiscoveryResult(
    await input.discovery(
      input.baseUrl,
      input.apiKey,
      input.apiKeyHeaderName,
      validationConfig.egress,
    ),
  );
}

function finalRawConfigForSetup(
  input: SetupVerificationInput,
  testedModelIds: readonly string[],
  embeddingModelIds: readonly string[],
): Record<string, unknown> {
  const configuredModelIds = mergeChatAndEmbeddingModelIds(testedModelIds, embeddingModelIds);
  const rawConfig = buildRawConfig(input.baseUrl, input.apiKey, configuredModelIds, {
    apiKeyHeaderName: input.apiKeyHeaderName,
    imageInputModelIds: input.imageInputModelIds,
    embeddingModelIds,
  });
  return {
    ...rawConfig,
    ...(input.current?.grounding === undefined ? {} : { grounding: input.current.grounding }),
    ...(input.figmaAccessToken === undefined
      ? {}
      : { figma: { accessToken: input.figmaAccessToken } }),
  };
}

function skippedModelIdsForSetup(
  candidateModelIds: readonly string[],
  testedModelIds: readonly string[],
  embeddingModelIds: readonly string[],
): readonly string[] {
  const acceptedModelIds = new Set([...testedModelIds, ...embeddingModelIds]);
  return candidateModelIds.filter((modelId) => !acceptedModelIds.has(modelId));
}

async function verifySetupCandidate(input: SetupVerificationInput): Promise<VerifiedSetup> {
  // Defence-in-depth: never send the credential to a candidate URL that has not passed the same
  // scheme/credential/loopback validation as the originally submitted base URL.
  validateBaseUrl(input.baseUrl, "candidate");
  const validationConfig = validationConfigForSetup(input);
  const candidateModels = await candidateModelIdsForSetup(input, validationConfig);
  const smokeTimeoutMs =
    input.deploymentNames.length > 0
      ? DEPLOYMENT_SMOKE_TIMEOUT_MS
      : DISCOVERED_MODEL_SMOKE_TIMEOUT_MS;
  const candidateRawConfig = buildRawConfig(
    input.baseUrl,
    input.apiKey,
    candidateModels.chatModelIds,
    {
      apiKeyHeaderName: input.apiKeyHeaderName,
      timeoutMs: smokeTimeoutMs,
      // One retry (not zero) so a single transient blip — 429 rate-limit, brief timeout, momentary
      // content-filter — does not permanently exclude an otherwise-working model from the setup and
      // brand it to the user as incompatible. Still bounded so setup latency stays predictable.
      maxRetries: 1,
      imageInputModelIds: input.imageInputModelIds,
    },
  );
  const candidateConfig = parseGatewayConfig(
    withInheritedEgress(candidateRawConfig, input.egress),
    input.env,
  );
  const testedModelIds = await input.tester(candidateConfig, candidateModels.chatModelIds);
  assertImageInputModelsWereTested(input.imageInputModelIds, testedModelIds);
  const rawConfigWithOptionalBlocks = finalRawConfigForSetup(
    input,
    testedModelIds,
    candidateModels.embeddingModelIds,
  );
  const config = parseGatewayConfig(
    withInheritedEgress(rawConfigWithOptionalBlocks, input.egress),
    input.env,
  );
  return {
    rawConfig: rawConfigWithOptionalBlocks,
    config,
    testedModelIds,
    skippedModelIds: skippedModelIdsForSetup(
      candidateModels.modelIds,
      testedModelIds,
      candidateModels.embeddingModelIds,
    ),
  };
}

function setupSuccessResult(
  config: GatewayConfig,
  testedModelIds: readonly string[],
  skippedModelIds: readonly string[],
): RouteResult {
  const testedModelId = testedModelIds[0] ?? "unknown";
  return {
    status: 200,
    body: {
      ok: true,
      testedModelId,
      testedModelIds,
      skippedModelIds,
      providerCount: config.providers.length,
      models: listConfiguredCapabilities(config),
      config: toSafeObject(config),
    },
  };
}

function setupFailureResult(errors: readonly string[]): RouteResult {
  return {
    status: 502,
    body: errorBody(
      "GATEWAY_SETUP_FAILED",
      `Credentials could not be verified. ${errors.join(" ")}`,
    ),
  };
}

function figmaFailureStatus(code: FigmaConnectorErrorCode): number {
  switch (code) {
    case "FIGMA_TOKEN_INVALID":
    case "FIGMA_TOKEN_EXPIRED":
    case "FIGMA_TOKEN_REVOKED":
    case "FIGMA_INSUFFICIENT_SCOPE":
    case "FIGMA_CONSENT_REQUIRED":
      return 400;
    case "FIGMA_RATE_LIMITED":
      return 429;
    default:
      return 502;
  }
}

function figmaCredentialFailureResult(error: unknown, request: SetupRequest): RouteResult {
  if (error instanceof FigmaConnectorError) {
    return {
      status: figmaFailureStatus(error.code),
      body: errorBody(error.code, error.message),
    };
  }
  return {
    status: 502,
    body: errorBody(
      "FIGMA_EGRESS_FAILED",
      safeError(error, [request.figmaAccessToken, request.apiKey, request.baseUrl]),
    ),
  };
}

async function verifySubmittedFigmaCredential(
  request: SetupRequest,
  deps: UiHandlerDeps,
): Promise<RouteResult | undefined> {
  if (!request.verifyFigmaCredential || request.figmaAccessToken === undefined) {
    return undefined;
  }
  const tester: FigmaCredentialTester = deps.figmaCredentialTester ?? defaultFigmaCredentialTester;
  try {
    await tester(request.figmaAccessToken, currentGatewayEgressConfig(deps));
    return undefined;
  } catch (error) {
    return figmaCredentialFailureResult(error, request);
  }
}

function deploymentNamesRequiredResult(): RouteResult {
  return {
    status: 400,
    body: errorBody(
      "GATEWAY_DEPLOYMENTS_REQUIRED",
      "Azure AI Foundry endpoints require deployment names from the Deployments tab.",
    ),
  };
}

interface ParsedSetupBody {
  readonly parsed: unknown;
}

async function readJsonSetupBody(ctx: RouteContext): Promise<ParsedSetupBody | RouteResult> {
  let bodyText: string;
  try {
    bodyText = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  try {
    return { parsed: JSON.parse(bodyText) as unknown };
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
}

function gatewayUnavailableResult(): RouteResult {
  return {
    status: 500,
    body: errorBody("GATEWAY_SETUP_UNAVAILABLE", "Gateway setup is unavailable."),
  };
}

async function trySetupCandidate(
  baseUrl: string,
  request: SetupRequest,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
  tester: GatewaySetupTester,
  discovery: GatewayModelDiscovery,
  current: GatewayConfig | undefined,
): Promise<RouteResult> {
  const verified = await verifySetupCandidate({
    baseUrl,
    apiKey: request.apiKey,
    apiKeyHeaderName: request.apiKeyHeaderName,
    deploymentNames: request.deploymentNames,
    imageInputModelIds: request.imageInputModelIds,
    tester,
    discovery,
    env: deps.env,
    egress: currentGatewayEgressConfig(deps),
    figmaAccessToken: request.figmaAccessToken,
    current,
  });
  persistGatewayConfig(verified.rawConfig, gatewayConfig.storagePath, deps);
  gatewayConfig.set(verified.config, true);
  return setupSuccessResult(verified.config, verified.testedModelIds, verified.skippedModelIds);
}

function setupCandidateError(error: unknown, request: SetupRequest, baseUrl: string): string {
  return safeError(error, [request.apiKey, request.baseUrl, baseUrl, request.figmaAccessToken]);
}

function saveExistingConfigUpdate(
  request: SetupRequest,
  current: GatewayConfig,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
): RouteResult {
  const rawConfig = rawConfigFromCurrent(current, request.figmaAccessToken);
  const config = parseGatewayConfig(
    withInheritedEgress(rawConfig, currentGatewayEgressConfig(deps)),
    deps.env,
  );
  persistGatewayConfig(rawConfig, gatewayConfig.storagePath, deps);
  gatewayConfig.set(config, true);
  return setupSuccessResult(
    config,
    config.providers.map((provider) => provider.modelId),
    [],
  );
}

async function verifyAndSaveExistingConfigUpdate(
  request: SetupRequest,
  current: GatewayConfig,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
): Promise<RouteResult> {
  const figmaFailure = await verifySubmittedFigmaCredential(request, deps);
  if (figmaFailure !== undefined) {
    return figmaFailure;
  }
  return saveExistingConfigUpdate(request, current, deps, gatewayConfig);
}

function shouldRequireDeploymentNames(
  request: SetupRequest,
  baseUrlCandidates: readonly string[],
): boolean {
  return (
    request.deploymentNames.length === 0 &&
    baseUrlCandidates.some((baseUrl) => isAzureFoundryBaseUrl(baseUrl))
  );
}

async function verifyAndSaveGatewaySetup(
  request: SetupRequest,
  current: GatewayConfig | undefined,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
): Promise<RouteResult> {
  const tester = deps.gatewaySetupTester ?? defaultGatewaySetupTester;
  const discovery = deps.gatewayModelDiscovery ?? defaultGatewayModelDiscovery;
  const figmaFailure = await verifySubmittedFigmaCredential(request, deps);
  if (figmaFailure !== undefined) {
    return figmaFailure;
  }
  const baseUrlCandidates = candidateBaseUrls(request.baseUrl);
  if (shouldRequireDeploymentNames(request, baseUrlCandidates)) {
    return deploymentNamesRequiredResult();
  }
  const errors: string[] = [];
  for (const baseUrl of baseUrlCandidates) {
    try {
      return await trySetupCandidate(
        baseUrl,
        request,
        deps,
        gatewayConfig,
        tester,
        discovery,
        current,
      );
    } catch (error) {
      errors.push(
        `candidate ${String(errors.length + 1)}: ${setupCandidateError(error, request, baseUrl)}`,
      );
    }
  }
  return setupFailureResult(errors);
}

export async function handleGatewaySetup(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.gatewayConfig === undefined) {
    return gatewayUnavailableResult();
  }
  const { gatewayConfig } = deps;
  const current = currentGatewayConfig(deps);
  const bodyResult = await readJsonSetupBody(ctx);
  if ("status" in bodyResult) {
    return bodyResult;
  }
  const request = readSetupRequest(bodyResult.parsed, deps.env, current);
  if ("status" in request) {
    return request;
  }
  if (!request.verifyGateway && current !== undefined) {
    return verifyAndSaveExistingConfigUpdate(request, current, deps, gatewayConfig);
  }
  return verifyAndSaveGatewaySetup(request, current, deps, gatewayConfig);
}
