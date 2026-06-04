// First-run gateway setup for non-technical UI users. The browser provides only a base URL and API
// token; the loopback BFF builds the local provider config, performs a real chat-completions smoke
// call, stores the resulting config on disk with private permissions, and updates the in-memory
// runtime config without exposing credentials back to the browser.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

const MAX_BODY_BYTES = 64_000;
const MAX_DISCOVERED_MODELS = 100;
const MAX_DEPLOYMENT_NAMES = 100;
const MAX_MODEL_ID_LENGTH = 160;
const DISCOVERED_MODEL_SMOKE_TIMEOUT_MS = 15_000;
const DEPLOYMENT_SMOKE_TIMEOUT_MS = 30_000;
const SETUP_SMOKE_CONCURRENCY = 4;
const CHAT_COMPATIBLE_MODES = new Set(["chat", "completion", "responses"]);

type GatewaySetupTester = NonNullable<UiHandlerDeps["gatewaySetupTester"]>;
type GatewayModelDiscovery = NonNullable<UiHandlerDeps["gatewayModelDiscovery"]>;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      if (url.pathname === "" || url.pathname === "/") {
        candidates.push(`${url.origin}/openai/v1`);
      } else if (primary.endsWith("/openai")) {
        candidates.push(`${primary}/v1`);
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
  readonly apiKeyHeaderName?: string | undefined;
}

function providerRaw(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  options: ProviderRawOptions = {},
): Record<string, unknown> {
  return {
    modelId,
    baseUrl,
    apiKey,
    apiKeyHeaderName: options.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
    capability: createDefaultChatCapability(modelId),
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 2,
    retryBaseDelayMs: 500,
  };
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

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
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

function isExplicitlyNonChatModel(item: Record<string, unknown>): boolean {
  const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
  if (capabilities?.chat_completion === false) {
    return true;
  }
  const mode = modelModeFromDiscoveryItem(item);
  return mode !== undefined && !CHAT_COMPATIBLE_MODES.has(mode);
}

function modelIdFromDiscoveryItem(item: unknown): string | undefined {
  if (!isRecord(item) || isExplicitlyNonChatModel(item)) {
    return undefined;
  }
  return modelIdFromKnownFields(item);
}

function parseModelList(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("model discovery response must contain a data array");
  }
  const ids: string[] = [];
  for (const item of payload.data) {
    const id = modelIdFromDiscoveryItem(item);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) {
    throw new Error("model discovery returned no model ids");
  }
  return unique.slice(0, MAX_DISCOVERED_MODELS);
}

async function fetchDiscoveryJson(
  url: string,
  apiKey: string,
  apiKeyHeaderName: string,
): Promise<unknown> {
  const response = await gatewayFetch(url, {
    method: "GET",
    headers: apiKeyHeaders(apiKey, apiKeyHeaderName),
    signal: AbortSignal.timeout(30_000),
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
): Promise<readonly string[] | undefined> {
  for (const endpoint of modelInfoEndpointCandidates(baseUrl)) {
    try {
      return parseModelList(await fetchDiscoveryJson(endpoint, apiKey, apiKeyHeaderName));
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
): Promise<readonly string[]> {
  const litellmModels = await discoverLiteLlmModelInfo(baseUrl, apiKey, apiKeyHeaderName);
  if (litellmModels !== undefined) {
    return litellmModels;
  }
  return parseModelList(
    await fetchDiscoveryJson(modelsEndpoint(baseUrl), apiKey, apiKeyHeaderName),
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
  return Array.from(
    new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)),
  );
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

function validateSetupConnection(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
): RouteResult | undefined {
  try {
    parseGatewayConfig(
      buildRawConfig(baseUrl, apiKey, ["setup-validation"], { apiKeyHeaderName }),
    );
    return undefined;
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    throw error;
  }
}

async function defaultGatewaySetupTester(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
): Promise<readonly string[]> {
  const gateway = new Gateway(config);
  const tested = Array<string | undefined>(candidateModelIds.length).fill(undefined);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidateModelIds.length) {
      const index = next;
      next += 1;
      const modelId = candidateModelIds[index];
      if (modelId === undefined) {
        continue;
      }
      try {
        await gateway.chat({
          modelId,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        });
        tested[index] = modelId;
      } catch {
        // Non-chat models can appear in OpenAI-compatible model discovery responses. They are
        // intentionally ignored so only chat-callable models become selectable in the UI.
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(SETUP_SMOKE_CONCURRENCY, candidateModelIds.length) },
      () => worker(),
    ),
  );
  const accepted = tested.filter((modelId): modelId is string => modelId !== undefined);
  if (accepted.length === 0) {
    throw new Error("no discovered model accepted the chat-completions smoke test");
  }
  return accepted;
}

function savePrivateJson(path: string, raw: Record<string, unknown>): void {
  const resolvedPath = resolve(path);
  const dir = dirname(resolvedPath);
  assertNoSymlinkedPathSegments(resolvedPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNoSymlinkedPathSegments(resolvedPath);
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  const tempPath = join(
    dir,
    `.keiko-config.${String(process.pid)}.${Date.now().toString(36)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      chmodSync(tempPath, 0o600);
    }
    renameSync(tempPath, resolvedPath);
  } finally {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function assertNoSymlinkedPathSegments(resolvedPath: string): void {
  let current = resolvedPath;
  while (current !== dirname(current)) {
    if (isSymlink(current)) {
      throw new Error("refusing to write gateway config through a symlinked path");
    }
    current = dirname(current);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function readSetupRequest(
  raw: unknown,
):
  | {
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly apiKeyHeaderName: string;
      readonly deploymentNames: readonly string[];
    }
  | RouteResult {
  if (!isRecord(raw)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (baseUrl.length === 0 || apiKey.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "baseUrl and apiKey are required.") };
  }
  let apiKeyHeaderName: string;
  try {
    apiKeyHeaderName = normalizeApiKeyHeaderName(
      raw.apiKeyHeaderName,
      "apiKeyHeaderName",
      DEFAULT_API_KEY_HEADER_NAME,
    );
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    throw error;
  }
  const deploymentNames = parseDeploymentNames(raw.deploymentNames);
  if ("status" in deploymentNames) {
    return deploymentNames;
  }
  const invalidConnection = validateSetupConnection(baseUrl, apiKey, apiKeyHeaderName);
  if (invalidConnection !== undefined) {
    return invalidConnection;
  }
  return { baseUrl, apiKey, apiKeyHeaderName, deploymentNames };
}

function safeError(error: unknown, secrets: readonly string[]): string {
  if (error instanceof Error) {
    return redact(error.message, secrets);
  }
  return "Gateway setup failed.";
}

interface VerifiedSetup {
  readonly rawConfig: Record<string, unknown>;
  readonly config: GatewayConfig;
  readonly testedModelIds: readonly string[];
}

async function verifySetupCandidate(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
  deploymentNames: readonly string[],
  tester: GatewaySetupTester,
  discovery: GatewayModelDiscovery,
): Promise<VerifiedSetup> {
  // Defence-in-depth: never send the credential to a candidate URL that has not passed the same
  // scheme/credential/loopback validation as the originally submitted base URL.
  validateBaseUrl(baseUrl, "candidate");
  const candidateModelIds =
    deploymentNames.length > 0 ? deploymentNames : await discovery(baseUrl, apiKey, apiKeyHeaderName);
  const smokeTimeoutMs =
    deploymentNames.length > 0 ? DEPLOYMENT_SMOKE_TIMEOUT_MS : DISCOVERED_MODEL_SMOKE_TIMEOUT_MS;
  const candidateRawConfig = buildRawConfig(baseUrl, apiKey, candidateModelIds, {
    apiKeyHeaderName,
    timeoutMs: smokeTimeoutMs,
    maxRetries: 0,
  });
  const candidateConfig = parseGatewayConfig(candidateRawConfig);
  const testedModelIds = await tester(candidateConfig, candidateModelIds);
  const rawConfig = buildRawConfig(baseUrl, apiKey, testedModelIds, { apiKeyHeaderName });
  const config = parseGatewayConfig(rawConfig);
  return { rawConfig, config, testedModelIds };
}

function setupSuccessResult(config: GatewayConfig, testedModelIds: readonly string[]): RouteResult {
  const testedModelId = testedModelIds[0] ?? "unknown";
  return {
    status: 200,
    body: {
      ok: true,
      testedModelId,
      testedModelIds,
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
      return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit.") };
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

export async function handleGatewaySetup(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  if (deps.gatewayConfig === undefined) {
    return gatewayUnavailableResult();
  }
  const bodyResult = await readJsonSetupBody(ctx);
  if ("status" in bodyResult) {
    return bodyResult;
  }
  const request = readSetupRequest(bodyResult.parsed);
  if ("status" in request) {
    return request;
  }
  const tester = deps.gatewaySetupTester ?? defaultGatewaySetupTester;
  const discovery = deps.gatewayModelDiscovery ?? defaultGatewayModelDiscovery;
  const baseUrlCandidates = candidateBaseUrls(request.baseUrl);
  if (
    request.deploymentNames.length === 0 &&
    baseUrlCandidates.some((baseUrl) => isAzureFoundryBaseUrl(baseUrl))
  ) {
    return deploymentNamesRequiredResult();
  }
  const errors: string[] = [];
  for (const baseUrl of baseUrlCandidates) {
    try {
      const verified = await verifySetupCandidate(
        baseUrl,
        request.apiKey,
        request.apiKeyHeaderName,
        request.deploymentNames,
        tester,
        discovery,
      );
      savePrivateJson(deps.gatewayConfig.storagePath, verified.rawConfig);
      deps.gatewayConfig.set(verified.config, true);
      return setupSuccessResult(verified.config, verified.testedModelIds);
    } catch (error) {
      errors.push(
        `candidate ${String(errors.length + 1)}: ${safeError(error, [request.apiKey, request.baseUrl, baseUrl])}`,
      );
    }
  }
  return setupFailureResult(errors);
}
