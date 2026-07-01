import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { createDefaultChatCapability, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { handleGatewayReadiness, runGatewayReadiness } from "./gateway-readiness.js";
import type { RouteContext } from "./routes.js";

function gatewayConfig(modelId = "test-chat-model"): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://llm-gateway.internal/v1",
        apiKey: "secret-token",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
      },
      {
        modelId: "text-embedding-3-small",
        baseUrl: "https://llm-gateway.internal/v1",
        apiKey: "secret-token",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
      },
    ],
    capabilities: [
      createDefaultChatCapability(modelId),
      embeddingCapability("text-embedding-3-small"),
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function embeddingCapability(modelId: string): NonNullable<GatewayConfig["capabilities"]>[number] {
  return {
    id: modelId,
    kind: "embedding",
    contextWindow: 8191,
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
    knownLimitations: ["Runtime-configured capability; validate before production use"],
  };
}

function depsWith(
  config: GatewayConfig | undefined,
  fetchImpl: typeof fetch = vi.fn(),
): UiHandlerDeps {
  return {
    config,
    configPresent: config !== undefined,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    gatewayReadinessFetch: fetchImpl,
  };
}

function ctx(body: unknown): RouteContext {
  return rawCtx(JSON.stringify(body));
}

function rawCtx(body: string): RouteContext {
  return {
    req: Readable.from([Buffer.from(body, "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/gateway/readiness"),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(text: string): Response {
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}

function chatPayload(content: string): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

function embeddingPayload(vector: readonly number[] = [3, 4]): unknown {
  return { data: [{ embedding: vector }], model: "text-embedding-3-small" };
}

function requestBodyAt(fetchImpl: typeof fetch, index: number): Record<string, unknown> {
  const call = vi.mocked(fetchImpl).mock.calls[index];
  const init = call?.[1];
  const body = init?.body;
  expect(typeof body).toBe("string");
  if (typeof body !== "string") return {};
  return JSON.parse(body) as Record<string, unknown>;
}

function fetchForDefaultSuccess(): typeof fetch {
  return vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
    .mockResolvedValueOnce(sseResponse("stream-ok"))
    .mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "report_readiness", arguments: '{"status":"ok"}' },
                },
              ],
            },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(jsonResponse(chatPayload('{"status":"json-ok"}')))
    .mockResolvedValueOnce(jsonResponse(embeddingPayload())) as typeof fetch;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("gateway readiness route", () => {
  it("returns a clean NO_MODEL problem when no runtime gateway config exists", async () => {
    const deps = depsWith(undefined);
    const result = await handleGatewayReadiness(ctx({}), deps);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: "NO_MODEL", message: "Configure a gateway before running readiness checks." },
    });
    deps.store.close();
  });

  it("rejects oversized readiness request bodies before probing the provider", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const result = await handleGatewayReadiness(ctx({ modelId: "x".repeat(70_000) }), deps);

    expect(result.status).toBe(413);
    expect(result.body).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Readiness request body exceeds the size limit.",
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    deps.store.close();
  });

  it("rejects invalid readiness request bodies before probing the provider", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);

    await expect(handleGatewayReadiness(rawCtx("{"), deps)).resolves.toEqual({
      status: 400,
      body: {
        error: { code: "BAD_REQUEST", message: "The readiness request body must be valid JSON." },
      },
    });
    await expect(handleGatewayReadiness(rawCtx("[]"), deps)).resolves.toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "The readiness request body must be a JSON object.",
        },
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    deps.store.close();
  });

  it("rejects missing or non-conversation model selections without mutating config", async () => {
    const config = gatewayConfig("chat-model");
    const deps = depsWith(config, vi.fn());

    await expect(runGatewayReadiness({ modelId: "missing-model" }, deps)).resolves.toEqual({
      status: 400,
      body: {
        error: {
          code: "NO_MODEL",
          message: "Select a configured chat model before running readiness checks.",
        },
      },
    });

    const embeddingConfig: GatewayConfig = {
      ...gatewayConfig("text-embedding-3-large"),
      capabilities: [embeddingCapability("text-embedding-3-large")],
    };
    const embeddingDeps = depsWith(embeddingConfig, vi.fn());
    await expect(
      runGatewayReadiness({ modelId: "text-embedding-3-large" }, embeddingDeps),
    ).resolves.toEqual({
      status: 400,
      body: {
        error: {
          code: "NO_MODEL",
          message: "Select a conversation-capable model before running readiness checks.",
        },
      },
    });

    deps.store.close();
    embeddingDeps.store.close();
  });

  it("runs the default non-blocking probes without exposing gateway secrets", async () => {
    const fetchImpl = fetchForDefaultSuccess();
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness({ modelId: "test-chat-model" }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("ready");
    expect(report.verifiedCapabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      embedding: true,
      embeddingDimensions: 2,
      embeddingNorm: 1,
    });
    expect(report.probes.map((probe) => [probe.name, probe.status])).toEqual([
      ["chat", "passed"],
      ["streaming", "passed"],
      ["tool_calling", "passed"],
      ["json_schema", "passed"],
      ["embedding", "passed"],
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("llm-gateway.internal");
    for (let index = 0; index < 5; index += 1) {
      const body = requestBodyAt(fetchImpl, index);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("max_tokens");
    }
    deps.store.close();
  });

  it("checks the optional reranker when requested", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(jsonResponse({ results: [{ index: 0, relevance_score: 0.99 }] })) as
      typeof fetch;
    const config: GatewayConfig = {
      ...gatewayConfig(),
      reranker: {
        modelId: "qwen3-reranker",
        baseUrl: "https://reranker.internal/v1",
        apiKey: "reranker-secret",
        timeoutMs: 10_000,
      },
    };
    const deps = depsWith(config, fetchImpl);
    const report = await runGatewayReadiness({ options: { probes: ["reranker"] } }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("ready");
    expect(report.verifiedCapabilities.reranker).toBe(true);
    expect(report.probes).toEqual([
      expect.objectContaining({ name: "chat", status: "passed" }),
      expect.objectContaining({ name: "reranker", status: "passed" }),
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("reranker-secret");
    expect(serialized).not.toContain("reranker.internal");
    deps.store.close();
  });

  it("skips requested feature probes when basic chat is not verified", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("unexpected-answer"))) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness(
      { options: { probes: ["streaming", "json_schema", "tool_calling"] } },
      deps,
    );

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.probes).toEqual([
      expect.objectContaining({ name: "chat", status: "failed" }),
      expect.objectContaining({ name: "streaming", status: "skipped" }),
      expect.objectContaining({ name: "json_schema", status: "skipped" }),
      expect.objectContaining({ name: "tool_calling", status: "skipped" }),
    ]);
    deps.store.close();
  });

  it("classifies streaming and JSON schema provider rejections without blocking chat", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream unsupported" } }, 501))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "schema failed" } }, 500),
      ) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness(
      { options: { probes: ["streaming", "json_schema"] } },
      deps,
    );

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("partial");
    expect(report.probes).toEqual([
      expect.objectContaining({ name: "chat", status: "passed" }),
      expect.objectContaining({ name: "streaming", status: "unsupported" }),
      expect.objectContaining({ name: "json_schema", status: "failed" }),
    ]);
    deps.store.close();
  });

  it("reports provider timeouts as failed probes with an actionable warning", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness({ options: { probes: ["streaming"] } }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("failed");
    expect(report.probes[0]).toMatchObject({
      name: "chat",
      status: "failed",
      warning: "The probe timed out before the provider answered.",
    });
    expect(report.probes[1]).toMatchObject({ name: "streaming", status: "skipped" });
    deps.store.close();
  });

  it("marks a single unsupported feature as partial without mutating the model config", async () => {
    const config = gatewayConfig("qwen3-coder-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(sseResponse("stream-ok"))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "tools unavailable" } }, 400))
      .mockResolvedValueOnce(jsonResponse(chatPayload('{"status":"json-ok"}'))) as typeof fetch;
    const deps = depsWith(config, fetchImpl);
    const report = await runGatewayReadiness({ modelId: "qwen3-coder-test" }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("partial");
    const toolProbe = report.probes.find((probe) => probe.name === "tool_calling");
    expect(toolProbe?.status).toBe("unsupported");
    expect(toolProbe?.warning).toMatch(/qwen3_coder tool parser/i);
    expect(config.capabilities?.[0]?.toolCalling).toBe(true);
    deps.store.close();
  });

  it("detects reasoning output without persisting raw reasoning text", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                reasoning: "private chain that must not appear in the report",
                content: "FINAL: 2",
              },
            },
          ],
        }),
      ) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness(
      { modelId: "test-chat-model", options: { probes: ["reasoning"] } },
      deps,
    );

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("ready");
    expect(report.verifiedCapabilities.reasoningOutput).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private chain");
    deps.store.close();
  });

  it("marks malformed structured-output payloads as unsupported instead of failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(jsonResponse(chatPayload("not-json"))) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness({ options: { probes: ["json_schema"] } }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("partial");
    expect(report.probes[1]).toMatchObject({
      name: "json_schema",
      status: "unsupported",
      evidence: "The endpoint answered, but did not produce schema-valid JSON.",
    });
    deps.store.close();
  });

  it("verifies image, document, and long-context probes only from provider evidence", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(jsonResponse(chatPayload("red")))
      .mockResolvedValueOnce(jsonResponse(chatPayload("KEIKO PDF READINESS PROBE")))
      .mockResolvedValueOnce(
        jsonResponse(chatPayload("KEIKO_LONG_CONTEXT_SENTINEL")),
      ) as typeof fetch;
    const config: GatewayConfig = {
      ...gatewayConfig(),
      capabilities: [
        {
          ...createDefaultChatCapability("test-chat-model"),
          contextWindow: 64_000,
        },
      ],
    };
    const deps = depsWith(config, fetchImpl);
    const report = await runGatewayReadiness(
      { options: { probes: ["image_input", "document_input", "long_context"] } },
      deps,
    );

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("ready");
    expect(report.verifiedCapabilities).toMatchObject({
      imageInput: true,
      documentInput: true,
      testedContextTokens: 64_000,
    });
    expect(report.probes).toEqual([
      expect.objectContaining({ name: "chat", status: "passed" }),
      expect.objectContaining({ name: "image_input", status: "passed" }),
      expect.objectContaining({ name: "document_input", status: "passed" }),
      expect.objectContaining({ name: "long_context", status: "passed" }),
    ]);
    deps.store.close();
  });

  it("keeps deep probe failures isolated from the working chat result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(jsonResponse(chatPayload("blue")))
      .mockResolvedValueOnce(jsonResponse(chatPayload("no pdf phrase")))
      .mockResolvedValueOnce(jsonResponse(chatPayload("missing sentinel"))) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl);
    const report = await runGatewayReadiness(
      {
        options: {
          probes: ["image_input", "document_input", "long_context"],
          maxContextTokens: 128_000,
        },
      },
      deps,
    );

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("partial");
    expect(report.verifiedCapabilities.imageInput).toBeUndefined();
    expect(report.verifiedCapabilities.documentInput).toBeUndefined();
    expect(report.verifiedCapabilities.testedContextTokens).toBeUndefined();
    expect(report.probes.slice(1).map((probe) => probe.status)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    deps.store.close();
  });
});
