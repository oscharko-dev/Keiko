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
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { FigmaConnectorError } from "./qualityIntelligence/figma/figmaConnectorErrors.js";
import { currentGatewayConfig } from "./deps.js";
import { buildUiHandlerDeps } from "./deps.js";
import {
  handleGatewaySetup,
  MAX_DISCOVERED_MODELS,
  isExplicitlyNonChatModel,
  modelIdFromDiscoveryItem,
  normalizeDiscoveryPayload,
  normalizeDiscoveryPayloadForSetup,
  smokeTestCandidates,
} from "./gateway-setup.js";
import { selectEmbeddingModelId } from "./local-knowledge-handlers.js";
import type { RouteContext } from "./routes.js";

const tmpDirs: string[] = [];

// Issue #1320: pin both local vaults (provider credentials + Figma PAT) to the explicit env-key tier
// so tests never touch the real macOS keychain — deterministic, side-effect-free, and identical on
// CI (Linux keyfile tier) and developer machines. The values are throwaway 32-byte base64 keys.
const VAULT_ENV: Readonly<Record<string, string>> = {
  KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
  KEIKO_FIGMA_KEY: Buffer.alloc(32, 0x42).toString("base64"),
};

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

function ctx(body: unknown): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/gateway/setup"),
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

describe("handleGatewaySetup", () => {
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
    expect(config?.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
      "keiko-stt",
    ]);
    const voiceProvider = config?.providers.find((provider) => provider.modelId === "keiko-stt");
    expect(voiceProvider?.apiKey).toBe("voice-secret-token");
    expect(voiceProvider?.apiKeyHeaderName).toBe("api-key");
    const voiceCapability = config?.capabilities?.find((capability) => capability.id === "keiko-stt");
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
      env: { ...VAULT_ENV },
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
      expect(seenModels).toEqual(["phi-4", "gpt-oss-120b"]);
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
      env: { ...VAULT_ENV },
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
      expect(seen.map((call) => call.model)).toEqual(["Mistral-Large-3", "gpt-5.4"]);
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
      structuredOutput: true,
      streaming: true,
    });
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
                { model_name: "litellm-chat-large", model_info: { mode: "chat" } },
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
      env: { ...VAULT_ENV },
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
      env: { ...VAULT_ENV },
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
      env: { ...VAULT_ENV },
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({ baseUrl: "https://llm-gateway.example.com", apiKey: "example-secret-token" }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenModels).toEqual(["example-chat-model-large", "example-chat-model-fast"]);
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
    expect(normalizeDiscoveryPayload(payload).length).toBe(MAX_DISCOVERED_MODELS);
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
