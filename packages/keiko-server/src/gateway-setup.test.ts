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
import { currentGatewayConfig } from "./deps.js";
import { buildUiHandlerDeps } from "./deps.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import type { RouteContext } from "./routes.js";

const tmpDirs: string[] = [];

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
      env: {},
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
    expect(saved).toContain("example-secret-token");
    expect(saved).toContain("example-chat-model-large");
    expect(saved).not.toContain("example-chat-model-fast");
    expect(saved).not.toContain("example-vision-model");
    expect(JSON.stringify(result.body)).not.toContain("example-secret-token");
    expect(JSON.stringify(result.body)).not.toContain("https://llm-gateway.example.com");
    if (process.platform !== "win32") {
      expect(statSync(savedPath ?? "").mode & 0o777).toBe(0o600);
      expect(statSync(savedPath ?? "").ino).not.toBe(initialStat.ino);
    }
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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

  it("uses supplied deployment names instead of Azure model catalog discovery", async () => {
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
      env: {},
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
      expect(seenModels).toEqual(["phi-4", "text-embedding-3-large", "gpt-oss-120b"]);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "phi-4",
        "gpt-oss-120b",
      ]);
      expect(currentGatewayConfig(deps)?.providers.map((provider) => provider.modelId)).toEqual([
        "phi-4",
        "gpt-oss-120b",
      ]);
      const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
      expect(saved).not.toContain("text-embedding-3-large");
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });

  it("uses LiteLLM model info to filter non-chat models before smoke testing", async () => {
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
      env: {},
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://llm-gateway.example.com/v1",
          apiKey: "example-secret-token",
          apiKeyHeaderName: "X-Litellm-Key",
        }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenUrls).toContain("https://llm-gateway.example.com/v1/model/info");
      expect(seenUrls).not.toContain("https://llm-gateway.example.com/model/info");
      expect(seenUrls.some((url) => url.endsWith("/models"))).toBe(false);
      expect(seenModels).toEqual(["litellm-chat-large", "litellm-unknown-mode"]);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual([
        "litellm-chat-large",
        "litellm-unknown-mode",
      ]);
      expect(
        seenAuthHeaders.every(
          (headers) => headers.auth === null && headers.custom === "Bearer example-secret-token",
        ),
      ).toBe(true);
      expect(currentGatewayConfig(deps)?.providers.map((provider) => provider.apiKeyHeaderName)).toEqual([
        "x-litellm-key",
        "x-litellm-key",
      ]);
      const saved = readFileSync(deps.gatewayConfig?.storagePath ?? "", "utf8");
      expect(saved).toContain('"apiKeyHeaderName": "x-litellm-key"');
      expect(saved).not.toContain("litellm-embedding");
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
      env: {},
      uiDbPath: join(uiDir, "keiko-ui.db"),
    });
    try {
      const result = await handleGatewaySetup(
        ctx({
          baseUrl: "https://llm-gateway.example.com/v1",
          apiKey: "example-secret-token",
          apiKeyHeaderName: "X-Litellm-Key",
        }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(seenUrls).toContain("https://llm-gateway.example.com/v1/model/info");
      expect(seenUrls).toContain("https://llm-gateway.example.com/v1/models");
      expect(
        seenAuthHeaders.every(
          (headers) => headers.auth === null && headers.custom === "Bearer example-secret-token",
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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

  it("production setup discovers models and stores only chat-callable models", async () => {
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
      env: {},
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
        "example-embedding-model",
      ]);
      expect((result.body as { testedModelIds?: readonly string[] }).testedModelIds).toEqual(
        ["example-chat-model-large", "example-chat-model-fast"],
      );
      expect(currentGatewayConfig(deps)?.providers.map((provider) => provider.modelId)).toEqual([
        "example-chat-model-large",
        "example-chat-model-fast",
      ]);
      expect(deps.gatewayConfig?.present()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      deps.store.close();
    }
  });
});
