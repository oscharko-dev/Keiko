// First-run gateway setup for non-technical UI users. The browser provides only a base URL and API
// token; the loopback BFF builds the local provider config, performs a real chat-completions smoke
// call, stores the resulting config on disk with private permissions, and updates the in-memory
// runtime config without exposing credentials back to the browser.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Gateway, listConfiguredCapabilities, parseGatewayConfig, toSafeObject } from "../gateway/index.js";
import { redact } from "../gateway/redaction.js";
import type { GatewayConfig } from "../gateway/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

const MAX_BODY_BYTES = 64_000;

const ACTIVE_CHAT_MODEL_IDS = [
  "Qwen3-Coder-480B-A35B-Instruct-FP8",
  "Qwen/Qwen3-Coder-Next-FP8",
  "Devstral-2-123B-Instruct-2512",
  "gpt-oss-120b",
  "Mistral-Small-3.1-24B-Instruct-2503",
  "Qwen2.5-Coder-7B-Instruct",
  "gemma-4-31b-it",
] as const;

type GatewaySetupTester = NonNullable<UiHandlerDeps["gatewaySetupTester"]>;

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
  if (!primary.endsWith("/v1")) {
    candidates.push(`${primary}/v1`);
  }
  return Array.from(new Set(candidates));
}

function providerRaw(modelId: string, baseUrl: string, apiKey: string): Record<string, unknown> {
  return {
    modelId,
    baseUrl,
    apiKey,
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 500,
  };
}

function buildRawConfig(baseUrl: string, apiKey: string): Record<string, unknown> {
  return {
    providers: ACTIVE_CHAT_MODEL_IDS.map((modelId) => providerRaw(modelId, baseUrl, apiKey)),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

async function defaultGatewaySetupTester(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
): Promise<readonly string[]> {
  const gateway = new Gateway(config);
  let lastError: Error | undefined;
  const tested: string[] = [];
  const failed: string[] = [];
  for (const modelId of candidateModelIds) {
    try {
      await gateway.chat({
        modelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      });
      tested.push(modelId);
    } catch (error) {
      failed.push(modelId);
      lastError = error instanceof Error ? error : new Error("unknown gateway setup failure");
    }
  }
  if (failed.length > 0) {
    const suffix = lastError === undefined ? "" : ` Last error: ${lastError.message}`;
    throw new Error(`workflow model smoke test failed for ${failed.join(", ")}.${suffix}`);
  }
  if (tested.length === 0) {
    throw new Error("no setup smoke-test model was available");
  }
  return tested;
}

function savePrivateJson(path: string, raw: Record<string, unknown>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
}

function readSetupRequest(raw: unknown): { readonly baseUrl: string; readonly apiKey: string } | RouteResult {
  if (!isRecord(raw)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (baseUrl.length === 0 || apiKey.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "baseUrl and apiKey are required.") };
  }
  return { baseUrl, apiKey };
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
  tester: GatewaySetupTester,
): Promise<VerifiedSetup> {
  const rawConfig = buildRawConfig(baseUrl, apiKey);
  const config = parseGatewayConfig(rawConfig);
  const testedModelIds = await tester(config, ACTIVE_CHAT_MODEL_IDS);
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

export async function handleGatewaySetup(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  if (deps.gatewayConfig === undefined) {
    return { status: 500, body: errorBody("GATEWAY_SETUP_UNAVAILABLE", "Gateway setup is unavailable.") };
  }
  let bodyText: string;
  try {
    bodyText = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit.") };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  const request = readSetupRequest(parsed);
  if ("status" in request) {
    return request;
  }
  const tester = deps.gatewaySetupTester ?? defaultGatewaySetupTester;
  const errors: string[] = [];
  for (const baseUrl of candidateBaseUrls(request.baseUrl)) {
    try {
      const verified = await verifySetupCandidate(baseUrl, request.apiKey, tester);
      savePrivateJson(deps.gatewayConfig.storagePath, verified.rawConfig);
      deps.gatewayConfig.set(verified.config, true);
      return setupSuccessResult(verified.config, verified.testedModelIds);
    } catch (error) {
      errors.push(`candidate ${String(errors.length + 1)}: ${safeError(error, [request.apiKey, baseUrl])}`);
    }
  }
  return setupFailureResult(errors);
}
