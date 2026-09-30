import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseGatewayConfig,
  type LiteLLMRerankRequest,
  type RerankOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import {
  MAX_DISCOVERED_MODELS,
  handleGatewaySetup,
  normalizeDiscoveryPayloadForSetup,
  parseModelDiscovery,
} from "./gateway-setup.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { stopConfiguredConversationReadiness } from "./gateway-readiness.js";
import type { RouteContext } from "./routes.js";

// Discovery puts EVERY model into the right place — for both gateways. These tests pin the roles a
// LiteLLM-style `/model/info` inventory resolves to (chat, embedding, voice, rerank, unsupported),
// the context-window declarations a vLLM- or OpenAI-compatible proxy publishes, and the one lane
// that used to be reported and then forgotten: a discovered reranker is wired into retrieval after
// the same live probe an embedding model passes.

const VAULT_ENV: Readonly<Record<string, string>> = {
  KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
  KEIKO_FIGMA_KEY: Buffer.alloc(32, 0x42).toString("base64"),
};

const tmpDirs: string[] = [];
const handlerDeps: UiHandlerDeps[] = [];

afterEach(async () => {
  resetServerLogger();
  await Promise.all(handlerDeps.splice(0).map(stopConfiguredConversationReadiness));
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    correlationId: "corr-discovery-roles",
  };
}

describe("discovery roles", () => {
  it("puts a declared reranker in the rerank lane, never chat or embedding", () => {
    const parsed = normalizeDiscoveryPayloadForSetup({
      data: [
        { model_name: "qwen-chat", model_info: { mode: "chat" } },
        // The "bge" family prefix is what once bound a reranker to every Knowledge Pod.
        { model_name: "bge-reranker-v2-m3", model_info: { mode: "rerank" } },
        { model_name: "cohere-rerank", model_info: { mode: "rerank" } },
      ],
    });
    expect(parsed.chatModelIds).toEqual(["qwen-chat"]);
    expect(parsed.embeddingModelIds).toEqual([]);
    expect(parsed.rerankModelIds).toEqual(["bge-reranker-v2-m3", "cohere-rerank"]);
    // Still REPORTED until setup admits one: the operator sees what Keiko did not configure.
    expect(parsed.unsupportedModels).toEqual([
      { id: "bge-reranker-v2-m3", reason: "rerank" },
      { id: "cohere-rerank", reason: "rerank" },
    ]);
  });

  it.each(["bge-reranker-v2-m3", "jina-reranker-v2-base-multilingual", "rerank-english-v3.0"])(
    "recognises the mode-less rerank-named id %s as a rerank engine, not an embedding or chat model",
    (id) => {
      const parsed = normalizeDiscoveryPayloadForSetup({
        data: [{ id: "qwen-chat" }, { id }],
      });
      expect(parsed.rerankModelIds).toEqual([id]);
      expect(parsed.chatModelIds).toEqual(["qwen-chat"]);
      expect(parsed.embeddingModelIds).toEqual([]);
    },
  );

  it("keeps the sibling embedding models of the same families as embeddings", () => {
    const parsed = normalizeDiscoveryPayloadForSetup({
      data: [{ id: "qwen-chat" }, { id: "bge-m3" }, { id: "jina-embeddings-v3" }],
    });
    expect(parsed.embeddingModelIds).toEqual(["bge-m3", "jina-embeddings-v3"]);
    expect(parsed.rerankModelIds).toBeUndefined();
  });

  it("does not let an explicit chat_completion=false hide a rerank-named id", () => {
    const parsed = normalizeDiscoveryPayloadForSetup({
      data: [
        { id: "qwen-chat" },
        { id: "bge-reranker-large", capabilities: { chat_completion: false } },
      ],
    });
    expect(parsed.rerankModelIds).toEqual(["bge-reranker-large"]);
  });

  it("partitions rerank engines before the discovery cap", () => {
    const chatAliases = Array.from({ length: MAX_DISCOVERED_MODELS + 5 }, (_value, index) => ({
      model_name: `chat-${String(index)}`,
      model_info: { mode: "chat" },
    }));
    const parsed = normalizeDiscoveryPayloadForSetup({
      data: [...chatAliases, { model_name: "late-reranker", model_info: { mode: "rerank" } }],
    });
    expect(parsed.truncated).toBe(true);
    expect(parsed.rerankModelIds).toEqual(["late-reranker"]);
  });

  it("merges load-balanced replicas of one declared reranker into one rerank engine", () => {
    const parsed = normalizeDiscoveryPayloadForSetup({
      data: [
        { model_name: "qwen-chat", model_info: { mode: "chat" } },
        { model_name: "house-reranker", model_info: { mode: "rerank" } },
        { model_name: "house-reranker", model_info: { mode: "rerank" } },
      ],
    });
    expect(parsed.rerankModelIds).toEqual(["house-reranker"]);
    expect(parsed.unsupportedModels).toEqual([{ id: "house-reranker", reason: "rerank" }]);
  });

  it("still refuses a routing alias that mixes a declared reranker with chat", () => {
    const entries = [
      { model_name: "shared-alias", model_info: { mode: "rerank" } },
      { model_name: "shared-alias", model_info: { mode: "chat" } },
    ];
    for (const data of [entries, [...entries].reverse()]) {
      expect(() => parseModelDiscovery({ data })).toThrow();
    }
  });

  it("classifies the whole 15-model LiteLLM inventory into the right lanes", () => {
    const parsed = normalizeDiscoveryPayloadForSetup({ data: litellmInventory() });
    // Chat, in gateway order: declared chat aliases, the mode-less hosted_vllm models and the OCR
    // model that declares nothing (it stays a candidate; the ranking, not discovery, demotes it).
    expect(parsed.chatModelIds).toEqual([
      "gpt-4o",
      "qwen3-235b",
      "hosted-vllm-llama",
      "dotsocr",
      "multi-deployment-alias",
      "gpt-*",
    ]);
    expect(parsed.embeddingModelIds).toEqual(["multilingual-e5-large"]);
    expect(parsed.rerankModelIds).toEqual(["bge-reranker-v2-m3"]);
    expect(parsed.voiceSpeechInputModelIds).toEqual(["whisper-1"]);
    expect(parsed.voiceSpeechOutputModelIds).toEqual(["tts-1"]);
    expect(parsed.unsupportedModels).toEqual([
      { id: "bge-reranker-v2-m3", reason: "rerank" },
      { id: "dall-e-3", reason: "image_generation" },
      { id: "omni-moderation-latest", reason: "moderation" },
    ]);
  });
});

function litellmInventory(): readonly Record<string, unknown>[] {
  return [
    { model_name: "gpt-4o", model_info: { mode: "chat", max_input_tokens: 128_000 } },
    { model_name: "qwen3-235b", model_info: { mode: "chat", max_input_tokens: 131_072 } },
    // hosted_vllm models declare no mode and no window in /model/info.
    { model_name: "hosted-vllm-llama", litellm_params: { model: "hosted_vllm/llama" } },
    { model_name: "dotsocr", litellm_params: { model: "hosted_vllm/dotsocr" } },
    { model_name: "multilingual-e5-large", model_info: { mode: "embedding" } },
    { model_name: "bge-reranker-v2-m3", model_info: { mode: "rerank" } },
    { model_name: "whisper-1", model_info: { mode: "audio_transcription" } },
    { model_name: "tts-1", model_info: { mode: "audio_speech" } },
    { model_name: "dall-e-3", model_info: { mode: "image_generation" } },
    { model_name: "omni-moderation-latest", model_info: { mode: "moderation" } },
    // A multi-deployment alias: two chat deployments behind one name.
    {
      model_name: "multi-deployment-alias",
      model_info: { mode: "chat", max_input_tokens: 64_000 },
    },
    {
      model_name: "multi-deployment-alias",
      model_info: { mode: "chat", max_input_tokens: 32_000 },
    },
    { model_name: "gpt-*", model_info: { mode: "chat" } },
  ];
}

describe("declared context windows", () => {
  function windowOf(item: Record<string, unknown>): number | undefined {
    const parsed = parseModelDiscovery({ data: [{ model_name: "m", ...item }] });
    return parsed.modelMetadata?.m?.contextWindow;
  }

  it("reads max_input_tokens first, then the vLLM and OpenAI-compatible spellings", () => {
    expect(windowOf({ model_info: { max_input_tokens: 8_192, max_model_len: 32_768 } })).toBe(
      8_192,
    );
    expect(windowOf({ max_model_len: 32_768 })).toBe(32_768);
    expect(windowOf({ context_length: 65_536 })).toBe(65_536);
    expect(windowOf({ context_window: 16_384 })).toBe(16_384);
    // First declared field in authority order wins, whatever the others say.
    expect(windowOf({ context_window: 16_384, max_model_len: 32_768 })).toBe(32_768);
    expect(windowOf({ context_window: 16_384, context_length: 65_536 })).toBe(65_536);
  });

  it("reads the nested records LiteLLM uses", () => {
    expect(windowOf({ model_info: { max_model_len: 131_072 } })).toBe(131_072);
    expect(windowOf({ litellm_params: { context_length: 40_960 } })).toBe(40_960);
  });

  it("falls through a null or invalid declaration to the next field", () => {
    expect(windowOf({ model_info: { max_input_tokens: null }, max_model_len: 32_768 })).toBe(
      32_768,
    );
  });

  it.each([0, -1, 1.5, "32768", null, Number.MAX_SAFE_INTEGER + 2])(
    "never accepts %j as a declared window",
    (value) => {
      expect(windowOf({ max_model_len: value })).toBeUndefined();
      expect(windowOf({ context_length: value })).toBeUndefined();
      expect(windowOf({ context_window: value })).toBeUndefined();
    },
  );

  it("declares nothing when the gateway publishes no window at all", () => {
    expect(windowOf({ model_info: { mode: "chat" } })).toBeUndefined();
  });
});

describe("discovery role evidence", () => {
  it("records the role of every discovered alias, body-free", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    parseModelDiscovery({ data: litellmInventory() }, "corr-role-evidence");
    const lines = sink.events.filter(
      (event) => event.op === "gateway.discovery.alias-intersection",
    );
    const roles = lines.map((event) => event.extra?.role);
    expect(new Set(roles)).toEqual(
      new Set(["chat", "embedding", "voice", "rerank", "unsupported"]),
    );
    expect(lines.every((event) => event.correlationId === "corr-role-evidence")).toBe(true);
    const rerank = lines.find((event) => event.extra?.role === "rerank");
    expect(rerank?.extra?.modelIdDigest).toMatch(/^[a-f0-9]{16}$/u);
    expect(JSON.stringify(sink.events)).not.toContain("bge-reranker-v2-m3");
    expectActivityLogProof(
      "gateway.discovery.alias-intersection.line",
      formatActivityLogProofLine(rerank ?? {}),
    );
  });
});

interface RerankPort {
  readonly requests: LiteLLMRerankRequest[];
  readonly rerankRequest: (request: LiteLLMRerankRequest) => Promise<RerankOutcome>;
}

// The provider ranks the document that matches the probe query first — a working reranker.
function answeringRerankPort(): RerankPort {
  return scriptedRerankPort((request) => ({
    ok: true,
    value: {
      modelId: request.modelId,
      results: [
        { index: 0, relevanceScore: 0.97 },
        { index: 1, relevanceScore: 0.02 },
      ],
    },
  }));
}

function scriptedRerankPort(script: (request: LiteLLMRerankRequest) => RerankOutcome): RerankPort {
  const requests: LiteLLMRerankRequest[] = [];
  return {
    requests,
    rerankRequest: (request): Promise<RerankOutcome> => {
      requests.push(request);
      return Promise.resolve(script(request));
    },
  };
}

interface SetupFixture {
  readonly deps: UiHandlerDeps;
}

async function setupFixture(
  payload: readonly Record<string, unknown>[],
  port: RerankPort,
): Promise<SetupFixture> {
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: await tempDir("keiko-rerank-ev-"),
    env: { ...VAULT_ENV },
    uiDbPath: join(await tempDir("keiko-rerank-ui-"), "keiko-ui.db"),
    // The REAL classifier drives the roles: stubbing the discovery result would assert the fixture.
    gatewayModelDiscovery: () =>
      Promise.resolve(normalizeDiscoveryPayloadForSetup({ data: payload })),
    gatewayEmbeddingProbe: (_config, ids) => Promise.resolve(ids),
    gatewaySetupTester: (_config, modelIds) => Promise.resolve(modelIds),
  });
  handlerDeps.push(deps);
  Object.assign(deps, { rerankRequest: port.rerankRequest });
  return { deps };
}

const CHAT_AND_RERANKER: readonly Record<string, unknown>[] = [
  { model_name: "qwen-chat", model_info: { mode: "chat" } },
  { model_name: "house-reranker", model_info: { mode: "rerank" } },
];

describe("reranker wiring from discovery", () => {
  it("wires a discovered reranker that passes the live two-document probe", async () => {
    const port = answeringRerankPort();
    const { deps } = await setupFixture(CHAT_AND_RERANKER, port);

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );

    expect(result.status).toBe(200);
    const config = currentGatewayConfig(deps);
    expect(config?.reranker).toMatchObject({
      modelId: "house-reranker",
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: "example-secret-token",
    });
    // The very two-document request readiness sends: the matching document ranks first.
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]).toMatchObject({
      modelId: "house-reranker",
      endpoint: "https://llm-gateway.example.com/v1",
      documents: ["alpha readiness match", "unrelated beta"],
      topN: 1,
    });
    // The reranker is not a chat or embedding provider, and it is no longer "unsupported".
    expect(config?.providers.map((provider) => provider.modelId)).toEqual(["qwen-chat"]);
    expect(result.body).not.toHaveProperty("unsupportedModels");
    expect(result.body).toMatchObject({
      config: { reranker: { modelId: "house-reranker" } },
    });
  });

  it("seals the wired reranker credential like every provider key", async () => {
    const { deps } = await setupFixture(CHAT_AND_RERANKER, answeringRerankPort());
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    const storagePath = deps.gatewayConfig?.storagePath;
    if (storagePath === undefined) throw new Error("expected a gateway config store");
    const persisted = readFileSync(storagePath, "utf8");
    expect(persisted).not.toContain("example-secret-token");
    const block = (JSON.parse(persisted) as { reranker?: Record<string, unknown> }).reranker;
    expect(block).toMatchObject({ modelId: "house-reranker" });
    expect(block).toHaveProperty("apiKeySecretRef");
    expect(block).not.toHaveProperty("apiKey");
  });

  it("does not wire a reranker that answers but ranks the wrong document first", async () => {
    const port = scriptedRerankPort((request) => ({
      ok: true,
      value: {
        modelId: request.modelId,
        results: [
          { index: 1, relevanceScore: 0.9 },
          { index: 0, relevanceScore: 0.1 },
        ],
      },
    }));
    const { deps } = await setupFixture(CHAT_AND_RERANKER, port);
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(currentGatewayConfig(deps)?.reranker).toBeUndefined();
    expect(result.body).toMatchObject({
      unsupportedModels: [{ id: "house-reranker", reason: "rerank" }],
    });
  });

  it("leaves retrieval reranking off when the endpoint refuses the probe", async () => {
    const port = scriptedRerankPort(() => ({ ok: false, kind: "unsupported-model" }));
    const { deps } = await setupFixture(CHAT_AND_RERANKER, port);
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(currentGatewayConfig(deps)?.reranker).toBeUndefined();
    expect(result.body).toMatchObject({
      unsupportedModels: [{ id: "house-reranker", reason: "rerank" }],
    });
  });

  it("never replaces or even probes when the operator already owns a reranker", async () => {
    const port = answeringRerankPort();
    const { deps } = await setupFixture(CHAT_AND_RERANKER, port);
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "qwen-chat",
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "old-token",
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        reranker: {
          modelId: "operator-reranker",
          baseUrl: "https://rerank.example.com",
          apiKey: "operator-rerank-token",
          timeoutMs: 10_000,
        },
      }),
      true,
    );

    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(currentGatewayConfig(deps)?.reranker).toMatchObject({
      modelId: "operator-reranker",
      apiKey: "operator-rerank-token",
    });
    expect(port.requests).toHaveLength(0);
    // The discovered engine is reported, not configured.
    expect(result.body).toMatchObject({
      unsupportedModels: [{ id: "house-reranker", reason: "rerank" }],
    });
  });

  it("makes a wired reranker follow a gateway credential rotation, like every shared provider", async () => {
    const port = answeringRerankPort();
    const { deps } = await setupFixture(CHAT_AND_RERANKER, port);
    const first = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "first-token" }),
      deps,
    );
    expect(first.status).toBe(200);
    expect(currentGatewayConfig(deps)?.reranker?.apiKey).toBe("first-token");

    const rotated = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "rotated-token" }),
      deps,
    );

    expect(rotated.status).toBe(200);
    // Left behind, the reranker would keep sending the dead token and silently degrade retrieval.
    expect(currentGatewayConfig(deps)?.reranker).toMatchObject({
      modelId: "house-reranker",
      apiKey: "rotated-token",
    });
    // Already wired: the second run neither probes nor replaces it.
    expect(port.requests).toHaveLength(1);
  });

  it("never moves a reranker with its own connection onto the gateway's new credential", async () => {
    const { deps } = await setupFixture(CHAT_AND_RERANKER, answeringRerankPort());
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "qwen-chat",
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "old-token",
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        reranker: {
          modelId: "operator-reranker",
          baseUrl: "https://rerank.example.com",
          apiKey: "operator-rerank-token",
        },
      }),
      true,
    );
    await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "rotated-token" }),
      deps,
    );
    expect(currentGatewayConfig(deps)?.reranker).toMatchObject({
      baseUrl: "https://rerank.example.com",
      apiKey: "operator-rerank-token",
    });
  });

  it("wires the first candidate that ranks and stops probing", async () => {
    const port = scriptedRerankPort((request) =>
      request.modelId === "second-reranker"
        ? {
            ok: true,
            value: { modelId: request.modelId, results: [{ index: 0 }, { index: 1 }] },
          }
        : { ok: false, kind: "transport" },
    );
    const { deps } = await setupFixture(
      [
        { model_name: "qwen-chat", model_info: { mode: "chat" } },
        { model_name: "first-reranker", model_info: { mode: "rerank" } },
        { model_name: "second-reranker", model_info: { mode: "rerank" } },
        { model_name: "third-reranker", model_info: { mode: "rerank" } },
      ],
      port,
    );
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(currentGatewayConfig(deps)?.reranker?.modelId).toBe("second-reranker");
    expect(port.requests.map((request) => request.modelId)).toEqual([
      "first-reranker",
      "second-reranker",
    ]);
    // Only the engines Keiko did not configure remain in the report.
    expect(result.body).toMatchObject({
      unsupportedModels: [
        { id: "first-reranker", reason: "rerank" },
        { id: "third-reranker", reason: "rerank" },
      ],
    });
  });

  it("bounds the probes so a gateway with many rerank aliases cannot stretch setup", async () => {
    const port = scriptedRerankPort(() => ({ ok: false, kind: "transport" }));
    const { deps } = await setupFixture(
      [
        { model_name: "qwen-chat", model_info: { mode: "chat" } },
        ...Array.from({ length: 8 }, (_value, index) => ({
          model_name: `reranker-${String(index)}`,
          model_info: { mode: "rerank" },
        })),
      ],
      port,
    );
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(port.requests).toHaveLength(3);
    expect(currentGatewayConfig(deps)?.reranker).toBeUndefined();
  });

  it("does not probe at all when discovery found no reranker", async () => {
    const port = answeringRerankPort();
    const { deps } = await setupFixture(
      [{ model_name: "qwen-chat", model_info: { mode: "chat" } }],
      port,
    );
    const result = await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(port.requests).toHaveLength(0);
    expect(currentGatewayConfig(deps)?.reranker).toBeUndefined();
  });

  it.each([
    { outcome: "wired", makePort: (): RerankPort => answeringRerankPort() },
    {
      outcome: "probe-failed",
      makePort: (): RerankPort => scriptedRerankPort(() => ({ ok: false, kind: "transport" })),
    },
  ] as const)(
    "leaves one body-free activity line when the outcome is $outcome",
    async ({ outcome, makePort }) => {
      const probedCount = 1;
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const { deps } = await setupFixture(CHAT_AND_RERANKER, makePort());
      const result = await handleGatewaySetup(
        ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
        deps,
      );
      expect(result.status).toBe(200);
      const lines = sink.events.filter((event) => event.op === "gateway.reranker.setup.resolved");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        correlationId: "corr-discovery-roles",
        extra: { outcome, candidateCount: 1, probedCount, completeness: "complete", loss: "none" },
      });
      expect(JSON.stringify(sink.events)).not.toContain("house-reranker");
      expect(JSON.stringify(sink.events)).not.toContain("example-secret-token");
      expectActivityLogProof(
        "gateway.reranker.setup.resolved.line",
        formatActivityLogProofLine(lines[0] ?? {}),
      );
    },
  );

  it("records kept-existing when the operator's reranker blocks the wiring", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const port = answeringRerankPort();
    const { deps } = await setupFixture(CHAT_AND_RERANKER, port);
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "qwen-chat",
            baseUrl: "https://llm-gateway.example.com/v1",
            apiKey: "old-token",
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        reranker: {
          modelId: "operator-reranker",
          baseUrl: "https://rerank.example.com",
          apiKey: "operator-rerank-token",
        },
      }),
      true,
    );
    await handleGatewaySetup(
      ctx({ baseUrl: "https://llm-gateway.example.com/v1", apiKey: "example-secret-token" }),
      deps,
    );
    const lines = sink.events.filter((event) => event.op === "gateway.reranker.setup.resolved");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.extra).toMatchObject({ outcome: "kept-existing", probedCount: 0 });
  });
});
