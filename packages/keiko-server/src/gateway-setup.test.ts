import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { FigmaConnectorError } from "./qualityIntelligence/figma/figmaConnectorErrors.js";
import { currentGatewayConfig } from "./deps.js";
import { buildUiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  ERROR_CODES,
  parseGatewayConfig,
  resolveCodingSafeSidecarGatewayProfile,
  resolveVoiceCapability,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  GatewayConfig,
  ModelCapability,
  ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  handleApplyGatewayVerifiedCapabilities,
  handleGatewaySetup,
  MAX_DISCOVERED_MODELS,
  isExplicitlyNonChatModel,
  modelIdFromDiscoveryItem,
  normalizeDiscoveryPayload,
  normalizeDiscoveryPayloadForSetup,
  rawConfigFromCurrent,
  smokeTestCandidates,
  stripTrailingSlashes,
} from "./gateway-setup.js";
import { selectEmbeddingModelId } from "./local-knowledge-handlers.js";
import { recommendQiModelPolicy } from "./qualityIntelligence/modelSelection.js";
import type { RouteContext } from "./routes.js";

const tmpDirs: string[] = [];

// Issue #1320: pin both local vaults (provider credentials + Figma PAT) to the explicit env-key tier
// so tests never touch the real macOS keychain — deterministic, side-effect-free, and identical on
// CI (Linux keyfile tier) and developer machines. The values are throwaway 32-byte base64 keys.
const VAULT_ENV: Readonly<Record<string, string>> = {
  KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
  KEIKO_FIGMA_KEY: Buffer.alloc(32, 0x42).toString("base64"),
};
const MOCK_FETCH_EGRESS_ENV: Readonly<Record<string, string>> = {
  ...VAULT_ENV,
  KEIKO_ALLOW_PRIVATE_EGRESS: "1",
};
const VOICE_STRING_SETUP_FIELDS = [
  "voiceBaseUrl",
  "voiceApiKey",
  "voiceApiKeyHeaderName",
  "voiceModelId",
  "voiceSpeechToTextModelId",
  "voiceRealtimeModelId",
  "voiceRealtimeTranscriptionModelId",
  "voiceSpeechOutputModelId",
  "voiceOutputVoiceId",
  "voiceProviderLocality",
] as const;
const INVALID_VOICE_STRING_VALUES: readonly unknown[] = [null, 42, {}, []];
const INVALID_VOICE_STRING_CASES = VOICE_STRING_SETUP_FIELDS.flatMap((field) =>
  INVALID_VOICE_STRING_VALUES.map((value) => ({ field, value })),
);

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

function ctx(body: unknown, correlationId?: string): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/gateway/setup"),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function fetchInputUrl(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === "string") return url;
  return url instanceof URL ? url.href : url.url;
}

// Reads the first provider's resolved apiKey from the in-memory runtime config (Issue #1320 keeps the
// real credential live in memory while the persisted file holds only a reference). Extracted so the
// optional-chain access does not inflate the calling test's cyclomatic complexity.
function firstProviderApiKey(deps: Parameters<typeof currentGatewayConfig>[0]): string | undefined {
  return currentGatewayConfig(deps)?.providers[0]?.apiKey;
}

function requiredGatewayConfig(deps: Parameters<typeof currentGatewayConfig>[0]): GatewayConfig {
  const config = currentGatewayConfig(deps);
  if (config === undefined) throw new Error("expected saved gateway config");
  return config;
}

function requiredCapability(config: GatewayConfig, modelId: string): ModelCapability {
  const capability = config.capabilities?.find((candidate) => candidate.id === modelId);
  if (capability === undefined) throw new Error(`expected capability for ${modelId}`);
  return capability;
}

function requiredProvider(config: GatewayConfig, modelId: string): ModelProviderConfig {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  if (provider === undefined) throw new Error(`expected provider for ${modelId}`);
  return provider;
}

function seedSemanticRealtimeGateway(deps: Parameters<typeof currentGatewayConfig>[0]): void {
  const gatewayConfig = deps.gatewayConfig;
  if (gatewayConfig === undefined) throw new Error("expected gateway config store");
  gatewayConfig.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
        },
        {
          modelId: "realtime-model",
          baseUrl: "https://audio.example.com/v1",
          apiKey: "audio-token",
          capability: {
            kind: "voice",
            supportsRealtimeVoice: true,
            supportsSemanticTurnDetection: true,
            realtimeTranscriptionModel: "realtime-transcription",
            voiceProviderLocality: "azure-foundry",
          },
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    }),
    true,
  );
}

function seedSeparatedVoiceGateway(deps: Parameters<typeof currentGatewayConfig>[0]): void {
  const gatewayConfig = deps.gatewayConfig;
  if (gatewayConfig === undefined) throw new Error("expected gateway config store");
  gatewayConfig.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
        },
        ...voiceElectionProviders().filter((provider) =>
          ["stt-low", "tts-low", "realtime-low"].includes(String(provider.modelId)),
        ),
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    }),
    true,
  );
}

function seedSpeechInputVoiceGateway(deps: Parameters<typeof currentGatewayConfig>[0]): void {
  const gatewayConfig = deps.gatewayConfig;
  if (gatewayConfig === undefined) throw new Error("expected gateway config store");
  gatewayConfig.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
        },
        ...voiceElectionProviders().filter((provider) => provider.modelId === "stt-low"),
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    }),
    true,
  );
}

type SharedVoiceConnectionMode = "shared" | "different-credentials" | "different-headers";

function sharedVoiceConnection(
  provider: Readonly<Record<string, unknown>>,
  mode: SharedVoiceConnectionMode,
): Readonly<Record<string, unknown>> {
  const modelId = String(provider.modelId);
  return {
    ...provider,
    baseUrl: "https://shared-audio.example.com/v1",
    apiKey: mode === "different-credentials" ? `${modelId}-token` : "shared-audio-token",
    apiKeyHeaderName:
      mode === "different-headers" && modelId === "tts-low" ? "api-key" : "authorization",
  };
}

function seedSharedEndpointVoiceGateway(
  deps: Parameters<typeof currentGatewayConfig>[0],
  mode: SharedVoiceConnectionMode = "shared",
): void {
  const gatewayConfig = deps.gatewayConfig;
  if (gatewayConfig === undefined) throw new Error("expected gateway config store");
  const voiceProviders = voiceElectionProviders()
    .filter((provider) => ["stt-low", "tts-low", "realtime-low"].includes(String(provider.modelId)))
    .map((provider) => sharedVoiceConnection(provider, mode));
  gatewayConfig.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
        },
        ...voiceProviders,
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    }),
    true,
  );
}

function seedMultiRoleVoiceGateway(deps: Parameters<typeof currentGatewayConfig>[0]): void {
  const gatewayConfig = deps.gatewayConfig;
  if (gatewayConfig === undefined) throw new Error("expected gateway config store");
  gatewayConfig.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
        },
        {
          modelId: "multi-role",
          baseUrl: "https://multi-role.example.com/v1",
          apiKey: "multi-role-token",
          capability: {
            kind: "voice",
            supportsSpeechInput: true,
            supportsSpeechOutput: true,
            supportsRealtimeVoice: true,
            supportsSemanticTurnDetection: true,
            realtimeTranscriptionModel: "multi-role-transcription",
            voiceProviderLocality: "customer-hosted",
          },
          voiceProfiles: [{ persona: "neutral", voiceId: "multi-role-voice" }],
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    }),
    true,
  );
}

function voiceElectionProviders(): readonly Record<string, unknown>[] {
  const provider = (
    modelId: string,
    costClass: "low" | "high",
    capability: Record<string, unknown>,
  ): Record<string, unknown> => ({
    modelId,
    baseUrl: `https://${modelId}.example.com/v1`,
    apiKey: `${modelId}-token`,
    timeoutMs: 10_000,
    capability: {
      kind: "voice",
      costClass,
      voiceProviderLocality: "customer-hosted",
      ...capability,
    },
    ...(capability.supportsSpeechOutput === true
      ? { voiceProfiles: [{ persona: "neutral", voiceId: `${modelId}-voice` }] }
      : {}),
  });
  return [
    provider("stt-high", "high", { supportsSpeechInput: true }),
    provider("stt-low", "low", { supportsSpeechInput: true }),
    provider("tts-high", "high", { supportsSpeechOutput: true }),
    provider("tts-low", "low", { supportsSpeechOutput: true }),
    provider("realtime-high", "high", {
      supportsRealtimeVoice: true,
      realtimeTranscriptionModel: "realtime-high-transcription",
    }),
    provider("realtime-low", "low", {
      supportsRealtimeVoice: true,
      supportsSemanticTurnDetection: true,
      realtimeTranscriptionModel: "realtime-low-transcription",
    }),
  ];
}

describe("handleGatewaySetup", () => {
  it("applies only a generation-current live capability observation after an explicit request", async () => {
    const uiDir = await tempDir("keiko-gw-capability-apply-ui-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-capability-apply-ev-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    const rawConfig = {
      providers: [
        {
          modelId: "model/one",
          baseUrl: "https://llm-gateway.example.com/v1",
          apiKey: "example-secret-token",
          timeoutMs: 45_678,
          capability: {
            kind: "chat",
            toolCalling: true,
            structuredOutput: true,
            supportsResponseFormat: true,
          },
        },
      ],
      egress: {
        httpsProxy: "http://proxy.internal.example:8443",
        noProxy: "localhost,.corp.example",
        allowPrivateNetwork: false,
      },
    };
    gatewayConfig.set(parseGatewayConfig(rawConfig), true);
    writeFileSync(gatewayConfig.storagePath, JSON.stringify(rawConfig), "utf8");
    gatewayConfig.recordVerifiedCapability(
      "model/one",
      { streaming: true, toolCalling: false, structuredOutput: false },
      "2026-08-02T08:00:00.000Z",
      gatewayConfig.generation(),
    );

    const rejected = await handleApplyGatewayVerifiedCapabilities(
      { ...ctx({ fields: { toolCalling: true } }), params: { modelId: "model%2Fone" } },
      deps,
    );
    expect(rejected.status).toBe(409);
    expect(requiredCapability(requiredGatewayConfig(deps), "model/one").toolCalling).toBe(true);

    const result = await handleApplyGatewayVerifiedCapabilities(
      {
        ...ctx({ fields: { streaming: true, toolCalling: false, structuredOutput: false } }),
        params: { modelId: "model%2Fone" },
      },
      deps,
    );

    expect(result.status).toBe(200);
    expect(requiredCapability(requiredGatewayConfig(deps), "model/one").toolCalling).toBe(false);
    expect(requiredCapability(requiredGatewayConfig(deps), "model/one")).toMatchObject({
      structuredOutput: false,
      supportsResponseFormat: false,
    });
    expect(gatewayConfig.verifiedCapability("model/one")).toBeUndefined();
    const persisted = readFileSync(gatewayConfig.storagePath, "utf8");
    expect(persisted).toContain('"toolCalling": false');
    expect(persisted).toContain('"supportsResponseFormat": false');
    expect(JSON.parse(persisted)).toMatchObject({
      providers: [expect.objectContaining({ timeoutMs: 45_678 })],
      egress: rawConfig.egress,
    });
    expect(persisted).not.toContain("example-secret-token");
    const replay = await handleApplyGatewayVerifiedCapabilities(
      { ...ctx({ fields: { toolCalling: false } }), params: { modelId: "model%2Fone" } },
      deps,
    );
    expect(replay.status).toBe(409);
    deps.store.close();
  });

  it("replaces an older partial capability observation instead of refreshing its fields", async () => {
    const uiDir = await tempDir("keiko-gw-capability-replace-observation-ui-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-capability-replace-observation-ev-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    gatewayConfig.recordVerifiedCapability(
      "model-one",
      { toolCalling: true },
      "2026-08-02T08:00:00.000Z",
    );
    gatewayConfig.recordVerifiedCapability(
      "model-one",
      { streaming: true },
      "2026-08-02T08:01:00.000Z",
    );

    expect(gatewayConfig.verifiedCapability("model-one")).toEqual({
      modelId: "model-one",
      generation: 0,
      checkedAt: "2026-08-02T08:01:00.000Z",
      fields: { streaming: true },
    });
    deps.store.close();
  });

  it("materializes only the selected registry-default capability as an explicit override", async () => {
    const uiDir = await tempDir("keiko-gw-capability-single-override-ui-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-capability-single-override-ev-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          { modelId: "model-one", baseUrl: "https://gateway.example.com/v1", apiKey: "token" },
          { modelId: "model-two", baseUrl: "https://gateway.example.com/v1", apiKey: "token" },
        ],
      }),
      true,
    );
    gatewayConfig.recordVerifiedCapability(
      "model-one",
      { toolCalling: false },
      "2026-08-02T08:00:00.000Z",
      gatewayConfig.generation(),
    );

    const result = await handleApplyGatewayVerifiedCapabilities(
      { ...ctx({ fields: { toolCalling: false } }), params: { modelId: "model-one" } },
      deps,
    );

    expect(result.status).toBe(200);
    expect(requiredGatewayConfig(deps).capabilities?.map((capability) => capability.id)).toEqual([
      "model-one",
    ]);
    deps.store.close();
  });

  it("rejects malformed capability patches before mutating configuration", async () => {
    const uiDir = await tempDir("keiko-gw-capability-invalid-patch-ui-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-capability-invalid-patch-ev-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          { modelId: "model-one", baseUrl: "https://gateway.example.com/v1", apiKey: "token" },
        ],
      }),
      true,
    );
    const before = gatewayConfig.current();

    for (const body of [
      {},
      { fields: {} },
      { fields: { unknown: true } },
      { fields: { toolCalling: "true" } },
      { fields: { contextWindow: 0 } },
    ]) {
      const result = await handleApplyGatewayVerifiedCapabilities(
        { ...ctx(body), params: { modelId: "model-one" } },
        deps,
      );
      expect(result.status).toBe(400);
      expect(gatewayConfig.current()).toBe(before);
    }
    const unknown = await handleApplyGatewayVerifiedCapabilities(
      { ...ctx({ fields: { toolCalling: true } }), params: { modelId: "missing-model" } },
      deps,
    );
    expect(unknown.status).toBe(404);
    deps.store.close();
  });

  it("rejects a capability patch when configuration changes while its body is being read", async () => {
    const uiDir = await tempDir("keiko-gw-capability-generation-race-ui-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-capability-generation-race-ev-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    const initial = parseGatewayConfig({
      providers: [
        { modelId: "model-one", baseUrl: "https://gateway.example.com/v1", apiKey: "token" },
      ],
    });
    gatewayConfig.set(initial, true);
    gatewayConfig.recordVerifiedCapability(
      "model-one",
      { toolCalling: false },
      "2026-08-02T08:00:00.000Z",
      gatewayConfig.generation(),
    );
    const body = new PassThrough();
    const pending = handleApplyGatewayVerifiedCapabilities(
      {
        ...ctx({}),
        req: body as unknown as IncomingMessage,
        params: { modelId: "model-one" },
      },
      deps,
    );
    const replacement = parseGatewayConfig({
      providers: [
        { modelId: "model-one", baseUrl: "https://replacement.example.com/v1", apiKey: "token" },
      ],
    });
    gatewayConfig.set(replacement, true);
    body.end(JSON.stringify({ fields: { toolCalling: false } }));

    await expect(pending).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "GATEWAY_CAPABILITY_OBSERVATION_STALE" } },
    });
    expect(gatewayConfig.current()).toBe(replacement);
    deps.store.close();
  });

  it("retains the live observation when capability persistence fails", async () => {
    const uiDir = await tempDir("keiko-gw-capability-persist-failure-ui-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-capability-persist-failure-ev-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          { modelId: "model-one", baseUrl: "https://gateway.example.com/v1", apiKey: "token" },
        ],
      }),
      true,
    );
    gatewayConfig.recordVerifiedCapability(
      "model-one",
      { toolCalling: false },
      "2026-08-02T08:00:00.000Z",
      gatewayConfig.generation(),
    );
    const failingGatewayConfig = { ...gatewayConfig, storagePath: uiDir };

    await expect(
      handleApplyGatewayVerifiedCapabilities(
        { ...ctx({ fields: { toolCalling: false } }), params: { modelId: "model-one" } },
        { ...deps, gatewayConfig: failingGatewayConfig },
      ),
    ).rejects.toThrow();
    expect(gatewayConfig.verifiedCapability("model-one")).toMatchObject({
      fields: { toolCalling: false },
    });
    expect(gatewayConfig.current()?.providers[0]?.baseUrl).toBe("https://gateway.example.com/v1");
    deps.store.close();
  });

  it("persists verified response-format support and makes it available to QI immediately", async () => {
    const uiDir = await tempDir("keiko-gw-response-format-ui-");
    const evidenceDir = await tempDir("keiko-gw-response-format-ev-");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, init): Promise<Response> => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        readonly model?: string;
        readonly response_format?: unknown;
      };
      if (body.response_format !== undefined && body.model === "plain-chat") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "unsupported" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const content =
        body.response_format === undefined
          ? "OK"
          : JSON.stringify({
              dimensions: [
                { name: "verifiability", score: 90, rationale: "ok" },
                { name: "atomicity", score: 90, rationale: "ok" },
                { name: "determinism", score: 90, rationale: "ok" },
                { name: "ac-fidelity", score: 90, rationale: "ok" },
              ],
              overallRationale: "ok",
            });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });

    try {
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://llm-gateway.example.com/v1",
          apiKey: "example-secret-token",
          deploymentNames: ["schema-capable", "plain-chat"],
        }),
        deps,
      );

      expect(result.status).toBe(200);
      expect(requiredCapability(requiredGatewayConfig(deps), "schema-capable")).toMatchObject({
        structuredOutput: true,
        supportsResponseFormat: true,
      });
      expect(requiredCapability(requiredGatewayConfig(deps), "plain-chat")).toMatchObject({
        structuredOutput: false,
        supportsResponseFormat: false,
      });
      expect(recommendQiModelPolicy(deps).judgeModelId).toBe("schema-capable");
      const persisted = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
      expect(persisted).toContain('"supportsResponseFormat": true');
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("includes the request correlation id when the setup body is not an object", async () => {
    const uiDir = await tempDir("keiko-gw-invalid-ui-");
    const evidenceDir = await tempDir("keiko-gw-invalid-ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });

    const result = await handleGatewaySetup(ctx(null, "corr-invalid-setup-body"), deps);

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body must be a JSON object.",
          correlationId: "corr-invalid-setup-body",
        },
      },
    });
  });

  it("tests, stores, and activates a local gateway config without returning secrets", async () => {
    const uiDir = await tempDir("keiko-gw-ui-");
    const evidenceDir = await tempDir("keiko-gw-ev-");
    const storagePath = join(uiDir, "keiko.config.json");
    writeFileSync(storagePath, "stale-config\n", "utf8");
    const initialStat = statSync(storagePath);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () =>
        Promise.resolve([
          "example-chat-model-large",
          "example-chat-model-fast",
          "example-vision-model",
        ]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
      "example-chat-model-large",
    ]);
    expect(currentGatewayConfig(deps)?.providers).toHaveLength(1);
    expect(deps.gatewayConfig?.present()).toBe(true);
    const savedPath = deps.gatewayConfig?.storagePath;
    expect(savedPath).toBeDefined();
    expect(existsSync(savedPath ?? "")).toBe(true);
    const saved = readFileSync(savedPath ?? "", "utf8");
    // Issue #1320: the persisted config holds only non-secret metadata + a stable secret reference.
    expect(saved).not.toContain("example-secret-token");
    expect(saved).toContain("apiKeySecretRef");
    expect(saved).toContain("cred:example-chat-model-large");
    expect(saved).toContain("example-chat-model-large");
    expect(saved).not.toContain("example-chat-model-fast");
    expect(saved).not.toContain("example-vision-model");
    // The credential lives in the encrypted vault next to the config — sealed, never plaintext.
    const vaultStore = readFileSync(
      join(uiDir, "credentials", "provider-credentials.vault"),
      "utf8",
    );
    expect(vaultStore).not.toContain("example-secret-token");
    expect(vaultStore).toContain("cred:example-chat-model-large");
    // The in-memory runtime config still carries the real, resolved credential for live calls.
    expect(firstProviderApiKey(deps)).toBe("example-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("https://llm-gateway.example.com");
    if (process.platform !== "win32") {
      expect(statSync(savedPath ?? "").mode & 0o777).toBe(0o600);
      expect(statSync(savedPath ?? "").ino).not.toBe(initialStat.ino);
    }
    deps.store.close();
  });

  it("persists an optional gateway request timeout for slow OpenAI-compatible deployments", async () => {
    const uiDir = await tempDir("keiko-gw-ui-timeout-");
    const evidenceDir = await tempDir("keiko-gw-ev-timeout-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1",
        apiKey: "example-secret-token",
        timeoutMs: 120_000,
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(currentGatewayConfig(deps)?.providers[0]?.timeoutMs).toBe(120_000);
    const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
    expect(saved).toContain('"timeoutMs": 120000');
    deps.store.close();
  });

  it("updates only the gateway request timeout without re-running setup smoke tests", async () => {
    const uiDir = await tempDir("keiko-gw-ui-timeout-update-");
    const evidenceDir = await tempDir("keiko-gw-ev-timeout-update-");
    let smokeCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => {
        smokeCalls += 1;
        return Promise.resolve([modelIds[0] ?? "example-chat-model"]);
      },
    });

    const first = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(first.status).toBe(200);
    expect(smokeCalls).toBe(1);

    const updated = await handleGatewaySetup(
      ctx({ preserveExisting: true, timeoutMs: 120_000 }),
      deps,
    );

    expect(updated.status).toBe(200);
    expect(smokeCalls).toBe(1);
    expect(currentGatewayConfig(deps)?.providers[0]?.timeoutMs).toBe(120_000);
    deps.store.close();
  });

  it("refuses a changed gateway URL that would inherit the stored token (exfiltration guard)", async () => {
    // Review finding on #3031: in update mode a submitted base URL that differs from the stored
    // one, with no fresh token beside it, would send the STORED token to the NEW endpoint during
    // verification — a supplied keiko.config.json (or a typo'd URL) could exfiltrate it. The
    // refusal is server-side so no client path can bypass it.
    const uiDir = await tempDir("keiko-gw-ui-fresh-token-");
    const evidenceDir = await tempDir("keiko-gw-ev-fresh-token-");
    let smokeCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => {
        smokeCalls += 1;
        return Promise.resolve([modelIds[0] ?? "example-chat-model"]);
      },
    });

    const first = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(first.status).toBe(200);
    expect(smokeCalls).toBe(1);

    const hijacked = await handleGatewaySetup(
      ctx({ preserveExisting: true, baseUrl: "https://attacker.example.com/v1" }),
      deps,
    );
    expect(hijacked.status).toBe(400);
    expect(JSON.stringify(hijacked.body)).toContain("GATEWAY_URL_CHANGE_REQUIRES_TOKEN");
    // The stored token never reached any verification against the new endpoint.
    expect(smokeCalls).toBe(1);
    expect(currentGatewayConfig(deps)?.providers[0]?.baseUrl).toBe(
      "https://llm-gateway.example.com/v1",
    );

    // A fresh token beside the new URL is the legitimate path and still works.
    const legitimate = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        baseUrl: "https://new-gateway.example.com/v1",
        apiKey: "fresh-secret-token",
      }),
      deps,
    );
    expect(legitimate.status).toBe(200);
    expect(currentGatewayConfig(deps)?.providers[0]?.baseUrl).toBe(
      "https://new-gateway.example.com/v1",
    );
    deps.store.close();
  });

  it("refuses a changed voice endpoint that would inherit the stored credential", async () => {
    // Same exfiltration class as the main gateway; the voice path's EXISTING replace guard owns
    // this refusal — pinned here so the class stays closed on both connections.
    const uiDir = await tempDir("keiko-gw-ui-voice-fresh-");
    const evidenceDir = await tempDir("keiko-gw-ev-voice-fresh-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });

    const initial = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(initial.status).toBe(200);
    const voiceStored = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://voice-gateway.example.com/openai/v1",
        voiceApiKey: "voice-secret-token",
        voiceApiKeyHeaderName: "api-key",
        voiceModelId: "keiko-stt",
        voiceProviderLocality: "azure-foundry",
      }),
      deps,
    );
    expect(voiceStored.status).toBe(200);

    const hijacked = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://attacker-voice.example.com/openai/v1",
        voiceModelId: "keiko-stt",
      }),
      deps,
    );
    expect(hijacked.status).toBe(400);
    expect(JSON.stringify(hijacked.body)).toContain(
      "Replacing an audio endpoint requires a fresh audio credential.",
    );
    deps.store.close();
  });

  it("stores optional voice dictation credentials as an STT-only provider in update mode", async () => {
    const uiDir = await tempDir("keiko-gw-ui-voice-");
    const evidenceDir = await tempDir("keiko-gw-ev-voice-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });

    const initial = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(initial.status).toBe(200);

    const updated = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://voice-gateway.example.com/openai/v1",
        voiceApiKey: "voice-secret-token",
        voiceApiKeyHeaderName: "api-key",
        voiceModelId: "keiko-stt",
        voiceProviderLocality: "azure-foundry",
      }),
      deps,
    );

    expect(updated.status).toBe(200);
    const config = currentGatewayConfig(deps);
    if (config === undefined) throw new Error("expected saved gateway config");
    expect(config.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
      "keiko-stt",
    ]);
    const voiceProvider = config.providers.find((provider) => provider.modelId === "keiko-stt");
    expect(voiceProvider?.apiKey).toBe("voice-secret-token");
    expect(voiceProvider?.apiKeyHeaderName).toBe("api-key");
    const voiceCapability = config.capabilities?.find(
      (capability) => capability.id === "keiko-stt",
    );
    expect(voiceCapability).toMatchObject({
      kind: "voice",
      supportsSpeechInput: true,
      voiceProviderLocality: "azure-foundry",
      workflowEligible: false,
    });
    const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
    expect(saved).not.toContain("voice-secret-token");
    expect(saved).toContain("cred:keiko-stt");
    expect(saved).toContain('"kind": "voice"');
    deps.store.close();
  });

  it("rejects new voice credentials without an explicit deployment role", async () => {
    const uiDir = await tempDir("keiko-gw-ui-voice-no-role-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-voice-no-role-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);

    const result = await handleGatewaySetup(
      ctx(
        {
          preserveExisting: true,
          voiceBaseUrl: "https://audio.example.com/v1",
          voiceApiKey: "audio-token",
        },
        "corr-explicit-voice-role",
      ),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "At least one explicit voice deployment is required.",
          correlationId: "corr-explicit-voice-role",
        },
      },
    });
    expect(requiredGatewayConfig(deps).providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
    ]);
    deps.store.close();
  });

  it("rejects Semantic VAD when no Realtime deployment is configured", async () => {
    const uiDir = await tempDir("keiko-gw-ui-semantic-no-realtime-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-semantic-no-realtime-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceSpeechToTextModelId: "transcribe-model",
        voiceSupportsSemanticTurnDetection: true,
      }),
      deps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Semantic turn detection requires a Realtime voice deployment.",
      },
    });
    deps.store.close();
  });

  it.each([
    ["speech input", { voiceSpeechToTextModelId: "example-chat-model" }],
    [
      "speech output",
      {
        voiceSpeechOutputModelId: "example-chat-model",
        voiceOutputVoiceId: "configured-neutral",
      },
    ],
    [
      "Realtime",
      {
        voiceRealtimeModelId: "example-chat-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcription",
      },
    ],
  ])("rejects a %s deployment ID that collides with chat", async (_role, voiceRole) => {
    const uiDir = await tempDir("keiko-gw-ui-voice-id-collision-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-voice-id-collision-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        ...voiceRole,
      }),
      deps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(result.body)).toContain("distinct");
    expect(requiredGatewayConfig(deps).providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
    ]);
    deps.store.close();
  });

  it("rejects an explicitly submitted chat/audio deployment ID collision before discovery", async () => {
    const uiDir = await tempDir("keiko-gw-ui-new-voice-id-collision-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-new-voice-id-collision-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm.example.com/v1",
        apiKey: "chat-token",
        deploymentNames: ["shared-deployment"],
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceSpeechToTextModelId: "shared-deployment",
      }),
      deps,
    );

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("distinct");
    expect(currentGatewayConfig(deps)).toBeUndefined();
    deps.store.close();
  });

  it("rejects explicit chat deployments that collide with every preserved audio role", async () => {
    const uiDir = await tempDir("keiko-gw-ui-inverse-voice-id-collision-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-inverse-voice-id-collision-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    await handleGatewaySetup(
      ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
      deps,
    );
    const configured = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceSpeechToTextModelId: "dedicated-stt",
        voiceSpeechOutputModelId: "dedicated-tts",
        voiceOutputVoiceId: "configured-neutral",
        voiceRealtimeModelId: "dedicated-realtime",
        voiceRealtimeTranscriptionModelId: "dedicated-transcription",
      }),
      deps,
    );
    expect(configured.status).toBe(200);
    const before = requiredGatewayConfig(deps).providers.map((provider) => provider.modelId);

    for (const modelId of ["dedicated-stt", "dedicated-tts", "dedicated-realtime"]) {
      const result = await handleGatewaySetup(
        ctx({ preserveExisting: true, deploymentNames: [modelId] }),
        deps,
      );
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).toContain("distinct");
      expect(requiredGatewayConfig(deps).providers.map((provider) => provider.modelId)).toEqual(
        before,
      );
    }
    deps.store.close();
  });

  it("configures distinct Dictate, Digital Voice, and read-aloud models from one audio connection", async () => {
    const uiDir = await tempDir("keiko-gw-ui-full-voice-");
    const evidenceDir = await tempDir("keiko-gw-ev-full-voice-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);

    const updated = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceSpeechToTextModelId: "transcribe-model",
        voiceRealtimeModelId: "realtime-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcribe-model",
        voiceSupportsSemanticTurnDetection: true,
        voiceSpeechOutputModelId: "speech-model",
        voiceOutputVoiceId: "alloy",
        voiceProviderLocality: "customer-hosted",
      }),
      deps,
    );

    expect(updated.status).toBe(200);
    const config = currentGatewayConfig(deps);
    if (config === undefined) throw new Error("expected saved full-voice gateway config");
    expect(config.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
      "transcribe-model",
      "speech-model",
      "realtime-model",
    ]);
    expect(resolveVoiceCapability(config)).toMatchObject({
      available: true,
      profile: "full-realtime",
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
      availableVoicePersonas: ["neutral"],
      providerLocality: "customer-hosted",
    });
    expect(
      config.capabilities?.find((capability) => capability.id === "realtime-model"),
    ).toMatchObject({
      realtimeTranscriptionModel: "realtime-transcribe-model",
      supportsSemanticTurnDetection: true,
    });
    const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
    expect(saved).not.toContain("audio-token");
    expect(saved).toContain('"voiceId": "alloy"');
    expect(JSON.stringify(updated.body)).not.toContain("alloy");
    deps.store.close();
  });

  it("replaces only the Realtime role while preserving the other audio deployments", async () => {
    const uiDir = await tempDir("keiko-gw-ui-replace-realtime-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-replace-realtime-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleGatewaySetup(
          ctx({
            preserveExisting: true,
            voiceBaseUrl: "https://audio.example.com/v1",
            voiceApiKey: "audio-token",
            voiceSpeechToTextModelId: "transcribe-model",
            voiceRealtimeModelId: "old-realtime-model",
            voiceRealtimeTranscriptionModelId: "old-realtime-transcription",
            voiceSupportsSemanticTurnDetection: true,
            voiceSpeechOutputModelId: "speech-model",
            voiceOutputVoiceId: "configured-neutral",
          }),
          deps,
        )
      ).status,
    ).toBe(200);

    const unrelated = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceTimeoutMs: 45_000 }),
      deps,
    );
    expect(unrelated.status).toBe(200);
    const preserved = requiredGatewayConfig(deps);
    expect(preserved.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
      "transcribe-model",
      "speech-model",
      "old-realtime-model",
    ]);
    expect(requiredCapability(preserved, "old-realtime-model")).toMatchObject({
      realtimeTranscriptionModel: "old-realtime-transcription",
      supportsSemanticTurnDetection: true,
    });

    const missingReplacementTranscription = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceRealtimeModelId: "replacement-realtime-model",
      }),
      deps,
    );
    expect(missingReplacementTranscription).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST" } },
    });
    expect(JSON.stringify(missingReplacementTranscription.body)).toContain(
      "voiceRealtimeTranscriptionModelId is required",
    );
    expect(requiredCapability(requiredGatewayConfig(deps), "old-realtime-model")).toMatchObject({
      realtimeTranscriptionModel: "old-realtime-transcription",
      supportsSemanticTurnDetection: true,
    });

    const replaced = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceRealtimeModelId: "replacement-realtime-model",
        voiceRealtimeTranscriptionModelId: "replacement-realtime-transcription",
      }),
      deps,
    );

    expect(replaced.status).toBe(200);
    const config = requiredGatewayConfig(deps);
    expect(config.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
      "transcribe-model",
      "speech-model",
      "replacement-realtime-model",
    ]);
    const replacement = requiredCapability(config, "replacement-realtime-model");
    expect(replacement).toMatchObject({
      supportsRealtimeVoice: true,
      realtimeTranscriptionModel: "replacement-realtime-transcription",
    });
    expect(replacement.supportsSemanticTurnDetection).toBeUndefined();
    deps.store.close();
  });

  it("rejects an ambiguous endpoint-only replacement without mutating the stored provider", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-endpoint-only-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-endpoint-only-"), "keiko-ui.db"),
    });
    seedSemanticRealtimeGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx(
        {
          preserveExisting: true,
          voiceBaseUrl: "https://unrelated-audio.example.com/v1",
        },
        "corr-endpoint-only",
      ),
      deps,
    );

    expect(result).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST", correlationId: "corr-endpoint-only" } },
    });
    expect(requiredGatewayConfig(deps)).toEqual(before);
    expect(JSON.stringify(result.body)).not.toContain("unrelated-audio.example.com");
    expect(JSON.stringify(result.body)).not.toContain("audio-token");
    deps.store.close();
  });

  it.each(INVALID_VOICE_STRING_CASES)(
    "rejects malformed $field input without mutating the stored provider",
    async ({ field, value }) => {
      const deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: await tempDir("keiko-gw-ev-malformed-voice-"),
        env: { ...VAULT_ENV },
        uiDbPath: join(await tempDir("keiko-gw-ui-malformed-voice-"), "keiko-ui.db"),
      });
      seedSemanticRealtimeGateway(deps);
      const before = requiredGatewayConfig(deps);

      const result = await handleGatewaySetup(
        ctx({ preserveExisting: true, [field]: value }, "corr-malformed-voice"),
        deps,
      );

      expect(result).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            correlationId: "corr-malformed-voice",
            message: `${field} must be a string.`,
          },
        },
      });
      expect(requiredGatewayConfig(deps)).toEqual(before);
      deps.store.close();
    },
  );

  it("rejects conflicting speech-input deployment aliases atomically", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-conflicting-stt-alias-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-conflicting-stt-alias-"), "keiko-ui.db"),
    });
    seedSpeechInputVoiceGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceModelId: "stt-low",
        voiceSpeechToTextModelId: "different-stt",
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(result.body)).toContain("must identify the same deployment");
    expect(requiredGatewayConfig(deps)).toEqual(before);
    deps.store.close();
  });

  it("accepts matching legacy and explicit speech-input deployment aliases", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-matching-stt-alias-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-matching-stt-alias-"), "keiko-ui.db"),
    });
    seedSpeechInputVoiceGateway(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceModelId: "stt-low",
        voiceSpeechToTextModelId: "stt-low",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(requiredCapability(requiredGatewayConfig(deps), "stt-low")).toMatchObject({
      supportsSpeechInput: true,
    });
    deps.store.close();
  });

  it("rejects an output voice ID when no speech-output role is configured", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-orphan-output-voice-new-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-orphan-output-voice-new-"), "keiko-ui.db"),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm.example.com/v1",
        apiKey: "chat-token",
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceSpeechToTextModelId: "stt-model",
        voiceOutputVoiceId: "orphan-voice",
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(result.body)).toContain("requires a speech-output deployment");
    expect(currentGatewayConfig(deps)).toBeUndefined();
    deps.store.close();
  });

  it("rejects an output voice ID against a preserved STT-only configuration", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-orphan-output-voice-existing-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-orphan-output-voice-existing-"), "keiko-ui.db"),
    });
    seedSpeechInputVoiceGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceOutputVoiceId: "orphan-voice" }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(requiredGatewayConfig(deps)).toEqual(before);
    deps.store.close();
  });

  it("updates the voice profile when a speech-output role already exists", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-output-voice-update-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-output-voice-update-"), "keiko-ui.db"),
    });
    seedMultiRoleVoiceGateway(deps);

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceOutputVoiceId: "replacement-voice" }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = requiredGatewayConfig(deps);
    expect(requiredProvider(config, "multi-role").voiceProfiles).toEqual([
      { persona: "neutral", voiceId: "replacement-voice" },
    ]);
    expect(requiredCapability(config, "multi-role")).toMatchObject({
      supportsSpeechInput: true,
      supportsSpeechOutput: true,
      supportsRealtimeVoice: true,
      realtimeTranscriptionModel: "multi-role-transcription",
    });
    deps.store.close();
  });

  it("requires a fresh credential for an explicit endpoint migration", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-endpoint-credential-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-endpoint-credential-"), "keiko-ui.db"),
    });
    seedSemanticRealtimeGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceRealtimeModelId: "replacement-realtime",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(requiredGatewayConfig(deps)).toEqual(before);
    deps.store.close();
  });

  it("preserves Realtime capability metadata for a canonically equivalent endpoint", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-canonical-endpoint-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-canonical-endpoint-"), "keiko-ui.db"),
    });
    seedSemanticRealtimeGateway(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://AUDIO.example.com:443/audio/../v1/",
        voiceRealtimeModelId: "realtime-model",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(requiredCapability(requiredGatewayConfig(deps), "realtime-model")).toMatchObject({
      realtimeTranscriptionModel: "realtime-transcription",
      supportsSemanticTurnDetection: true,
    });
    deps.store.close();
  });

  it.each(["https://audio.example.com:444/v1", "https://audio.example.com/v2"])(
    "treats a distinct audio endpoint as a migration: %s",
    async (voiceBaseUrl) => {
      const deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: await tempDir("keiko-gw-ev-distinct-endpoint-"),
        env: { ...VAULT_ENV },
        uiDbPath: join(await tempDir("keiko-gw-ui-distinct-endpoint-"), "keiko-ui.db"),
      });
      seedSemanticRealtimeGateway(deps);
      const before = requiredGatewayConfig(deps);

      const result = await handleGatewaySetup(ctx({ preserveExisting: true, voiceBaseUrl }), deps);

      expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
      expect(requiredGatewayConfig(deps)).toEqual(before);
      expect(JSON.stringify(result.body)).not.toContain(voiceBaseUrl);
      deps.store.close();
    },
  );

  it("requires a fresh transcription alias when the same Realtime model moves endpoints", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-realtime-alias-migration-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-realtime-alias-migration-"), "keiko-ui.db"),
    });
    seedSemanticRealtimeGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceApiKey: "replacement-audio-token",
        voiceProviderLocality: "customer-hosted",
        voiceRealtimeModelId: "realtime-model",
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(result.body)).toContain("voiceRealtimeTranscriptionModelId is required");
    expect(requiredGatewayConfig(deps)).toEqual(before);
    deps.store.close();
  });

  it("moves only explicitly resubmitted roles to a replacement audio endpoint", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-scoped-endpoint-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-scoped-endpoint-"), "keiko-ui.db"),
    });
    seedSeparatedVoiceGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceApiKey: "replacement-audio-token",
        voiceProviderLocality: "customer-hosted",
        voiceRealtimeModelId: "realtime-replacement",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    const after = requiredGatewayConfig(deps);
    expect(requiredProvider(after, "stt-low")).toEqual(requiredProvider(before, "stt-low"));
    expect(requiredProvider(after, "tts-low")).toEqual(requiredProvider(before, "tts-low"));
    expect(requiredProvider(after, "realtime-replacement")).toMatchObject({
      baseUrl: "https://replacement-audio.example.com/v1",
      apiKey: "replacement-audio-token",
    });
    expect(requiredCapability(after, "realtime-replacement")).toMatchObject({
      supportsRealtimeVoice: true,
      realtimeTranscriptionModel: "replacement-transcription",
    });
    expect(
      requiredCapability(after, "realtime-replacement").supportsSemanticTurnDetection,
    ).toBeUndefined();
    expect(after.providers.some((provider) => provider.modelId === "realtime-low")).toBe(false);
    deps.store.close();
  });

  it("rejects an unscoped credential rotation across heterogeneous audio endpoints", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-credential-scope-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-credential-scope-"), "keiko-ui.db"),
    });
    seedSeparatedVoiceGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceApiKey: "rotated-audio-token" }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(requiredGatewayConfig(deps)).toEqual(before);
    expect(JSON.stringify(result.body)).not.toContain("rotated-audio-token");
    deps.store.close();
  });

  it.each(["different-credentials", "different-headers"] as const)(
    "rejects an unscoped credential rotation across same-endpoint %s",
    async (mode) => {
      const deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: await tempDir("keiko-gw-ev-connection-identity-"),
        env: { ...VAULT_ENV },
        uiDbPath: join(await tempDir("keiko-gw-ui-connection-identity-"), "keiko-ui.db"),
      });
      seedSharedEndpointVoiceGateway(deps, mode);
      const before = requiredGatewayConfig(deps);

      const result = await handleGatewaySetup(
        ctx({ preserveExisting: true, voiceApiKey: "rotated-audio-token" }),
        deps,
      );

      expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
      expect(requiredGatewayConfig(deps)).toEqual(before);
      deps.store.close();
    },
  );

  it("scopes an explicit credential rotation to the selected audio role", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-explicit-credential-scope-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-explicit-credential-scope-"), "keiko-ui.db"),
    });
    seedSeparatedVoiceGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceApiKey: "rotated-realtime-token",
        voiceRealtimeModelId: "realtime-low",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    const after = requiredGatewayConfig(deps);
    expect(requiredProvider(after, "stt-low")).toEqual(requiredProvider(before, "stt-low"));
    expect(requiredProvider(after, "tts-low")).toEqual(requiredProvider(before, "tts-low"));
    expect(requiredProvider(after, "realtime-low").apiKey).toBe("rotated-realtime-token");
    expect(requiredCapability(after, "realtime-low").realtimeTranscriptionModel).toBe(
      "realtime-low-transcription",
    );
    deps.store.close();
  });

  it("rotates a shared credential across deployments on the same audio endpoint", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-shared-credential-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-shared-credential-"), "keiko-ui.db"),
    });
    seedSharedEndpointVoiceGateway(deps);

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceApiKey: "rotated-shared-token" }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = requiredGatewayConfig(deps);
    expect(
      ["stt-low", "tts-low", "realtime-low"].map(
        (modelId) => requiredProvider(config, modelId).apiKey,
      ),
    ).toEqual(["rotated-shared-token", "rotated-shared-token", "rotated-shared-token"]);
    deps.store.close();
  });

  it("requires every carried role to be explicit when a multi-role endpoint changes", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-multi-endpoint-partial-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-multi-endpoint-partial-"), "keiko-ui.db"),
    });
    seedMultiRoleVoiceGateway(deps);
    const before = requiredGatewayConfig(deps);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceApiKey: "replacement-audio-token",
        voiceProviderLocality: "customer-hosted",
        voiceRealtimeModelId: "multi-role",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(requiredGatewayConfig(deps)).toEqual(before);
    deps.store.close();
  });

  it("accepts a fully explicit multi-role endpoint migration without inherited capabilities", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-multi-endpoint-full-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-multi-endpoint-full-"), "keiko-ui.db"),
    });
    seedMultiRoleVoiceGateway(deps);

    const missingVoice = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceApiKey: "replacement-audio-token",
        voiceProviderLocality: "customer-hosted",
        voiceSpeechToTextModelId: "multi-role",
        voiceSpeechOutputModelId: "multi-role",
        voiceRealtimeModelId: "multi-role",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );
    expect(missingVoice).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST" } },
    });

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceApiKey: "replacement-audio-token",
        voiceProviderLocality: "customer-hosted",
        voiceSpeechToTextModelId: "multi-role",
        voiceSpeechOutputModelId: "multi-role",
        voiceOutputVoiceId: "replacement-voice",
        voiceRealtimeModelId: "multi-role",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = requiredGatewayConfig(deps);
    expect(requiredProvider(config, "multi-role")).toMatchObject({
      baseUrl: "https://replacement-audio.example.com/v1",
      apiKey: "replacement-audio-token",
      voiceProfiles: [{ persona: "neutral", voiceId: "replacement-voice" }],
    });
    const capability = requiredCapability(config, "multi-role");
    expect(capability).toMatchObject({
      supportsSpeechInput: true,
      supportsSpeechOutput: true,
      supportsRealtimeVoice: true,
      realtimeTranscriptionModel: "replacement-transcription",
    });
    expect(capability.supportsSemanticTurnDetection).toBeUndefined();
    deps.store.close();
  });

  it("does not advertise semantic turn detection unless setup explicitly enables it", async () => {
    const uiDir = await tempDir("keiko-gw-ui-voice-semantic-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-voice-semantic-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);

    const updated = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceRealtimeModelId: "realtime-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcription-model",
        voiceSupportsSemanticTurnDetection: false,
      }),
      deps,
    );

    expect(updated.status).toBe(200);
    const config = currentGatewayConfig(deps);
    if (config === undefined) throw new Error("expected saved Realtime gateway config");
    expect(
      config.capabilities?.find((capability) => capability.id === "realtime-model")
        ?.supportsSemanticTurnDetection,
    ).toBeUndefined();
    deps.store.close();
  });

  it.each([
    {
      label: "credential-only rotation",
      update: { voiceApiKey: "rotated-audio-token" },
      expectedModelId: "realtime-model",
      expectedSupport: true,
    },
    {
      label: "equivalent normalized endpoint",
      update: { voiceBaseUrl: " https://audio.example.com/v1/// " },
      expectedModelId: "realtime-model",
      expectedSupport: true,
    },
    {
      label: "same provider identity",
      update: {
        voiceRealtimeModelId: "realtime-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcription",
      },
      expectedModelId: "realtime-model",
      expectedSupport: true,
    },
    {
      label: "changed provider identity",
      update: {
        voiceRealtimeModelId: "replacement-realtime",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      },
      expectedModelId: "replacement-realtime",
      expectedSupport: false,
    },
    {
      label: "explicit capability resubmission for a changed endpoint",
      update: {
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
        voiceApiKey: "replacement-audio-token",
        voiceProviderLocality: "customer-hosted",
        voiceRealtimeModelId: "realtime-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcription",
        voiceSupportsSemanticTurnDetection: true,
      },
      expectedModelId: "realtime-model",
      expectedSupport: true,
    },
  ])(
    "resolves Semantic VAD against the Realtime deployment identity: $label",
    async ({ update, expectedModelId, expectedSupport }) => {
      const deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: await tempDir("keiko-gw-ev-semantic-identity-"),
        env: { ...VAULT_ENV },
        uiDbPath: join(await tempDir("keiko-gw-ui-semantic-identity-"), "keiko-ui.db"),
      });
      seedSemanticRealtimeGateway(deps);

      const result = await handleGatewaySetup(ctx({ preserveExisting: true, ...update }), deps);

      expect(result.status).toBe(200);
      const capability = requiredCapability(requiredGatewayConfig(deps), expectedModelId);
      expect(capability.supportsSemanticTurnDetection === true).toBe(expectedSupport);
      deps.store.close();
    },
  );

  it("does not transfer Semantic VAD from a non-selected Realtime provider", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-semantic-provider-binding-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-semantic-provider-binding-"), "keiko-ui.db"),
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "selected-realtime",
            baseUrl: "https://audio.example.com/v1",
            apiKey: "selected-token",
            capability: {
              kind: "voice",
              supportsRealtimeVoice: true,
              realtimeTranscriptionModel: "selected-transcription",
              voiceProviderLocality: "azure-foundry",
            },
          },
          {
            modelId: "other-semantic-realtime",
            baseUrl: "https://other-audio.example.com/v1",
            apiKey: "other-token",
            capability: {
              kind: "voice",
              supportsRealtimeVoice: true,
              supportsSemanticTurnDetection: true,
              realtimeTranscriptionModel: "other-transcription",
              voiceProviderLocality: "customer-hosted",
            },
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceTimeoutMs: 45_000 }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(
      requiredCapability(requiredGatewayConfig(deps), "selected-realtime")
        .supportsSemanticTurnDetection,
    ).toBeUndefined();
    deps.store.close();
  });

  it("preserves every voice provider and updates the runtime-elected provider for each role", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-runtime-voice-election-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-runtime-voice-election-"), "keiko-ui.db"),
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          ...voiceElectionProviders(),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );
    const before = requiredGatewayConfig(deps);
    const highCostProviders = ["stt-high", "tts-high", "realtime-high"].map((modelId) =>
      requiredProvider(before, modelId),
    );

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceTimeoutMs: 45_000 }),
      deps,
    );

    expect(result.status).toBe(200);
    const after = requiredGatewayConfig(deps);
    expect(after.providers.map((provider) => provider.modelId).sort()).toEqual(
      before.providers.map((provider) => provider.modelId).sort(),
    );
    expect(
      ["stt-low", "tts-low", "realtime-low"].map(
        (modelId) => requiredProvider(after, modelId).timeoutMs,
      ),
    ).toEqual([45_000, 45_000, 45_000]);
    expect(
      ["stt-high", "tts-high", "realtime-high"].map((modelId) => requiredProvider(after, modelId)),
    ).toEqual(highCostProviders);
    expect(requiredCapability(after, "realtime-low").supportsSemanticTurnDetection).toBe(true);

    const replacementResult = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceRealtimeModelId: "realtime-replacement",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );

    expect(replacementResult.status).toBe(200);
    const replaced = requiredGatewayConfig(deps);
    expect(replaced.providers.map((provider) => provider.modelId).sort()).toEqual([
      "example-chat-model",
      "realtime-replacement",
      "stt-high",
      "stt-low",
      "tts-high",
      "tts-low",
    ]);
    expect(requiredProvider(replaced, "realtime-replacement")).toMatchObject({
      baseUrl: "https://realtime-low.example.com/v1",
      apiKey: "realtime-low-token",
      timeoutMs: 45_000,
    });
    expect(
      requiredCapability(replaced, "realtime-replacement").supportsSemanticTurnDetection,
    ).toBeUndefined();
    deps.store.close();
  });

  it("inherits replacement connection metadata from the runtime-elected voice provider", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-runtime-voice-replacement-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-runtime-voice-replacement-"), "keiko-ui.db"),
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          ...voiceElectionProviders(),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceRealtimeModelId: "realtime-replacement",
        voiceRealtimeTranscriptionModelId: "replacement-transcription",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(requiredProvider(requiredGatewayConfig(deps), "realtime-replacement")).toMatchObject({
      baseUrl: "https://realtime-low.example.com/v1",
      apiKey: "realtime-low-token",
      timeoutMs: 10_000,
    });
    deps.store.close();
  });

  it("retains non-elected roles carried by a provider elected for another voice role", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-multi-role-provider-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-multi-role-provider-"), "keiko-ui.db"),
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "multi-role",
            baseUrl: "https://multi-role.example.com/v1",
            apiKey: "multi-role-token",
            capability: {
              kind: "voice",
              costClass: "medium",
              supportsSpeechInput: true,
              supportsSpeechOutput: true,
              supportsRealtimeVoice: true,
              supportsSemanticTurnDetection: true,
              realtimeTranscriptionModel: "multi-role-transcription",
              voiceProviderLocality: "customer-hosted",
            },
            voiceProfiles: [{ persona: "neutral", voiceId: "multi-role-voice" }],
          },
          ...voiceElectionProviders().filter((provider) =>
            ["stt-high", "tts-low", "realtime-low"].includes(String(provider.modelId)),
          ),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceTimeoutMs: 45_000 }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = requiredGatewayConfig(deps);
    expect(requiredCapability(config, "multi-role")).toMatchObject({
      supportsSpeechInput: true,
      supportsSpeechOutput: true,
      supportsRealtimeVoice: true,
      supportsSemanticTurnDetection: true,
      realtimeTranscriptionModel: "multi-role-transcription",
    });
    expect(requiredProvider(config, "multi-role").voiceProfiles).toEqual([
      { persona: "neutral", voiceId: "multi-role-voice" },
    ]);

    const beforeEndpointChange = requiredGatewayConfig(deps);
    const changedEndpoint = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceBaseUrl: "https://replacement-audio.example.com/v1",
      }),
      deps,
    );

    expect(changedEndpoint).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST" } },
    });
    expect(requiredGatewayConfig(deps)).toEqual(beforeEndpointChange);
    deps.store.close();
  });

  it("rejects a non-boolean semantic turn detection capability", async () => {
    const uiDir = await tempDir("keiko-gw-ui-voice-semantic-type-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-voice-semantic-type-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm.example.com/v1",
        apiKey: "chat-token",
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceRealtimeModelId: "realtime-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcription-model",
        voiceSupportsSemanticTurnDetection: "true",
      }),
      deps,
    );

    expect(result).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "voiceSupportsSemanticTurnDetection must be a boolean.",
        },
      },
    });
    deps.store.close();
  });

  it("keeps existing voice locality and persona mappings on a semantic-VAD-only update", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-preserve-voice-metadata-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-preserve-voice-metadata-"), "keiko-ui.db"),
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "customer-realtime",
            baseUrl: "https://audio.example.com/v1",
            apiKey: "audio-token",
            capability: {
              kind: "voice",
              supportsSpeechOutput: true,
              supportsRealtimeVoice: true,
              supportsSemanticTurnDetection: true,
              realtimeTranscriptionModel: "customer-transcription",
              voiceProviderLocality: "customer-hosted",
            },
            voiceProfiles: [
              { persona: "male", voiceId: "customer-male" },
              { persona: "neutral", voiceId: "customer-neutral" },
            ],
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );

    const result = await handleGatewaySetup(
      ctx({ preserveExisting: true, voiceSupportsSemanticTurnDetection: false }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = requiredGatewayConfig(deps);
    const capability = requiredCapability(config, "customer-realtime");
    expect(capability.voiceProviderLocality).toBe("customer-hosted");
    expect(capability.supportsSemanticTurnDetection).toBeUndefined();
    expect(
      config.providers.find((provider) => provider.modelId === "customer-realtime")?.voiceProfiles,
    ).toEqual([
      { persona: "male", voiceId: "customer-male" },
      { persona: "neutral", voiceId: "customer-neutral" },
    ]);
    deps.store.close();
  });

  it("preserves heterogeneous voice providers and replaces only the targeted Realtime role", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-heterogeneous-voice-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-heterogeneous-voice-"), "keiko-ui.db"),
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "dedicated-stt",
            baseUrl: "https://stt.example.com/v1",
            apiKey: "stt-token",
            apiKeyHeaderName: "x-api-key",
            timeoutMs: 11_000,
            maxRetries: 3,
            retryBaseDelayMs: 111,
            capability: {
              kind: "voice",
              supportsSpeechInput: true,
              voiceProviderLocality: "local-only",
            },
          },
          {
            modelId: "dedicated-tts",
            baseUrl: "https://tts.example.com/v1",
            apiKey: "tts-token",
            apiKeyHeaderName: "Authorization",
            timeoutMs: 22_000,
            maxRetries: 4,
            retryBaseDelayMs: 222,
            capability: {
              kind: "voice",
              supportsSpeechOutput: true,
              supportsSpeechSynthesisInstructions: true,
              voiceProviderLocality: "customer-hosted",
            },
            voiceProfiles: [{ persona: "male", voiceId: "tts-male" }],
          },
          {
            modelId: "dedicated-realtime",
            baseUrl: "https://realtime.example.com/v1",
            apiKey: "realtime-token",
            apiKeyHeaderName: "api-key",
            timeoutMs: 33_000,
            maxRetries: 5,
            retryBaseDelayMs: 333,
            realtimeAuthMode: "ephemeral-session",
            capability: {
              kind: "voice",
              supportsRealtimeVoice: true,
              supportsSemanticTurnDetection: true,
              realtimeTranscriptionModel: "realtime-transcription",
              voiceProviderLocality: "azure-foundry",
            },
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );
    const original = requiredGatewayConfig(deps);
    const originalStt = requiredProvider(original, "dedicated-stt");
    const originalTts = requiredProvider(original, "dedicated-tts");
    const originalRealtime = requiredProvider(original, "dedicated-realtime");

    expect(
      (
        await handleGatewaySetup(
          ctx({ preserveExisting: true, voiceSupportsSemanticTurnDetection: false }),
          deps,
        )
      ).status,
    ).toBe(200);
    const afterCapabilityUpdate = requiredGatewayConfig(deps);
    expect(requiredProvider(afterCapabilityUpdate, "dedicated-stt")).toEqual(originalStt);
    expect(requiredProvider(afterCapabilityUpdate, "dedicated-tts")).toEqual(originalTts);
    expect(requiredProvider(afterCapabilityUpdate, "dedicated-realtime")).toEqual(originalRealtime);
    expect(
      requiredCapability(afterCapabilityUpdate, "dedicated-tts")
        .supportsSpeechSynthesisInstructions,
    ).toBe(true);

    expect(
      (
        await handleGatewaySetup(
          ctx({
            preserveExisting: true,
            voiceRealtimeModelId: "replacement-realtime",
            voiceRealtimeTranscriptionModelId: "replacement-transcription",
          }),
          deps,
        )
      ).status,
    ).toBe(200);
    const afterReplacement = requiredGatewayConfig(deps);
    expect(requiredProvider(afterReplacement, "dedicated-stt")).toEqual(originalStt);
    expect(requiredProvider(afterReplacement, "dedicated-tts")).toEqual(originalTts);
    expect(
      afterReplacement.providers.some((provider) => provider.modelId === "dedicated-realtime"),
    ).toBe(false);
    expect(requiredProvider(afterReplacement, "replacement-realtime")).toMatchObject({
      baseUrl: originalRealtime.baseUrl,
      apiKey: originalRealtime.apiKey,
      apiKeyHeaderName: originalRealtime.apiKeyHeaderName,
      timeoutMs: originalRealtime.timeoutMs,
      maxRetries: originalRealtime.maxRetries,
      retryBaseDelayMs: originalRealtime.retryBaseDelayMs,
      realtimeAuthMode: originalRealtime.realtimeAuthMode,
    });
    const replacement = requiredCapability(afterReplacement, "replacement-realtime");
    expect(replacement.supportsSemanticTurnDetection).toBeUndefined();
    expect(replacement.realtimeTranscriptionModel).toBe("replacement-transcription");
    expect(
      requiredProvider(afterReplacement, "replacement-realtime").voiceProfiles,
    ).toBeUndefined();

    const missingReplacementVoice = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceSpeechOutputModelId: "replacement-tts",
      }),
      deps,
    );
    expect(missingReplacementVoice).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST" } },
    });
    expect(JSON.stringify(missingReplacementVoice.body)).toContain(
      "voiceOutputVoiceId is required",
    );

    expect(
      (
        await handleGatewaySetup(
          ctx({
            preserveExisting: true,
            voiceSpeechOutputModelId: "replacement-tts",
            voiceOutputVoiceId: "replacement-neutral",
          }),
          deps,
        )
      ).status,
    ).toBe(200);
    const afterTtsReplacement = requiredGatewayConfig(deps);
    expect(requiredProvider(afterTtsReplacement, "replacement-tts").voiceProfiles).toEqual([
      { persona: "neutral", voiceId: "replacement-neutral" },
    ]);
    expect(
      requiredProvider(afterTtsReplacement, "replacement-realtime").voiceProfiles,
    ).toBeUndefined();
    deps.store.close();
  });

  it("explains the missing shared audio connection when only a Realtime deployment is entered", async () => {
    const uiDir = await tempDir("keiko-gw-ui-voice-connection-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-voice-connection-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({ baseUrl: "https://llm.example.com/v1", apiKey: "chat-token" }),
          deps,
        )
      ).status,
    ).toBe(200);

    const result = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        voiceRealtimeModelId: "realtime-model",
        voiceRealtimeTranscriptionModelId: "realtime-transcription-model",
      }),
      deps,
    );

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain(
      "Audio endpoint URL and credential are required when an audio model is selected.",
    );
    deps.store.close();
  });

  it("rejects a live transcription deployment without a Realtime role", async () => {
    const uiDir = await tempDir("keiko-gw-ui-voice-transcription-role-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-voice-transcription-role-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });

    const result = await handleGatewaySetup(
      ctx(
        {
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
          voiceBaseUrl: "https://audio.example.com/v1",
          voiceApiKey: "audio-token",
          voiceRealtimeTranscriptionModelId: "realtime-transcribe-model",
        },
        "corr-voice-transcription-role",
      ),
      deps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: {
        code: "BAD_REQUEST",
        correlationId: "corr-voice-transcription-role",
        message: "voiceRealtimeTranscriptionModelId requires voiceRealtimeModelId.",
      },
    });
    deps.store.close();
  });

  it("requires an explicit compatible transcription deployment for a new Realtime role", async () => {
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-realtime-transcription-required-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(await tempDir("keiko-gw-ui-realtime-transcription-required-"), "keiko-ui.db"),
    });

    const result = await handleGatewaySetup(
      ctx(
        {
          baseUrl: "https://llm.example.com/v1",
          apiKey: "chat-token",
          voiceBaseUrl: "https://audio.example.com/v1",
          voiceApiKey: "audio-token",
          voiceRealtimeModelId: "realtime-model",
        },
        "corr-realtime-transcription-required",
      ),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          correlationId: "corr-realtime-transcription-required",
          message:
            "voiceRealtimeTranscriptionModelId is required when voiceRealtimeModelId is configured or replaced.",
        },
      },
    });
    deps.store.close();
  });

  it("stores an optional Figma PAT submitted through browser gateway setup", async () => {
    const uiDir = await tempDir("keiko-gw-ui-figma-");
    const evidenceDir = await tempDir("keiko-gw-ev-figma-");
    const figmaSmokeCalls: { readonly token: string; readonly egress: unknown }[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
      figmaCredentialTester: (token, egress) => {
        figmaSmokeCalls.push({ token, egress });
        return Promise.resolve();
      },
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com",
        apiKey: "example-secret-token",
        figmaAccessToken: " figd_setup-config-token ",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(figmaSmokeCalls).toEqual([{ token: "figd_setup-config-token", egress: undefined }]);
    expect(currentGatewayConfig(deps)?.figma?.accessToken).toBe("figd_setup-config-token");
    expect(JSON.stringify(result.body)).not.toContain("figd_setup-config-token");
    const savedPath = deps.gatewayConfig?.storagePath;
    expect(savedPath).toBeDefined();
    // Issue #1320: the PAT is routed into the encrypted Figma token vault, never written to JSON.
    expect(readFileSync(savedPath ?? "", "utf8")).not.toContain("figd_setup-config-token");
    const figmaVault = readFileSync(join(evidenceDir, "figma", "figma-token.vault"), "utf8");
    expect(figmaVault).not.toContain("figd_setup-config-token");
    expect(figmaVault.startsWith("kv1.")).toBe(true);
    deps.store.close();
  });

  it("smoke-tests submitted Figma PATs with the default /v1/me request before saving", async () => {
    const uiDir = await tempDir("keiko-gw-ui-figma-default-smoke-");
    const evidenceDir = await tempDir("keiko-gw-ev-figma-default-smoke-");
    const originalFetch = globalThis.fetch;
    const seen: { readonly url: string; readonly token: string | null }[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      const href = fetchInputUrl(url);
      const headers = new Headers(init?.headers);
      seen.push({ url: href, token: headers.get("x-figma-token") });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "figma-user", email: "user@example.invalid" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    globalThis.fetch = fakeFetch;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://llm-gateway.example.com",
          apiKey: "example-secret-token",
          figmaAccessToken: "figd_default-smoke-token",
        }),
        deps,
      );

      expect(result.status).toBe(200);
      expect(seen).toEqual([
        { url: "https://api.figma.com/v1/me", token: "figd_default-smoke-token" },
      ]);
      expect(currentGatewayConfig(deps)?.figma?.accessToken).toBe("figd_default-smoke-token");
      expect(JSON.stringify(result.body)).not.toContain("figd_default-smoke-token");
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("updates only the optional Figma PAT while preserving existing gateway credentials", async () => {
    const uiDir = await tempDir("keiko-gw-ui-figma-update-");
    const evidenceDir = await tempDir("keiko-gw-ev-figma-update-");
    let smokeCalls = 0;
    const figmaSmokeCalls: string[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) => {
        smokeCalls += 1;
        return Promise.resolve([modelIds[0] ?? "example-chat-model"]);
      },
      figmaCredentialTester: (token) => {
        figmaSmokeCalls.push(token);
        return Promise.resolve();
      },
    });

    const first = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(first.status).toBe(200);
    expect(smokeCalls).toBe(1);

    const updated = await handleGatewaySetup(
      ctx({ preserveExisting: true, figmaAccessToken: " figd_updated-config-token " }),
      deps,
    );

    expect(updated.status).toBe(200);
    expect(smokeCalls).toBe(1);
    expect(figmaSmokeCalls).toEqual(["figd_updated-config-token"]);
    const config = currentGatewayConfig(deps);
    expect(config?.providers[0]?.baseUrl).toBe("https://llm-gateway.example.com");
    expect(config?.providers[0]?.apiKey).toBe("example-secret-token");
    expect(config?.figma?.accessToken).toBe("figd_updated-config-token");
    expect(JSON.stringify(updated.body)).not.toContain("figd_updated-config-token");
    const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
    // Issue #1320: preserve-existing re-persists only references — never the plaintext credential
    // or the Figma PAT, which is routed into the encrypted token vault.
    expect(saved).not.toContain("example-secret-token");
    expect(saved).not.toContain("figd_updated-config-token");
    expect(saved).toContain("apiKeySecretRef");
    const figmaVault = readFileSync(join(evidenceDir, "figma", "figma-token.vault"), "utf8");
    expect(figmaVault).not.toContain("figd_updated-config-token");
    expect(figmaVault.startsWith("kv1.")).toBe(true);
    deps.store.close();
  });

  it("rejects an invalid Figma PAT update without overwriting the stored gateway config", async () => {
    const uiDir = await tempDir("keiko-gw-ui-figma-invalid-");
    const evidenceDir = await tempDir("keiko-gw-ev-figma-invalid-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
      figmaCredentialTester: () => Promise.reject(new FigmaConnectorError("FIGMA_TOKEN_INVALID")),
    });

    const first = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(first.status).toBe(200);
    const savedBefore = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");

    const updated = await handleGatewaySetup(
      ctx({ preserveExisting: true, figmaAccessToken: "figd_invalid-config-token" }),
      deps,
    );

    expect(updated.status).toBe(400);
    expect(JSON.stringify(updated.body)).toContain("FIGMA_TOKEN_INVALID");
    expect(JSON.stringify(updated.body)).not.toContain("figd_invalid-config-token");
    expect(currentGatewayConfig(deps)?.figma?.accessToken).toBeUndefined();
    expect(readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8")).toBe(savedBefore);
    deps.store.close();
  });

  it("stores selected image-input capabilities only for tested model ids", async () => {
    const uiDir = await tempDir("keiko-gw-ui-image-input-");
    const evidenceDir = await tempDir("keiko-gw-ev-image-input-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["text-chat", "vision-chat"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com",
        apiKey: "example-secret-token",
        imageInputModelIds: " vision-chat \n vision-chat ",
      }),
      deps,
    );

    expect(result.status).toBe(200);
    const saved = JSON.parse(readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8")) as {
      readonly providers: readonly {
        readonly modelId: string;
        readonly capability: { readonly supportsImageInput: boolean };
      }[];
    };
    expect(
      saved.providers.map((provider) => ({
        modelId: provider.modelId,
        supportsImageInput: provider.capability.supportsImageInput,
      })),
    ).toEqual([
      { modelId: "text-chat", supportsImageInput: false },
      { modelId: "vision-chat", supportsImageInput: true },
    ]);
    expect(JSON.stringify(result.body)).toContain('"supportsImageInput":true');
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    deps.store.close();
  });

  it("distinguishes an explicitly empty image list from an absent one in update mode", async () => {
    // Review finding on #3031: the wire must be able to say "no image-capable models" — an
    // explicit empty list clears the stored set, while an absent field keeps inheriting it,
    // exactly like the workflow-eligible field.
    const uiDir = await tempDir("keiko-gw-ui-image-empty-");
    const evidenceDir = await tempDir("keiko-gw-ev-image-empty-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["vision-chat"]),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });

    const first = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com",
        apiKey: "example-secret-token",
        imageInputModelIds: ["vision-chat"],
      }),
      deps,
    );
    expect(first.status).toBe(200);

    const savedImageFlags = (): readonly boolean[] => {
      const saved = JSON.parse(readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8")) as {
        readonly providers: readonly {
          readonly capability: { readonly supportsImageInput: boolean };
        }[];
      };
      return saved.providers.map((provider) => provider.capability.supportsImageInput);
    };
    expect(savedImageFlags()).toEqual([true]);

    // Absent field: the stored image-capable set survives the update untouched.
    const inherited = await handleGatewaySetup(
      ctx({ preserveExisting: true, timeoutMs: 90_000 }),
      deps,
    );
    expect(inherited.status).toBe(200);
    expect(savedImageFlags()).toEqual([true]);

    // Explicit empty list: the stored image-capable set clears.
    const cleared = await handleGatewaySetup(
      ctx({ preserveExisting: true, imageInputModelIds: [] }),
      deps,
    );
    expect(cleared.status).toBe(200);
    expect(savedImageFlags()).toEqual([false]);
    deps.store.close();
  });

  it("preserves stored embedding kinds through preserve-mode rebuilds despite the name heuristic", async () => {
    // Review finding on #3031 (P1): a preserve-mode rebuild inherits the stored deployment ids
    // and reclassifies them by name. A stored embedding provider whose id the heuristic misses
    // (discovery classified it at its own setup time) would be probed as chat, fail the probe,
    // and vanish from the rebuilt config while the user changed something unrelated. Stored
    // capability kinds are authoritative for preserved deployments.
    const uiDir = await tempDir("keiko-gw-ui-embed-kind-");
    const evidenceDir = await tempDir("keiko-gw-ev-embed-kind-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () =>
        Promise.resolve({
          modelIds: ["example-chat", "vectorizer-v2"],
          chatModelIds: ["example-chat"],
          embeddingModelIds: ["vectorizer-v2"],
        }),
      // A realistic chat probe: an embedding endpoint cannot answer it, so a misclassified
      // embedding id would be dropped as "failed", not rejected loudly.
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve(modelIds.filter((modelId) => modelId !== "vectorizer-v2")),
    });

    const first = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(first.status).toBe(200);

    const savedKinds = (): readonly (readonly string[])[] => {
      const saved = JSON.parse(readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8")) as {
        readonly providers: readonly {
          readonly modelId: string;
          readonly capability: { readonly kind: string };
        }[];
      };
      return saved.providers.map((provider) => [provider.modelId, provider.capability.kind]);
    };
    expect(savedKinds()).toEqual([
      ["example-chat", "chat"],
      ["vectorizer-v2", "embedding"],
    ]);

    // Clearing image capability rebuilds with inherited deployments — the embedding survives.
    const cleared = await handleGatewaySetup(
      ctx({ preserveExisting: true, imageInputModelIds: [] }),
      deps,
    );
    expect(cleared.status).toBe(200);
    expect(savedKinds()).toEqual([
      ["example-chat", "chat"],
      ["vectorizer-v2", "embedding"],
    ]);

    // Same class: rotating the credential also rebuilds with inherited deployments.
    const rotated = await handleGatewaySetup(
      ctx({ preserveExisting: true, apiKey: "example-rotated-token" }),
      deps,
    );
    expect(rotated.status).toBe(200);
    expect(savedKinds()).toEqual([
      ["example-chat", "chat"],
      ["vectorizer-v2", "embedding"],
    ]);
    deps.store.close();
  });

  it("restores stored OCR providers verbatim through preserve-mode rebuilds", async () => {
    // Review finding on #3031 (P1): the rebuild only re-derives chat and embedding providers, so
    // a stored ocr-vision provider was chat-probed and silently dropped (or reclassified) by an
    // unrelated preserve-mode update. Stored OCR providers now bypass the probe and are restored
    // like voice providers.
    const uiDir = await tempDir("keiko-gw-ui-ocr-kind-");
    const evidenceDir = await tempDir("keiko-gw-ev-ocr-kind-");
    const probedModelIds: string[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        probedModelIds.push(...modelIds);
        return Promise.resolve(
          modelIds.filter((modelId) => modelId !== "scan-ocr" && modelId !== "remote-ocr"),
        );
      },
    });
    const ocrCapability = (id: string): Record<string, unknown> => ({
      id,
      kind: "ocr-vision",
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      supportsImageInput: false,
      supportsDocumentInput: true,
      workflowEligible: false,
      costClass: "low",
      latencyClass: "fast",
      throughputHint: "test ocr deployment",
      preferredUseCases: ["Document OCR"],
      knownLimitations: [],
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected gateway config store");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "scan-ocr",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
            capability: ocrCapability("scan-ocr"),
          },
          {
            modelId: "remote-ocr",
            baseUrl: "https://ocr.example.com",
            apiKey: "dedicated-ocr-token",
            capability: ocrCapability("remote-ocr"),
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );

    // Persisted credentials live in the vault, so token assertions go through the loaded
    // configuration exactly like the other rotation tests in this file.
    const savedOcr = (): ReadonlyMap<string, { kind: string | undefined; apiKey: string }> => {
      const config = currentGatewayConfig(deps);
      return new Map(
        (config?.providers ?? []).map((provider) => [
          provider.modelId,
          {
            kind: config?.capabilities?.find((item) => item.id === provider.modelId)?.kind,
            apiKey: provider.apiKey,
          },
        ]),
      );
    };

    const cleared = await handleGatewaySetup(
      ctx({ preserveExisting: true, imageInputModelIds: [] }),
      deps,
    );
    expect(cleared.status).toBe(200);
    expect(savedOcr().get("scan-ocr")?.kind).toBe("ocr-vision");
    expect(savedOcr().get("remote-ocr")?.kind).toBe("ocr-vision");
    // The stored OCR deployments are never chat-probed — they have no chat protocol to answer.
    expect(probedModelIds).not.toContain("scan-ocr");
    expect(probedModelIds).not.toContain("remote-ocr");

    // Rotating the gateway token refreshes the same-endpoint OCR credential with it (the old
    // token dies with the rotation) while a dedicated-endpoint OCR keeps its own — the fresh
    // token must never travel to a URL it was not tested against (review finding on #3031).
    const rotated = await handleGatewaySetup(
      ctx({ preserveExisting: true, apiKey: "example-rotated-token" }),
      deps,
    );
    expect(rotated.status).toBe(200);
    expect(savedOcr().get("scan-ocr")?.apiKey).toBe("example-rotated-token");
    expect(savedOcr().get("remote-ocr")?.apiKey).toBe("dedicated-ocr-token");

    // An explicitly submitted deployment list is authoritative: OCR restoration applies only to
    // inherited deployments, so omitting the OCR ids here REMOVES them (review finding on #3031).
    const replaced = await handleGatewaySetup(
      ctx({ preserveExisting: true, deploymentNames: ["example-chat"] }),
      deps,
    );
    expect(replaced.status).toBe(200);
    expect(savedOcr().get("scan-ocr")).toBeUndefined();
    expect(savedOcr().get("remote-ocr")).toBeUndefined();
    deps.store.close();
  });

  it("preserves reranker, egress, and a same-endpoint embedding's own credential through rebuilds", async () => {
    // Review findings on #3031 (P1): the rebuild copied only grounding and figma from the
    // current configuration — a configured reranker vanished and the persisted config lost its
    // egress topology after restart. And an embedding sharing the gateway URL but carrying its
    // OWN credential was rebuilt with the gateway-wide token. Dedicated identity now compares
    // the full stored connection, and every untouched top-level block survives.
    const uiDir = await tempDir("keiko-gw-ui-blocks-");
    const evidenceDir = await tempDir("keiko-gw-ev-blocks-");
    const probedModelIds: string[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        probedModelIds.push(...modelIds);
        return Promise.resolve(modelIds.filter((modelId) => modelId !== "own-key-embedding"));
      },
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected gateway config store");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "own-key-embedding",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "embedding-only-token",
            capability: { id: "own-key-embedding", kind: "embedding" },
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        reranker: {
          modelId: "rerank-1",
          baseUrl: "https://rerank.example.com",
          apiKey: "rerank-token",
          timeoutMs: 10_000,
        },
        egress: { httpProxy: "http://proxy.example.com:3128" },
      }),
      true,
    );

    const cleared = await handleGatewaySetup(
      ctx({ preserveExisting: true, imageInputModelIds: [] }),
      deps,
    );
    expect(cleared.status).toBe(200);
    const config = currentGatewayConfig(deps);
    expect(config?.reranker?.modelId).toBe("rerank-1");
    expect(config?.reranker?.apiKey).toBe("rerank-token");
    expect(config?.egress?.httpProxy).toContain("proxy.example.com:3128");
    const embedding = config?.providers.find(
      (provider) => provider.modelId === "own-key-embedding",
    );
    expect(embedding?.apiKey).toBe("embedding-only-token");
    expect(probedModelIds).not.toContain("own-key-embedding");
    deps.store.close();
  });

  it("keeps stored voice deployments out of the chat probe during inherited rebuilds", async () => {
    // Review finding on #3031: inherited deploymentNames carried stored voice ids into the chat
    // probe — a succeeding probe persisted a DUPLICATE provider for the voice model id, a
    // failing one misreported a restored voice model as skipped.
    const uiDir = await tempDir("keiko-gw-ui-voice-probe-");
    const evidenceDir = await tempDir("keiko-gw-ev-voice-probe-");
    const probedModelIds: string[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        probedModelIds.push(...modelIds);
        return Promise.resolve(modelIds);
      },
    });
    seedSeparatedVoiceGateway(deps);

    const cleared = await handleGatewaySetup(
      ctx({ preserveExisting: true, imageInputModelIds: [] }),
      deps,
    );
    expect(cleared.status).toBe(200);
    const config = currentGatewayConfig(deps);
    const voiceIds = ["stt-low", "tts-low", "realtime-low"];
    for (const voiceId of voiceIds) {
      expect(probedModelIds).not.toContain(voiceId);
      expect(config?.providers.filter((provider) => provider.modelId === voiceId)).toHaveLength(1);
    }
    deps.store.close();
  });

  it("preserves a dedicated-endpoint embedding provider through preserve-mode rebuilds", async () => {
    // Review finding on #3031 (P1): the rebuild wrote every embedding onto the setup-wide
    // connection, silently migrating an embedding that lives on its OWN endpoint (with its own
    // credential) onto the chat gateway during an unrelated update. Same silent-loss class as
    // stored OCR — dedicated embeddings are now restored verbatim instead of rebuilt.
    const uiDir = await tempDir("keiko-gw-ui-embed-dedicated-");
    const evidenceDir = await tempDir("keiko-gw-ev-embed-dedicated-");
    const probedModelIds: string[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        probedModelIds.push(...modelIds);
        return Promise.resolve(modelIds.filter((modelId) => modelId !== "vector-dedicated"));
      },
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected gateway config store");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "example-chat",
            baseUrl: "https://llm.example.com/v1",
            apiKey: "chat-token",
          },
          {
            modelId: "vector-dedicated",
            baseUrl: "https://embed.example.com",
            apiKey: "embed-token",
            capability: { id: "vector-dedicated", kind: "embedding" },
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      true,
    );

    const cleared = await handleGatewaySetup(
      ctx({ preserveExisting: true, imageInputModelIds: [] }),
      deps,
    );
    expect(cleared.status).toBe(200);
    const config = currentGatewayConfig(deps);
    const embedding = config?.providers.find((provider) => provider.modelId === "vector-dedicated");
    expect(embedding?.baseUrl).toBe("https://embed.example.com");
    expect(embedding?.apiKey).toBe("embed-token");
    expect(config?.capabilities?.find((item) => item.id === "vector-dedicated")?.kind).toBe(
      "embedding",
    );
    expect(probedModelIds).not.toContain("vector-dedicated");
    deps.store.close();
  });

  it("does not store image-input capability claims for models that fail setup testing", async () => {
    const uiDir = await tempDir("keiko-gw-ui-image-input-fail-");
    const evidenceDir = await tempDir("keiko-gw-ev-image-input-fail-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["text-chat", "vision-chat"]),
      gatewaySetupTester: () => Promise.resolve(["text-chat"]),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com",
        apiKey: "example-secret-token",
        imageInputModelIds: ["vision-chat"],
      }),
      deps,
    );

    expect(result.status).toBe(502);
    expect(deps.gatewayConfig?.present()).toBe(false);
    expect(existsSync(deps.gatewayConfig?.storagePath ?? "")).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    deps.store.close();
  });

  it("passes env egress to discovery and smoke tests without persisting topology", async () => {
    const uiDir = await tempDir("keiko-gw-ui-egress-");
    const evidenceDir = await tempDir("keiko-gw-ev-egress-");
    let discoveryEgress: unknown;
    let testerEgress: unknown;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {
        KEIKO_HTTPS_PROXY: "http://proxy.internal.example:8443",
        KEIKO_NO_PROXY: "localhost,.corp.example",
        KEIKO_CA_BUNDLE_PATH: "/etc/keiko/internal-ca.pem",
      },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: (_baseUrl, _apiKey, _apiKeyHeaderName, egress) => {
        discoveryEgress = egress;
        return Promise.resolve(["example-chat-model"]);
      },
      gatewaySetupTester: (config, modelIds) => {
        testerEgress = config.egress;
        return Promise.resolve(modelIds);
      },
    });
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(discoveryEgress).toEqual({
      httpsProxy: "http://proxy.internal.example:8443/",
      noProxy: ["localhost", ".corp.example"],
      caBundlePath: "/etc/keiko/internal-ca.pem",
    });
    expect(testerEgress).toEqual(discoveryEgress);
    expect(currentGatewayConfig(deps)?.egress).toEqual(discoveryEgress);
    const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
    expect(saved).not.toContain("proxy.internal.example");
    expect(saved).not.toContain("internal-ca.pem");
    expect(saved).not.toContain("egress");
    deps.store.close();
  });

  it("passes config-file-only egress to discovery and smoke tests without configured providers", async () => {
    const uiDir = await tempDir("keiko-gw-ui-file-egress-");
    const evidenceDir = await tempDir("keiko-gw-ev-file-egress-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        egress: {
          httpsProxy: "http://proxy.config.internal.example:8443",
          noProxy: "localhost,.corp.example",
          caBundlePath: "/etc/keiko/config-ca.pem",
        },
      }),
      "utf8",
    );
    let discoveryEgress: unknown;
    let testerEgress: unknown;
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: (_baseUrl, _apiKey, _apiKeyHeaderName, egress) => {
        discoveryEgress = egress;
        return Promise.resolve(["example-chat-model"]);
      },
      gatewaySetupTester: (config, modelIds) => {
        testerEgress = config.egress;
        return Promise.resolve(modelIds);
      },
    });
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    const expectedEgress = {
      httpsProxy: "http://proxy.config.internal.example:8443/",
      noProxy: ["localhost", ".corp.example"],
      caBundlePath: "/etc/keiko/config-ca.pem",
    };
    expect(result.status).toBe(200);
    expect(deps.config).toBeUndefined();
    expect(discoveryEgress).toEqual(expectedEgress);
    expect(testerEgress).toEqual(expectedEgress);
    expect(currentGatewayConfig(deps)?.egress).toEqual(expectedEgress);
    const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
    expect(saved).not.toContain("proxy.config.internal.example");
    expect(saved).not.toContain("config-ca.pem");
    expect(saved).not.toContain("egress");
    deps.store.close();
  });

  it("rejects a symlinked final gateway config target", async () => {
    const uiDir = await tempDir("keiko-gw-ui-link-target-");
    const evidenceDir = await tempDir("keiko-gw-ev-link-target-");
    const storagePath = join(uiDir, "keiko.config.json");
    const realTarget = join(uiDir, "keiko.config.real.json");
    writeFileSync(realTarget, "seed\n", "utf8");
    symlinkSync(realTarget, storagePath);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(502);
    expect(deps.gatewayConfig?.present()).toBe(false);
    expect(lstatSync(storagePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realTarget, "utf8")).toBe("seed\n");
    deps.store.close();
  });

  it("rejects a symlinked ancestor of the gateway config path", async () => {
    const workspaceDir = await tempDir("keiko-gw-ui-link-ancestor-");
    const realDir = await tempDir("keiko-gw-real-ancestor-");
    const evidenceDir = await tempDir("keiko-gw-ev-link-ancestor-");
    const linkedDir = join(workspaceDir, "linked");
    symlinkSync(realDir, linkedDir, "dir");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(workspaceDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "example-chat-model"]),
    });
    (deps.gatewayConfig as { storagePath: string }).storagePath = join(
      linkedDir,
      "keiko.config.json",
    );
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(502);
    expect(deps.gatewayConfig?.present()).toBe(false);
    expect(existsSync(join(realDir, "keiko.config.json"))).toBe(false);
    deps.store.close();
  });

  it("tries a /v1 base URL fallback when the entered URL fails", async () => {
    const uiDir = await tempDir("keiko-gw-ui-v1-");
    const evidenceDir = await tempDir("keiko-gw-ev-v1-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: (config, modelIds) => {
        const baseUrl = config.providers[0]?.baseUrl ?? "";
        if (!baseUrl.endsWith("/v1")) {
          return Promise.reject(new Error("not found"));
        }
        return Promise.resolve([modelIds[0] ?? "example-chat-model"]);
      },
    });
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(currentGatewayConfig(deps)?.providers[0]?.baseUrl).toBe(
      "https://llm-gateway.example.com/v1",
    );
    deps.store.close();
  });

  it("does not store credentials when the smoke test fails", async () => {
    const uiDir = await tempDir("keiko-gw-ui-fail-");
    const evidenceDir = await tempDir("keiko-gw-ev-fail-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: () => Promise.reject(new Error("provider rejected credentials")),
    });
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(502);
    expect(deps.gatewayConfig?.present()).toBe(false);
    expect(existsSync(deps.gatewayConfig?.storagePath ?? "")).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("https://llm-gateway.example.com");
    deps.store.close();
  });

  it("never reflects provider response bodies from a failed setup probe", async () => {
    const uiDir = await tempDir("keiko-gw-ui-body-free-failure-");
    const evidenceDir = await tempDir("keiko-gw-ev-body-free-failure-");
    const providerBody = "customer prompt and upstream response body must stay private";
    const diagnostics: ServerDiagnosticRecord[] = [];
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.resolve(["example-chat-model"]),
      gatewaySetupTester: () =>
        Promise.reject(new Error(`upstream returned 500 with body: ${providerBody}`)),
      diagnostics: { record: (record): void => void diagnostics.push(record) },
    });

    const result = await handleGatewaySetup(
      ctx(
        { baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" },
        "corr-body-free-setup",
      ),
      deps,
    );

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: { correlationId: "corr-body-free-setup" },
    });
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correlationId: "corr-body-free-setup",
          operation: "POST /api/gateway/setup",
          source: "gateway.setup.provider-verify",
          message: "Provider verification failed without exposing upstream response details.",
        }),
      ]),
    );
    expect(JSON.stringify(result.body)).not.toContain(providerBody);
    expect(JSON.stringify(result.body)).not.toContain("upstream returned 500 with body");
    expect(JSON.stringify(diagnostics)).not.toContain(providerBody);
    expect(JSON.stringify(diagnostics)).not.toContain("upstream returned 500 with body");
    deps.store.close();
  });

  it("explains local provider reachability failures without exposing credentials", async () => {
    const uiDir = await tempDir("keiko-gw-ui-network-failure-");
    const evidenceDir = await tempDir("keiko-gw-ev-network-failure-");
    const networkError = Object.assign(new AggregateError([]), { code: "EACCES" });
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(networkError),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).toContain("local setup service could not reach");
    expect(JSON.stringify(result.body)).toContain("internet access");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("https://llm-gateway.example.com");
    deps.store.close();
  });

  it("classifies nested provider status failures without reflecting upstream details", async () => {
    const uiDir = await tempDir("keiko-gw-ui-classified-failure-");
    const evidenceDir = await tempDir("keiko-gw-ev-classified-failure-");
    const upstreamDetails = "private upstream details";
    const discoveryError = Object.assign(new AggregateError([]), {
      errors: [Object.assign(new Error(`upstream said: ${upstreamDetails}`), { httpStatus: 429 })],
    });
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(discoveryError),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).toContain("provider rate-limited setup verification");
    expect(JSON.stringify(result.body)).not.toContain(upstreamDetails);
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    deps.store.close();
  });

  it("classifies provider auth and model smoke-test failures", async () => {
    const uiDir = await tempDir("keiko-gw-ui-auth-model-failure-");
    const evidenceDir = await tempDir("keiko-gw-ev-auth-model-failure-");
    let attempt = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.reject(Object.assign(new Error("provider body hidden"), { status: 401 }));
        }
        return Promise.reject(Object.assign(new Error("provider body hidden"), { status: 404 }));
      },
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).toContain("provider rejected the credential");
    expect(JSON.stringify(result.body)).toContain(
      "no discovered model accepted the chat smoke test",
    );
    expect(JSON.stringify(result.body)).not.toContain("provider body hidden");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    deps.store.close();
  });

  it.each([
    {
      name: "authentication",
      code: ERROR_CODES.AUTHENTICATION,
      expected: "provider rejected the credential",
    },
    {
      name: "rate limit",
      code: ERROR_CODES.RATE_LIMIT,
      expected: "provider rate-limited setup verification",
    },
    {
      name: "unknown model",
      code: ERROR_CODES.UNKNOWN_MODEL,
      expected: "no discovered model accepted the chat smoke test",
    },
    {
      name: "proxy egress",
      code: ERROR_CODES.PROXY_EGRESS_FAILED,
      expected: "local setup service could not reach",
    },
  ])("classifies nested provider $name codes without reflecting upstream details", async (item) => {
    const uiDir = await tempDir(`keiko-gw-ui-code-${item.name.replace(/\W/gu, "-")}-`);
    const evidenceDir = await tempDir(`keiko-gw-ev-code-${item.name.replace(/\W/gu, "-")}-`);
    const upstreamDetails = `private provider details for ${item.name}`;
    const discoveryError = Object.assign(new Error("outer provider setup failure"), {
      cause: Object.assign(new Error(`upstream said: ${upstreamDetails}`), {
        code: item.code,
      }),
    });
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(discoveryError),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).toContain(item.expected);
    expect(JSON.stringify(result.body)).not.toContain(upstreamDetails);
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("https://llm-gateway.example.com");
    deps.store.close();
  });

  it("falls back for malformed provider errors without traversing hostile properties", async () => {
    const uiDir = await tempDir("keiko-gw-ui-generic-hostile-failure-");
    const evidenceDir = await tempDir("keiko-gw-ev-generic-hostile-failure-");
    const providerDetails = "private primitive provider details";
    const hostileError = new Error("hostile provider wrapper") as Error & Record<string, unknown>;
    Object.defineProperties(hostileError, {
      code: {
        get: () => {
          throw new Error("secret code getter");
        },
      },
      httpStatus: {
        get: () => {
          throw new Error("secret http status getter");
        },
      },
      status: {
        get: () => {
          throw new Error("secret status getter");
        },
      },
      cause: { get: () => hostileError },
      errors: { get: () => [null, "ignored nested value", hostileError] },
    });
    let attempt = 0;
    const genericError = new Error(providerDetails);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => {
        attempt += 1;
        return Promise.reject(attempt === 1 ? genericError : hostileError);
      },
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
      deps,
    );

    const body = JSON.stringify(result.body);
    expect(result.status).toBe(502);
    expect(body).toContain(
      "Provider verification failed without exposing upstream response details",
    );
    expect(body).not.toContain(providerDetails);
    expect(body).not.toContain("secret code getter");
    expect(body).not.toContain("secret http status getter");
    expect(body).not.toContain("secret status getter");
    expect(body).not.toContain("example-secret-token");
    expect(body).not.toContain("https://llm-gateway.example.com");
    deps.store.close();
  });

  it("rejects malformed gateway endpoint URLs before discovery", async () => {
    const uiDir = await tempDir("keiko-gw-ui-bad-url-");
    const evidenceDir = await tempDir("keiko-gw-ev-bad-url-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(new Error("discovery should not run")),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1?api-version=latest",
        apiKey: "example-secret-token",
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("query string or fragment");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("requires deployment names for Azure AI Foundry endpoints", async () => {
    const uiDir = await tempDir("keiko-gw-ui-azure-required-");
    const evidenceDir = await tempDir("keiko-gw-ev-azure-required-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(new Error("discovery should not run")),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://workspace.example.services.ai.azure.com/openai/v1",
        apiKey: "example-secret-token",
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("GATEWAY_DEPLOYMENTS_REQUIRED");
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("preserves Azure embedding deployments for Knowledge Connector", async () => {
    const uiDir = await tempDir("keiko-gw-ui-azure-deployments-");
    const evidenceDir = await tempDir("keiko-gw-ev-azure-deployments-");
    const originalFetch = globalThis.fetch;
    const seenModels: string[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      expect(fetchInputUrl(url)).not.toContain("/models");
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected JSON string request body");
      }
      const body = JSON.parse(init?.body ?? "{}") as { model?: string };
      if (body.model !== undefined) {
        seenModels.push(body.model);
      }
      if (body.model === "text-embedding-3-large") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "not a chat deployment" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    globalThis.fetch = fakeFetch;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...MOCK_FETCH_EGRESS_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://workspace.example.services.ai.azure.com/openai/v1",
          apiKey: "example-secret-token",
          deploymentNames: ["phi-4", "text-embedding-3-large", "gpt-oss-120b"],
        }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenModels).toEqual(["phi-4", "gpt-oss-120b", "phi-4", "gpt-oss-120b"]);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "phi-4",
        "gpt-oss-120b",
      ]);
      const config = currentGatewayConfig(deps);
      expect(config?.providers.map((provider) => provider.modelId)).toEqual([
        "phi-4",
        "gpt-oss-120b",
        "text-embedding-3-large",
      ]);
      expect(selectEmbeddingModelId(config)).toBe("text-embedding-3-large");
      const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
      expect(saved).toContain("text-embedding-3-large");
      expect(saved).toContain('"kind": "embedding"');
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("normalizes Foundry project URLs and stores only Keiko-compatible chat deployments", async () => {
    const uiDir = await tempDir("keiko-gw-ui-azure-project-url-");
    const evidenceDir = await tempDir("keiko-gw-ev-azure-project-url-");
    const originalFetch = globalThis.fetch;
    const seen: {
      readonly url: string;
      readonly model: string | undefined;
      readonly firstRole: string | undefined;
    }[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      const href = fetchInputUrl(url);
      expect(href).not.toContain("api/projects/proj-oscharko-dev");
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected JSON string request body");
      }
      const body = JSON.parse(init?.body ?? "{}") as {
        readonly model?: string;
        readonly messages?: readonly { readonly role?: string }[];
      };
      seen.push({ url: href, model: body.model, firstRole: body.messages?.[0]?.role });
      if (body.model === "Mistral-Large-3" || body.model === "text-embedding-3-large") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: "not Keiko conversation compatible" } }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 32, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    globalThis.fetch = fakeFetch;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...MOCK_FETCH_EGRESS_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://workspace.example.services.ai.azure.com/api/projects/proj-oscharko-dev",
          apiKey: "example-secret-token",
          deploymentNames: ["Mistral-Large-3", "gpt-5.4", "text-embedding-3-large"],
          imageInputModelIds: ["gpt-5.4"],
        }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seen.map((call) => call.model)).toEqual(["Mistral-Large-3", "gpt-5.4", "gpt-5.4"]);
      expect(seen.every((call) => call.firstRole === "system")).toBe(true);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "gpt-5.4",
      ]);
      expect((result.body as { skippedModelIds?: readonly string[] }).skippedModelIds).toEqual([
        "Mistral-Large-3",
      ]);
      const config = currentGatewayConfig(deps);
      expect(config?.providers.map((provider) => provider.modelId)).toEqual([
        "gpt-5.4",
        "text-embedding-3-large",
      ]);
      expect(config?.providers.every((provider) => provider.baseUrl.endsWith("/openai/v1"))).toBe(
        true,
      );
      const gptCapability = config?.capabilities?.find((capability) => capability.id === "gpt-5.4");
      expect(gptCapability?.kind).toBe("chat");
      expect(gptCapability?.supportsImageInput).toBe(true);
      expect(selectEmbeddingModelId(config)).toBe("text-embedding-3-large");
      const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
      expect(saved).not.toContain("Mistral-Large-3");
      expect(saved).toContain("gpt-5.4");
      expect(saved).toContain("text-embedding-3-large");
      expect(saved).toContain('"kind": "embedding"');
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("stores Mistral chat deployments without claiming tool-calling support by default", async () => {
    const uiDir = await tempDir("keiko-gw-ui-mistral-capability-");
    const evidenceDir = await tempDir("keiko-gw-ev-mistral-capability-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://workspace.example.services.ai.azure.com/openai/v1",
        apiKey: "example-secret-token",
        deploymentNames: ["Mistral-Large-3"],
      }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = currentGatewayConfig(deps);
    const capability = config?.capabilities?.find(
      (candidate) => candidate.id === "Mistral-Large-3",
    );
    expect(capability).toMatchObject({
      id: "Mistral-Large-3",
      kind: "chat",
      toolCalling: false,
      structuredOutput: false,
      streaming: true,
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    gatewayConfig.recordVerifiedCapability(
      "Mistral-Large-3",
      { toolCalling: true },
      "2026-08-02T08:00:00.000Z",
      gatewayConfig.generation(),
    );
    expect(
      (
        await handleApplyGatewayVerifiedCapabilities(
          {
            ...ctx({ fields: { toolCalling: true } }),
            params: { modelId: "Mistral-Large-3" },
          },
          deps,
        )
      ).status,
    ).toBe(200);
    expect(
      requiredCapability(requiredGatewayConfig(deps), "Mistral-Large-3").knownLimitations,
    ).not.toContain(
      "Tool calling is disabled by default for Mistral deployments until endpoint readiness verifies it",
    );

    const updated = await handleGatewaySetup(
      ctx({
        baseUrl: "https://workspace.example.services.ai.azure.com/openai/v1",
        apiKey: "example-secret-token",
        deploymentNames: ["Mistral-Large-3"],
      }),
      deps,
    );

    expect(updated.status).toBe(200);
    const preserved = requiredCapability(requiredGatewayConfig(deps), "Mistral-Large-3");
    expect(preserved.toolCalling).toBe(true);
    expect(preserved.knownLimitations).not.toContain(
      "Tool calling is disabled by default for Mistral deployments until endpoint readiness verifies it",
    );
    deps.store.close();
  });

  it("lets the operator explicitly mark one discovered chat model as coding-safe", async () => {
    const uiDir = await tempDir("keiko-gw-ui-coding-safe-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-coding-safe-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });

    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1",
        apiKey: "example-secret-token",
        deploymentNames: ["coding-chat"],
        workflowEligibleModelIds: ["coding-chat"],
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(resolveCodingSafeSidecarGatewayProfile(currentGatewayConfig(deps))).toMatchObject({
      status: "available",
    });
    expect(
      currentGatewayConfig(deps)?.capabilities?.find(
        (capability) => capability.id === "coding-chat",
      ),
    ).toMatchObject({ workflowEligible: true, preferredUseCases: ["Chat", "Coding"] });
    deps.store.close();
  });

  it("preserves coding-safe enrichment across a verified credential rotation", async () => {
    const uiDir = await tempDir("keiko-gw-ui-coding-rotation-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-coding-rotation-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "first-secret-token",
            deploymentNames: ["coding-chat"],
            workflowEligibleModelIds: ["coding-chat"],
          }),
          deps,
        )
      ).status,
    ).toBe(200);

    const rotated = await handleGatewaySetup(
      ctx({
        preserveExisting: true,
        apiKey: "rotated-secret-token",
        deploymentNames: ["coding-chat"],
      }),
      deps,
    );

    expect(rotated.status).toBe(200);
    expect(
      currentGatewayConfig(deps)?.capabilities?.find(
        (capability) => capability.id === "coding-chat",
      ),
    ).toMatchObject({ workflowEligible: true, preferredUseCases: ["Chat", "Coding"] });
    deps.store.close();
  });

  it("clears coding-safe enrichment when an explicit empty workflow list is submitted", async () => {
    const uiDir = await tempDir("keiko-gw-ui-coding-revoke-");
    let verificationCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-coding-revoke-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        verificationCalls += 1;
        if (verificationCalls > 1) {
          return Promise.reject(new Error("gateway is temporarily unavailable"));
        }
        return Promise.resolve(modelIds);
      },
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "first-secret-token",
            deploymentNames: ["coding-chat"],
            workflowEligibleModelIds: ["coding-chat"],
          }),
          deps,
        )
      ).status,
    ).toBe(200);

    const revoked = await handleGatewaySetup(
      ctx({ preserveExisting: true, workflowEligibleModelIds: [] }),
      deps,
    );

    expect(revoked.status).toBe(200);
    expect(
      currentGatewayConfig(deps)?.capabilities?.find(
        (capability) => capability.id === "coding-chat",
      ),
    ).toMatchObject({
      workflowEligible: false,
      preferredUseCases: ["Chat", "Coding"],
    });
    expect(resolveCodingSafeSidecarGatewayProfile(currentGatewayConfig(deps))).toMatchObject({
      status: "unavailable",
    });
    expect(verificationCalls).toBe(1);
    deps.store.close();
  });

  it("updates a non-empty workflow list without rerunning provider verification", async () => {
    const uiDir = await tempDir("keiko-gw-ui-coding-update-");
    let verificationCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-coding-update-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        verificationCalls += 1;
        if (verificationCalls > 1) {
          return Promise.reject(new Error("gateway is temporarily unavailable"));
        }
        return Promise.resolve(modelIds);
      },
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "first-secret-token",
            deploymentNames: ["coding-chat", "general-chat"],
            workflowEligibleModelIds: ["coding-chat"],
          }),
          deps,
        )
      ).status,
    ).toBe(200);

    const updated = await handleGatewaySetup(
      ctx({ preserveExisting: true, workflowEligibleModelIds: ["general-chat"] }),
      deps,
    );

    expect(updated.status).toBe(200);
    expect(verificationCalls).toBe(1);
    expect(
      currentGatewayConfig(deps)?.capabilities?.filter((capability) => capability.workflowEligible),
    ).toMatchObject([{ id: "general-chat" }]);
    deps.store.close();
  });

  it("rejects an unknown workflow-eligible model without changing the stored selection", async () => {
    const uiDir = await tempDir("keiko-gw-ui-coding-unknown-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-coding-unknown-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    expect(
      (
        await handleGatewaySetup(
          ctx({
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "first-secret-token",
            deploymentNames: ["coding-chat", "general-chat"],
            workflowEligibleModelIds: ["coding-chat"],
          }),
          deps,
        )
      ).status,
    ).toBe(200);

    const rejected = await handleGatewaySetup(
      ctx({ preserveExisting: true, workflowEligibleModelIds: ["coding-cht"] }),
      deps,
    );

    expect(rejected).toMatchObject({
      status: 400,
      body: { error: { code: "BAD_REQUEST" } },
    });
    expect(
      currentGatewayConfig(deps)?.capabilities?.filter((capability) => capability.workflowEligible),
    ).toMatchObject([{ id: "coding-chat" }]);
    deps.store.close();
  });

  it("preserves stored egress when only workflow eligibility changes", async () => {
    const uiDir = await tempDir("keiko-gw-ui-workflow-egress-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-workflow-egress-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
    });
    await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1",
        apiKey: "first-secret-token",
        deploymentNames: ["coding-chat"],
        workflowEligibleModelIds: ["coding-chat"],
      }),
      deps,
    );
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    const persisted = JSON.parse(readFileSync(gatewayConfig.storagePath, "utf8")) as Record<
      string,
      unknown
    >;
    const egress = {
      httpsProxy: "http://proxy.internal.example:8443",
      caBundlePath: "/etc/keiko/private-ca.pem",
      allowPrivateNetwork: false,
      denyLoopback: true,
    };
    writeFileSync(gatewayConfig.storagePath, JSON.stringify({ ...persisted, egress }), "utf8");
    gatewayConfig.set(
      parseGatewayConfig({
        ...rawConfigFromCurrent(requiredGatewayConfig(deps), undefined),
        egress,
      }),
      true,
    );

    const updated = await handleGatewaySetup(
      ctx({ preserveExisting: true, workflowEligibleModelIds: [] }),
      deps,
    );

    expect(updated.status).toBe(200);
    expect(JSON.parse(readFileSync(gatewayConfig.storagePath, "utf8"))).toMatchObject({ egress });
    deps.store.close();
  });

  it("materializes implicit legacy capabilities when workflow eligibility is updated", async () => {
    const uiDir = await tempDir("keiko-gw-ui-coding-legacy-");
    let verificationCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: await tempDir("keiko-gw-ev-coding-legacy-"),
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: (_config, modelIds) => {
        verificationCalls += 1;
        return Promise.resolve(modelIds);
      },
    });
    const gatewayConfig = deps.gatewayConfig;
    if (gatewayConfig === undefined) throw new Error("expected runtime gateway config");
    gatewayConfig.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "legacy-chat",
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "legacy-token",
          },
        ],
      }),
      true,
    );
    expect(requiredGatewayConfig(deps).capabilities).toBeUndefined();

    const updated = await handleGatewaySetup(
      ctx({ preserveExisting: true, workflowEligibleModelIds: ["legacy-chat"] }),
      deps,
    );

    expect(updated.status).toBe(200);
    expect(requiredCapability(requiredGatewayConfig(deps), "legacy-chat")).toMatchObject({
      workflowEligible: true,
    });
    expect(verificationCalls).toBe(0);
    deps.store.close();
  });

  it("uses LiteLLM model info to persist embeddings while smoke-testing only chat models", async () => {
    const uiDir = await tempDir("keiko-gw-ui-litellm-");
    const evidenceDir = await tempDir("keiko-gw-ev-litellm-");
    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    const seenModels: string[] = [];
    const seenAuthHeaders: { auth: string | null; custom: string | null }[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      const href = fetchInputUrl(url);
      seenUrls.push(href);
      const headers = new Headers(init?.headers);
      seenAuthHeaders.push({
        auth: headers.get("authorization"),
        custom: headers.get("x-litellm-key"),
      });
      if (href.endsWith("/model/info")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  model_name: "litellm-chat-large",
                  model_info: {
                    mode: "chat",
                    max_input_tokens: 1_050_000,
                    max_output_tokens: 128_000,
                    supports_function_calling: false,
                  },
                },
                {
                  model_name: "litellm-vision-chat",
                  model_info: { mode: "chat", supports_vision: true },
                },
                { model_name: "litellm-embedding", model_info: { mode: "embedding" } },
                { model_name: "litellm-image", model_info: { mode: "image_generation" } },
                { model_name: "litellm-unknown-mode" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      expect(href).toContain("/chat/completions");
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected JSON string request body");
      }
      const body = JSON.parse(init?.body ?? "{}") as { model?: string };
      if (body.model !== undefined) {
        seenModels.push(body.model);
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    globalThis.fetch = fakeFetch;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...MOCK_FETCH_EGRESS_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const apiKey = ["example-secret-token"].join("");
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://llm-gateway.example.com/v1",
          apiKey,
          apiKeyHeaderName: "X-Litellm-Key",
        }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenUrls).toContain("https://llm-gateway.example.com/v1/model/info");
      expect(seenUrls).not.toContain("https://llm-gateway.example.com/model/info");
      expect(seenUrls.some((url) => url.endsWith("/models"))).toBe(false);
      expect(seenModels).toEqual([
        "litellm-chat-large",
        "litellm-vision-chat",
        "litellm-unknown-mode",
        "litellm-chat-large",
        "litellm-vision-chat",
        "litellm-unknown-mode",
      ]);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "litellm-chat-large",
        "litellm-vision-chat",
        "litellm-unknown-mode",
      ]);
      expect(
        seenAuthHeaders.every(
          (headers) => headers.auth === null && headers.custom === `Bearer ${apiKey}`,
        ),
      ).toBe(true);
      expect(
        currentGatewayConfig(deps)?.providers.map((provider) => provider.apiKeyHeaderName),
      ).toEqual(["x-litellm-key", "x-litellm-key", "x-litellm-key", "x-litellm-key"]);
      const config = currentGatewayConfig(deps);
      expect(config?.providers.map((provider) => provider.modelId)).toEqual([
        "litellm-chat-large",
        "litellm-vision-chat",
        "litellm-unknown-mode",
        "litellm-embedding",
      ]);
      expect(
        config?.capabilities?.find((capability) => capability.id === "litellm-vision-chat")
          ?.supportsImageInput,
      ).toBe(true);
      expect(
        config?.capabilities?.find((capability) => capability.id === "litellm-chat-large"),
      ).toMatchObject({
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        toolCalling: false,
      });
      expect(selectEmbeddingModelId(config)).toBe("litellm-embedding");
      const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
      expect(saved).toContain('"apiKeyHeaderName": "x-litellm-key"');
      expect(saved).toContain("litellm-embedding");
      expect(saved).toContain('"kind": "embedding"');
      expect(saved).not.toContain("litellm-image");
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("falls back to OpenAI-compatible model discovery when LiteLLM model info is unavailable", async () => {
    const uiDir = await tempDir("keiko-gw-ui-litellm-fallback-");
    const evidenceDir = await tempDir("keiko-gw-ev-litellm-fallback-");
    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    const seenAuthHeaders: { auth: string | null; custom: string | null }[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      const href = fetchInputUrl(url);
      seenUrls.push(href);
      const headers = new Headers(init?.headers);
      seenAuthHeaders.push({
        auth: headers.get("authorization"),
        custom: headers.get("x-litellm-key"),
      });
      if (href.endsWith("/model/info")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (href.endsWith("/models")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: "openai-compatible-chat" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    globalThis.fetch = fakeFetch;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...MOCK_FETCH_EGRESS_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const apiKey = ["example-secret-token"].join("");
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://llm-gateway.example.com/v1",
          apiKey,
          apiKeyHeaderName: "X-Litellm-Key",
        }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenUrls).toContain("https://llm-gateway.example.com/v1/model/info");
      expect(seenUrls).toContain("https://llm-gateway.example.com/v1/models");
      expect(
        seenAuthHeaders.every(
          (headers) => headers.auth === null && headers.custom === `Bearer ${apiKey}`,
        ),
      ).toBe(true);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "openai-compatible-chat",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("rejects unsafe setup model ids before storage or provider calls", async () => {
    const uiDir = await tempDir("keiko-gw-ui-invalid-ids-");
    const evidenceDir = await tempDir("keiko-gw-ev-invalid-ids-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1",
        apiKey: "example-secret-token",
        deploymentNames: ["valid-model", `bad-${"x".repeat(200)}`],
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("invalid model id");
    expect(JSON.stringify(result.body)).not.toContain("bad-");
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("rejects unsupported API key headers before discovery or storage", async () => {
    const uiDir = await tempDir("keiko-gw-ui-invalid-header-");
    const evidenceDir = await tempDir("keiko-gw-ev-invalid-header-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(new Error("discovery should not run")),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1",
        apiKey: "example-secret-token",
        apiKeyHeaderName: "X-Forwarded-Host",
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("apiKeyHeaderName");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("rejects non-loopback HTTP setup URLs before discovery or storage", async () => {
    const uiDir = await tempDir("keiko-gw-ui-http-url-");
    const evidenceDir = await tempDir("keiko-gw-ev-http-url-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => Promise.reject(new Error("discovery should not run")),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "http://llm-gateway.example.com/v1",
        apiKey: "example-secret-token",
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("must use https");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("rejects link-local metadata gateway URLs before discovery or storage", async () => {
    const uiDir = await tempDir("keiko-gw-ui-metadata-url-");
    const evidenceDir = await tempDir("keiko-gw-ev-metadata-url-");
    let discoveryCalls = 0;
    let testerCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => {
        discoveryCalls += 1;
        return Promise.resolve(["example-chat-model"]);
      },
      gatewaySetupTester: (_config, modelIds) => {
        testerCalls += 1;
        return Promise.resolve(modelIds);
      },
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://169.254.169.254/v1",
        apiKey: "example-secret-token",
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("link-local metadata");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(discoveryCalls).toBe(0);
    expect(testerCalls).toBe(0);
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("allows link-local gateway URLs only with the explicit metadata override", async () => {
    const uiDir = await tempDir("keiko-gw-ui-metadata-override-");
    const evidenceDir = await tempDir("keiko-gw-ev-metadata-override-");
    let discoveryCalls = 0;
    let testerCalls = 0;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {
        ...MOCK_FETCH_EGRESS_ENV,
        KEIKO_ALLOW_LINK_LOCAL_GATEWAY: "1",
      },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewayModelDiscovery: () => {
        discoveryCalls += 1;
        return Promise.resolve(["example-chat-model"]);
      },
      gatewaySetupTester: (_config, modelIds) => {
        testerCalls += 1;
        return Promise.resolve(modelIds);
      },
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://169.254.169.254/v1",
        apiKey: "example-secret-token",
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(discoveryCalls).toBe(1);
    expect(testerCalls).toBe(1);
    expect(currentGatewayConfig(deps)?.providers[0]?.baseUrl).toBe("https://169.254.169.254/v1");
    deps.store.close();
  });

  it("rejects excessive deployment-name lists before provider calls", async () => {
    const uiDir = await tempDir("keiko-gw-ui-too-many-");
    const evidenceDir = await tempDir("keiko-gw-ev-too-many-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
      gatewaySetupTester: () => Promise.reject(new Error("tester should not run")),
    });
    const result = await handleGatewaySetup(
      ctx({
        baseUrl: "https://llm-gateway.example.com/v1",
        apiKey: "example-secret-token",
        deploymentNames: Array.from({ length: 101 }, (_unused, index) => `model-${String(index)}`),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("model setup limit");
    expect(deps.gatewayConfig?.present()).toBe(false);
    deps.store.close();
  });

  it("production setup discovers models and stores chat plus embedding-capable models", async () => {
    const uiDir = await tempDir("keiko-gw-ui-all-");
    const evidenceDir = await tempDir("keiko-gw-ev-all-");
    const originalFetch = globalThis.fetch;
    const seenModels: string[] = [];
    const fakeFetch: typeof fetch = (url, init) => {
      if (fetchInputUrl(url).endsWith("/models")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "example-image-model",
                  capabilities: { chat_completion: false },
                },
                { id: "example-chat-model-large" },
                { id: "example-chat-model-fast" },
                { id: "example-embedding-model" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected JSON string request body");
      }
      const body = JSON.parse(init?.body ?? "{}") as { model?: string };
      if (body.model !== undefined) {
        seenModels.push(body.model);
      }
      if (body.model === "example-embedding-model") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "not a chat model" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    globalThis.fetch = fakeFetch;
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { ...MOCK_FETCH_EGRESS_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenModels).toEqual([
        "example-chat-model-large",
        "example-chat-model-fast",
        "example-chat-model-large",
        "example-chat-model-fast",
      ]);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "example-chat-model-large",
        "example-chat-model-fast",
      ]);
      expect(currentGatewayConfig(deps)?.providers.map((provider) => provider.modelId)).toEqual([
        "example-chat-model-large",
        "example-chat-model-fast",
        "example-embedding-model",
      ]);
      expect(selectEmbeddingModelId(currentGatewayConfig(deps))).toBe("example-embedding-model");
      expect(deps.gatewayConfig?.present()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });
});

// Issue #144: discovery-normalization seam tests. Synthetic generic IDs only —
// no customer model names. These pin AC #4 ("Discovery handles additional
// customer gateway models without requiring code changes for each model name")
// by exercising the wrapper with every documented payload shape.
describe("normalizeDiscoveryPayload", () => {
  it("does not reinterpret an output max_tokens field as an input context window", () => {
    const normalized = normalizeDiscoveryPayloadForSetup({
      data: [{ id: "test-chat-1", model_info: { max_tokens: 4_096 } }],
    });

    expect(normalized.modelMetadata?.["test-chat-1"]?.contextWindow).toBeUndefined();
    expect(normalized.modelMetadata?.["test-chat-1"]?.maxOutputTokens).toBe(4_096);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid discovered token limits (%s)",
    (maxInputTokens) => {
      const normalized = normalizeDiscoveryPayloadForSetup({
        data: [{ id: "test-chat-1", model_info: { max_input_tokens: maxInputTokens } }],
      });

      expect(normalized.modelMetadata?.["test-chat-1"]?.contextWindow).toBeUndefined();
    },
  );

  it("uses the canonical embedding model-id families", () => {
    const embeddingModelIds = [
      "bge-large-en-v1.5",
      "intfloat/e5-large-v2",
      "thenlper/gte-large",
      "hkunlp/instructor-xl",
    ];
    expect(
      normalizeDiscoveryPayloadForSetup({
        data: embeddingModelIds.map((id) => ({ id })),
      }).embeddingModelIds,
    ).toEqual(embeddingModelIds);
  });

  it("returns OpenAI-compatible ids in original order", () => {
    const payload = { data: [{ id: "test-chat-1" }, { id: "test-chat-2" }] };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["test-chat-1", "test-chat-2"]);
  });

  it("keeps LiteLLM model_info.mode === 'embedding' for Local Knowledge", () => {
    const payload = {
      data: [
        { model_name: "x", model_info: { mode: "chat" } },
        { model_name: "y", model_info: { mode: "embedding" } },
      ],
    };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["x", "y"]);
    expect(normalizeDiscoveryPayloadForSetup(payload)).toMatchObject({
      chatModelIds: ["x"],
      embeddingModelIds: ["y"],
    });
  });

  it("detects LiteLLM image-input chat models from metadata without keeping image generators", () => {
    const payload = {
      data: [
        { model_name: "plain-chat", model_info: { mode: "chat" } },
        {
          model_name: "vision-chat",
          model_info: { mode: "chat", input_modalities: ["text", "image"] },
        },
        { model_name: "generated-image", model_info: { mode: "image_generation" } },
      ],
    };

    expect(normalizeDiscoveryPayloadForSetup(payload)).toMatchObject({
      chatModelIds: ["plain-chat", "vision-chat"],
      embeddingModelIds: [],
      imageInputModelIds: ["vision-chat"],
    });
  });

  it("infers image-input support from every supported model-id family", () => {
    const imageInputModelIds = [
      "vision-chat",
      "multimodal-chat",
      "multi-modal-chat",
      "llava-13b",
      "pixtral-large",
      "omni-chat",
      "gpt-4o",
      "vendor-vl",
      "qwen-vl",
      "qwen2-vl",
      "qwen2.5-vl",
      "qwen3-vl",
    ];
    const payload = {
      data: [
        ...imageInputModelIds.map((model_name) => ({ model_name, model_info: { mode: "chat" } })),
        { model_name: "evolution-chat", model_info: { mode: "chat" } },
      ],
    };

    expect(normalizeDiscoveryPayloadForSetup(payload).imageInputModelIds).toEqual(
      imageInputModelIds,
    );
  });

  it("keeps LiteLLM embedding params but drops unsupported non-chat modes", () => {
    const payload = {
      data: [
        { model_name: "chat-via-params", litellm_params: { mode: "chat" } },
        { model_name: "embedding-via-params", litellm_params: { mode: "embedding" } },
        { model_name: "audio-via-params", litellm_params: { mode: "audio_transcription" } },
      ],
    };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["chat-via-params", "embedding-via-params"]);
    expect(normalizeDiscoveryPayloadForSetup(payload)).toMatchObject({
      chatModelIds: ["chat-via-params"],
      embeddingModelIds: ["embedding-via-params"],
    });
  });

  it("drops entries with capabilities.chat_completion === false", () => {
    const payload = {
      data: [
        { id: "test-chat-1" },
        { id: "test-image-1", capabilities: { chat_completion: false } },
      ],
    };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["test-chat-1"]);
  });

  it("deduplicates repeated ids", () => {
    const payload = {
      data: [{ id: "test-chat-1" }, { id: "test-chat-1" }, { id: "test-chat-2" }],
    };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["test-chat-1", "test-chat-2"]);
  });

  it("drops entries with no recognised id field, keeping healthy peers", () => {
    const payload = {
      data: [{ id: "test-chat-1" }, { unrecognised: "no-id-here" }, { id: "test-chat-2" }],
    };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["test-chat-1", "test-chat-2"]);
  });

  it("drops ids containing disallowed control characters", () => {
    const payload = {
      data: [{ id: "test-chat-1" }, { id: "bad\nmodel" }, { id: "test-chat-2" }],
    };
    expect(normalizeDiscoveryPayload(payload)).toEqual(["test-chat-1", "test-chat-2"]);
  });

  it("throws when data is not an array (schema-level malformation)", () => {
    expect(() => normalizeDiscoveryPayload({ data: "not-an-array" })).toThrow(
      "model discovery response must contain a data array",
    );
  });

  it("throws when every entry is dropped (no usable models)", () => {
    const payload = { data: [{ unrecognised: "x" }, { capabilities: { chat_completion: false } }] };
    expect(() => normalizeDiscoveryPayload(payload)).toThrow(
      "model discovery returned no model ids",
    );
  });

  it("truncates to MAX_DISCOVERED_MODELS when the payload is oversized", () => {
    const payload = {
      data: Array.from({ length: MAX_DISCOVERED_MODELS + 5 }, (_unused, index) => ({
        id: `m-${String(index)}`,
      })),
    };
    expect(normalizeDiscoveryPayload(payload)).toHaveLength(MAX_DISCOVERED_MODELS);
  });
});

// Issue #144: cover the lower-level helpers directly so a future split into
// `discovery-normalization.ts` keeps the same observable surface.
describe("modelIdFromDiscoveryItem", () => {
  it("returns the id for a healthy OpenAI-compatible record", () => {
    expect(modelIdFromDiscoveryItem({ id: "test-chat-1" })).toBe("test-chat-1");
  });

  it("returns the id for an explicitly embedding record", () => {
    expect(
      modelIdFromDiscoveryItem({ id: "test-embed-1", model_info: { mode: "embedding" } }),
    ).toBe("test-embed-1");
  });

  it("returns undefined for non-record input", () => {
    expect(modelIdFromDiscoveryItem("not-an-object")).toBeUndefined();
    expect(modelIdFromDiscoveryItem(null)).toBeUndefined();
  });

  it("accepts a model id containing a supplementary-plane character (not a control character)", () => {
    // "😀" (U+1F600) is a 2-UTF-16-code-unit surrogate pair; the disallowed-character scan must
    // keep treating it as ordinary text (codes <= 31 or === 127), not reject it as unusable.
    expect(modelIdFromDiscoveryItem({ id: "gpt-😀-mini" })).toBe("gpt-😀-mini");
  });
});

describe("isExplicitlyNonChatModel", () => {
  it("returns true when capabilities.chat_completion is explicitly false", () => {
    expect(isExplicitlyNonChatModel({ capabilities: { chat_completion: false } })).toBe(true);
  });

  it("returns true for a non-chat-compatible mode", () => {
    expect(isExplicitlyNonChatModel({ mode: "embedding" })).toBe(true);
  });

  it("returns true for an unrecognised mode (only chat-compatible modes survive)", () => {
    // CHAT_COMPATIBLE_MODES is a closed allow-list ("chat", "completion",
    // "responses"). Anything else explicitly disqualifies the record. The
    // LiteLLM fallback for entries with NO mode field is the absence path,
    // covered below.
    expect(isExplicitlyNonChatModel({ mode: "unrecognised-mode" })).toBe(true);
  });

  it("returns false when no chat-disqualifying signal is present", () => {
    expect(isExplicitlyNonChatModel({ id: "test-chat-1" })).toBe(false);
  });

  it("returns false when mode field is absent (entry is kept for smoke testing)", () => {
    // Matches the LiteLLM fixture in handleGatewaySetup tests: a record with
    // model_name and no model_info.mode is smoke-tested because we can't
    // disqualify it from the discovery payload alone.
    expect(isExplicitlyNonChatModel({ model_name: "test-chat-1" })).toBe(false);
  });
});

// Issue #144: smoke-test seam — pure helper extracted from
// `defaultGatewaySetupTester`. Concurrency, order preservation, and the
// terminal "all rejected" error are the three pieces of the observable
// contract that downstream code depends on.
describe("smokeTestCandidates", () => {
  it("returns every candidate when every probe resolves (original order)", async () => {
    const result = await smokeTestCandidates(
      ["test-chat-1", "test-chat-2", "test-chat-3"],
      () => Promise.resolve(),
      2,
    );
    expect(result).toEqual(["test-chat-1", "test-chat-2", "test-chat-3"]);
  });

  it("drops rejected probes and preserves order among survivors", async () => {
    const rejected = new Set(["test-chat-2"]);
    const result = await smokeTestCandidates(
      ["test-chat-1", "test-chat-2", "test-chat-3", "test-chat-4"],
      (modelId) => (rejected.has(modelId) ? Promise.reject(new Error("nope")) : Promise.resolve()),
      2,
    );
    expect(result).toEqual(["test-chat-1", "test-chat-3", "test-chat-4"]);
  });

  it("throws the documented error when every probe rejects", async () => {
    await expect(
      smokeTestCandidates(
        ["test-chat-1", "test-chat-2"],
        () => Promise.reject(new Error("nope")),
        2,
      ),
    ).rejects.toThrow("no discovered model accepted the chat-completions smoke test");
  });

  it("respects the concurrency cap (peak in-flight <= 2 with 5 candidates)", async () => {
    const tracker = { inflight: 0, peak: 0 };
    const probe = async (): Promise<void> => {
      tracker.inflight += 1;
      tracker.peak = Math.max(tracker.peak, tracker.inflight);
      // Yield once so concurrent workers have an opportunity to enter the
      // probe before we decrement. A microtask is enough — no timers needed.
      await Promise.resolve();
      tracker.inflight -= 1;
    };
    await smokeTestCandidates(
      ["test-chat-1", "test-chat-2", "test-chat-3", "test-chat-4", "test-chat-5"],
      probe,
      2,
    );
    expect(tracker.peak).toBeLessThanOrEqual(2);
    expect(tracker.peak).toBeGreaterThanOrEqual(1);
  });
});

// SonarCloud S8786: normalizeBaseUrl used to strip trailing slashes with `/\/+$/u`. That pattern is
// anchored at the end but not at the start, so a backtracking engine retries the match at every
// start position looking for a run of "/" that reaches the true end of the string — quadratic
// whenever the string never ends in "/" (or has such a run far from the end). stripTrailingSlashes
// replaces it with a single backward scan that cannot backtrack.
describe("stripTrailingSlashes", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com///", "https://example.com"],
    ["", ""],
    ["///", ""],
    ["no/trailing/slash/here", "no/trailing/slash/here"],
  ])("strips trailing slashes from %s -> %s", (input, expected) => {
    expect(stripTrailingSlashes(input)).toBe(expected);
  });

  // The adversarial shape for the OLD `/\/+$/u` regex is a long run of "/" that is blocked from
  // reaching the true end of the string by one trailing non-"/" character: a backtracking engine
  // tries every position within the run, and at each one exhausts every possible run length before
  // concluding "$" can never be reached from here. A run with NO "/" at all is fast even for the
  // old regex (the very first character check fails immediately at every position), so it would not
  // have caught a regression — this shape is the one that actually distinguishes old from new.
  it("completes within a tight budget for a long slash run blocked by a trailing character", () => {
    const adversarial = `${"/".repeat(100_000)}!`;
    const start = Date.now();
    const result = stripTrailingSlashes(adversarial);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(result).toBe(adversarial);
  });
});

// Issue #1557 (Epic #1556, ADR-0094 D2 / HAZARD-3): the preserve-existing save path round-trips a
// parsed config back to raw via `rawConfigFromCurrent`. A configured voice provider's persona mapping
// must survive that round-trip without tripping the strict capability parser on reload.
describe("rawConfigFromCurrent — voice persona persistence round-trip", () => {
  const voiceRaw = {
    providers: [
      {
        modelId: "keiko-tts",
        baseUrl: "https://voice.example/v1",
        apiKey: "voice-key",
        capability: {
          kind: "voice",
          supportsSpeechOutput: true,
          voiceProviderLocality: "customer-hosted",
        },
        voiceProfiles: [
          { persona: "male", voiceId: "voice-male-01" },
          { persona: "neutral", voiceId: "voice-neutral-01" },
        ],
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };

  it("preserves voiceProfiles and re-derives supportedVoicePersonas on reload", () => {
    const config = parseGatewayConfig(voiceRaw);
    expect(config.capabilities?.find((c) => c.id === "keiko-tts")?.supportedVoicePersonas).toEqual([
      "male",
      "neutral",
    ]);

    const persisted = rawConfigFromCurrent(config, undefined);
    const persistedJson = JSON.stringify(persisted);
    // The derived view is NEVER persisted (the strict parser rejects it as an input key); the
    // credential-tier mapping IS persisted so the personas survive.
    expect(persistedJson).not.toContain("supportedVoicePersonas");
    expect(persistedJson).toContain("voiceProfiles");

    // Reload must succeed (no strict-parser rejection) and reproduce the same effective config.
    const reloaded = parseGatewayConfig(persisted);
    expect(reloaded.providers.find((p) => p.modelId === "keiko-tts")?.voiceProfiles).toEqual([
      { persona: "male", voiceId: "voice-male-01" },
      { persona: "neutral", voiceId: "voice-neutral-01" },
    ]);
    expect(
      reloaded.capabilities?.find((c) => c.id === "keiko-tts")?.supportedVoicePersonas,
    ).toEqual(["male", "neutral"]);
  });

  it("preserves the provider-backed reranker on reload", () => {
    const config = parseGatewayConfig({
      ...voiceRaw,
      reranker: {
        modelId: "qwen3-reranker",
        baseUrl: "https://reranker.example.invalid/v1",
        apiKey: "reranker-fixture-key",
        apiKeyHeaderName: "x-litellm-key",
        timeoutMs: 12_000,
      },
    });

    const reloaded = parseGatewayConfig(rawConfigFromCurrent(config, undefined));

    expect(reloaded.reranker).toEqual(config.reranker);
  });

  it("preserves an explicit output-token parameter override on reload", () => {
    const config = parseGatewayConfig({
      ...voiceRaw,
      providers: [
        {
          ...voiceRaw.providers[0],
          outputTokenParameter: "max_completion_tokens",
        },
      ],
    });

    const reloaded = parseGatewayConfig(rawConfigFromCurrent(config, undefined));

    expect(reloaded.providers[0]?.outputTokenParameter).toBe("max_completion_tokens");
  });
});
