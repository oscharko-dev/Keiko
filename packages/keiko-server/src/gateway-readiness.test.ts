import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { createDefaultChatCapability, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { maxUtf8BytesForTokenBudget, UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  EMBEDDING_EVIDENCE_PATTERN,
  TESTED_CONTEXT_TOKENS_PATTERN,
  handleGatewayReadiness,
  longContextTokens,
  runGatewayReadiness,
} from "./gateway-readiness.js";
import type { RouteContext } from "./routes.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

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
  diagnostics?: ServerDiagnosticSink,
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
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

// Capturing operator-diagnostic sink (never the default stderr sink) for the observability pins.
function capturingDiagnostics(): {
  readonly sink: ServerDiagnosticSink;
  readonly records: ServerDiagnosticRecord[];
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    records,
    sink: {
      record: (entry: ServerDiagnosticRecord): void => {
        records.push(entry);
      },
    },
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
  it("keeps credentialed chat completion transport inside the model gateway package", () => {
    const source = readFileSync(join(CURRENT_DIR, "gateway-readiness.ts"), "utf8");

    expect(source).not.toContain("gatewayFetch(");
    expect(source).not.toContain("/chat/completions");
    expect(source).not.toContain("apiKeyHeaderValue");
    expect(source).toContain("requestGatewayReadinessChatCompletion");
  });

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
    expect(requestBodyAt(fetchImpl, 3)).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "keiko_readiness_probe",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { status: { type: "string", enum: ["json-ok"] } },
            required: ["status"],
          },
        },
      },
    });
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
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ index: 0, relevance_score: 0.99 }] }),
      ) as typeof fetch;
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

  it("probes the reranker of the config generation the run started with", async () => {
    // The gateway-setup save route can replace the runtime config while a readiness run is in
    // flight, and feature probes execute concurrently after the awaited chat probe. Every probe in
    // one report must describe the generation `chooseProvider` selected, so a save that lands
    // mid-run must not redirect the reranker probe at a different endpoint.
    const rerankerFor = (host: string): NonNullable<GatewayConfig["reranker"]> => ({
      modelId: "qwen3-reranker",
      baseUrl: `https://${host}/v1`,
      apiKey: "reranker-secret",
      timeoutMs: 10_000,
    });
    const pinned: GatewayConfig = { ...gatewayConfig(), reranker: rerankerFor("pinned.internal") };
    const saved: GatewayConfig = { ...gatewayConfig(), reranker: rerankerFor("saved.internal") };

    let current: GatewayConfig = pinned;
    const rerankUrls: string[] = [];
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("rerank")) {
        rerankUrls.push(url);
        return Promise.resolve(jsonResponse({ results: [{ index: 0, relevance_score: 0.99 }] }));
      }
      // Simulate a concurrent gateway-setup save landing while the chat probe is awaited.
      current = saved;
      return Promise.resolve(jsonResponse(chatPayload("OK")));
    }) as unknown as typeof fetch;

    const deps: UiHandlerDeps = {
      ...depsWith(pinned, fetchImpl),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => current,
        present: () => true,
        set: (next) => {
          current = next ?? pinned;
        },
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    };

    const report = await runGatewayReadiness({ options: { probes: ["reranker"] } }, deps);

    expect("status" in report).toBe(false);
    expect(rerankUrls).toHaveLength(1);
    expect(rerankUrls[0]).toContain("pinned.internal");
    expect(rerankUrls[0]).not.toContain("saved.internal");
    deps.store.close();
  });

  it("skips requested feature probes when basic chat is not verified", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("unexpected-answer"))) as typeof fetch;
    const config = gatewayConfig();
    const clearVerifiedCapability = vi.fn(() => true);
    const deps: UiHandlerDeps = {
      ...depsWith(config, fetchImpl),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability,
      },
    };
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
    expect(clearVerifiedCapability).toHaveBeenCalledWith("test-chat-model", 0);
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

  // 0.3.0 audit: a readiness run is the product's ONLY live evidence about the gateway, and every
  // probe's `catch` collapsed the cause into the same two operator-facing sentences with nothing
  // recorded anywhere. An auth rejection, a DNS failure and a missing model were indistinguishable.
  it("records the discarded probe cause on the diagnostic sink, keyed by the run's correlation id", async () => {
    const captured = capturingDiagnostics();
    const fetchImpl = vi.fn().mockRejectedValue(
      Object.assign(
        new TypeError("fetch failed for https://llm-gateway.internal/v1 key=secret-token"),
        {
          code: "ENOTFOUND",
        },
      ),
    ) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl, captured.sink);

    const report = await runGatewayReadiness(
      { options: { probes: [] } },
      deps,
      "readiness-corr-001",
    );

    expect("status" in report).toBe(false);
    expect(captured.records).toHaveLength(1);
    const record = captured.records[0];
    expect(record?.correlationId).toBe("readiness-corr-001");
    expect(record?.operation).toBe("gateway.readiness");
    // `source` names WHICH probe failed — the fact the collapsed evidence string cannot carry.
    expect(record?.source).toBe("gateway-readiness.chat");
    expect(record?.errorClass).toBe("TypeError");
    expect(record?.code).toBe("ENOTFOUND");
    // Body-free: neither the endpoint nor the apiKey in the transport message reaches the record.
    expect(JSON.stringify(record)).not.toContain("llm-gateway.internal");
    expect(JSON.stringify(record)).not.toContain("secret-token");
    deps.store.close();
  });

  it("names every failing deep probe separately in its own diagnostic record", async () => {
    const captured = capturingDiagnostics();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockRejectedValue(new Error("upstream gone")) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl, captured.sink);

    await runGatewayReadiness(
      { options: { probes: ["streaming", "json_schema"] } },
      deps,
      "readiness-corr-002",
    );

    expect(captured.records.map((entry) => entry.source).sort()).toEqual([
      "gateway-readiness.json_schema",
      "gateway-readiness.streaming",
    ]);
    expect(captured.records.every((entry) => entry.correlationId === "readiness-corr-002")).toBe(
      true,
    );
    deps.store.close();
  });

  it("mints a correlation id when the readiness run has no request context", async () => {
    const captured = capturingDiagnostics();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("upstream gone")) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl, captured.sink);

    await runGatewayReadiness({ options: { probes: [] } }, deps);

    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]?.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    deps.store.close();
  });

  it("threads the request correlation id from the route into the probe diagnostics", async () => {
    const captured = capturingDiagnostics();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("upstream gone")) as typeof fetch;
    const deps = depsWith(gatewayConfig(), fetchImpl, captured.sink);

    await handleGatewayReadiness(
      { ...ctx({ options: { probes: [] } }), correlationId: "route-corr-0001" },
      deps,
    );

    expect(captured.records[0]?.correlationId).toBe("route-corr-0001");
    deps.store.close();
  });

  it("marks a single unsupported feature as partial without mutating the model config", async () => {
    const config = gatewayConfig("qwen3-coder-test");
    let observedToolCalling: boolean | undefined;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(sseResponse("stream-ok"))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "tools unavailable" } }, 400))
      .mockResolvedValueOnce(jsonResponse(chatPayload('{"status":"json-ok"}'))) as typeof fetch;
    const deps: UiHandlerDeps = {
      ...depsWith(config, fetchImpl),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: (_modelId, fields) => {
          observedToolCalling = fields.toolCalling;
        },
        clearVerifiedCapability: () => false,
      },
    };
    const report = await runGatewayReadiness({ modelId: "qwen3-coder-test" }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("partial");
    const toolProbe = report.probes.find((probe) => probe.name === "tool_calling");
    expect(toolProbe?.status).toBe("unsupported");
    expect(toolProbe?.warning).toMatch(/qwen3_coder tool parser/i);
    expect(config.capabilities?.[0]?.toolCalling).toBe(true);
    expect(observedToolCalling).toBe(false);
    deps.store.close();
  });

  it("does not persist a negative capability from an inconclusive semantic probe", async () => {
    const config = gatewayConfig();
    const recordVerifiedCapability = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("OK")))
      .mockResolvedValueOnce(sseResponse("different-answer")) as typeof fetch;
    const deps: UiHandlerDeps = {
      ...depsWith(config, fetchImpl),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability,
        clearVerifiedCapability: () => false,
      },
    };

    const report = await runGatewayReadiness({ options: { probes: ["chat", "streaming"] } }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.probes.find((probe) => probe.name === "streaming")).toMatchObject({
      status: "unsupported",
    });
    expect(recordVerifiedCapability).not.toHaveBeenCalled();
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
    const longContextRequest = requestBodyAt(fetchImpl, 3);
    const longContextMessages = longContextRequest.messages as
      readonly { readonly content?: unknown }[] | undefined;
    const longContextUserContent = longContextMessages?.[1]?.content;
    expect(typeof longContextUserContent).toBe("string");
    if (typeof longContextUserContent === "string") {
      const [filler] = longContextUserContent.split("\nKEIKO_LONG_CONTEXT_SENTINEL");
      expect(Buffer.byteLength(filler ?? "", "utf8")).toBe(maxUtf8BytesForTokenBudget(64_000));
    }
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

  // F-01: this run is the product's only live gateway evidence. Recording its outcome on the config
  // holder is what lets the editor AI-assist badge and the Workbench source projection stop
  // inferring readiness from configuration alone; without it they have nothing to read.
  it("records the probe outcome on the config holder for other surfaces to read", async () => {
    const recorded: string[] = [];
    const config = gatewayConfig();
    const deps: UiHandlerDeps = {
      ...depsWith(config, fetchForDefaultSuccess()),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        verification: () => UNVERIFIED_GATEWAY,
        generation: () => 0,
        recordVerification: (state) => {
          recorded.push(state);
        },
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    };

    const report = await runGatewayReadiness({ modelId: "test-chat-model" }, deps);

    expect("status" in report).toBe(false);
    if ("status" in report) return;
    expect(report.overallStatus).toBe("ready");
    expect(recorded).toEqual(["verified"]);
    deps.store.close();
  });

  it("does not record negative capabilities for probes the request did not execute", async () => {
    const config = gatewayConfig();
    const recordVerifiedCapability = vi.fn();
    const deps: UiHandlerDeps = {
      ...depsWith(config, fetchForDefaultSuccess()),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        verification: () => UNVERIFIED_GATEWAY,
        generation: () => 0,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability,
        clearVerifiedCapability: () => false,
      },
    };

    await runGatewayReadiness({ options: { probes: ["chat"] } }, deps);

    expect(recordVerifiedCapability).not.toHaveBeenCalled();
    deps.store.close();
  });

  it("records a failed chat probe as a failed verification, never as unverified", async () => {
    const recorded: string[] = [];
    const config = gatewayConfig();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("unexpected-answer"))) as typeof fetch;
    const deps: UiHandlerDeps = {
      ...depsWith(config, fetchImpl),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        verification: () => UNVERIFIED_GATEWAY,
        generation: () => 0,
        recordVerification: (state) => {
          recorded.push(state);
        },
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    };

    await runGatewayReadiness({ options: { probes: ["chat"] } }, deps);

    expect(recorded).toEqual(["failed"]);
    deps.store.close();
  });
});

describe("longContextTokens (KEIKO-0358)", () => {
  it("returns the extended long-context budget for an unknown contextWindow", () => {
    // Before the fix, contextWindow=0 (a placeholder / not-yet-probed capability) fell
    // through to DEFAULT_LONG_CONTEXT_TOKENS (32_000). That capped the deep-probe test
    // token budget at 32k for the very model shapes it was meant to expose. Assume the
    // extended budget for the unknown case so a genuinely long-context model can be
    // probed near its real ceiling instead of silently being tested short.
    const capability = { ...createDefaultChatCapability("probe-model"), contextWindow: 0 };
    expect(longContextTokens(undefined, capability)).toBe(64_000);
    expect(longContextTokens(undefined, capability)).toBeGreaterThan(32_000);
  });

  it("still caps a genuinely small window at the default budget", () => {
    // Fix must be scoped to the 0 sentinel. A model that reports a small but positive
    // window (e.g. 16k) still probes only up to DEFAULT_LONG_CONTEXT_TOKENS so the probe
    // never asks past the model's real ceiling.
    const capability = { ...createDefaultChatCapability("probe-model"), contextWindow: 16_000 };
    expect(longContextTokens(undefined, capability)).toBe(32_000);
  });
});

describe("verified-capability evidence patterns (S8786 regression)", () => {
  it("still recovers a realistic token count", () => {
    const match = "64000 approximate tokens were accepted and the sentinel was recovered.".match(
      TESTED_CONTEXT_TOKENS_PATTERN,
    );
    expect(match?.[1]).toBe("64000");
  });

  it("still recovers realistic embedding dimensions and L2 norm", () => {
    // The real evidence string (built in this file as
    // `Embedding endpoint returned ${dimensions} dimensions with L2 norm ${norm.toFixed(4)}.`)
    // ends in a sentence-terminating period, and `[0-9.]` — unchanged by this fix, both before
    // and after — greedily swallows it into the capture too; `Number.parseFloat` below still
    // recovers the correct value regardless. This asserts the (pre-existing, unchanged) capture
    // shape, not a new behavior introduced by the S8786 bound.
    const match = "Embedding endpoint returned 1536 dimensions with L2 norm 1.0000.".match(
      EMBEDDING_EVIDENCE_PATTERN,
    );
    expect(match?.[1]).toBe("1536");
    expect(match?.[2]).toBe("1.0000.");
    expect(Number.parseFloat(match?.[2] ?? "0")).toBe(1);
  });

  // Regression: `norm` is computed from an untrusted embedding provider's Float32Array response,
  // so an adversarial/broken provider can drive it into the 1e17..1e21 range (well within float32
  // magnitude) before `.toFixed(4)` switches to exponential notation at 1e21. A norm capture bound
  // of 20 characters silently truncates the digits instead of failing to match — an entire order
  // of magnitude wrong rather than a clean parse failure. The bound must be wide enough to capture
  // the full value up to the 26-character ceiling that `.toFixed(4)` can produce below 1e21.
  it("recovers the full adversarial norm instead of silently truncating it", () => {
    const adversarialNorm = (9.999e20).toFixed(4);
    expect(adversarialNorm).toBe("999900000000000000000.0000");
    const evidence = `Embedding endpoint returned 1536 dimensions with L2 norm ${adversarialNorm}.`;
    const match = evidence.match(EMBEDDING_EVIDENCE_PATTERN);
    // The full numeric value must be captured (plus the trailing sentence period, consistent with
    // the greedy `[0-9.]` class above) -- not truncated to the first 20 characters.
    expect(match?.[2]).toBe(`${adversarialNorm}.`);
    expect(Number.parseFloat(match?.[2] ?? "0")).toBe(9.999e20);
  });

  // The old unbounded `\d+`/`[0-9.]+` patterns were unanchored, so a long digit run that never
  // reaches the expected trailing literal forced an O(n) backtrack retry at every one of the
  // O(n) start positions in the evidence string — quadratic in local timing (measured seconds at
  // ~100k characters). The `{1,15}`/`{1,20}` bounds cap that retry to a constant, so this must
  // stay comfortably under budget even at 100,000 characters.
  it("stays well within a tight time budget for an adversarial non-matching evidence string", () => {
    const adversarialTokens = "9".repeat(100_000) + " tokens";
    const start = Date.now();
    const tokenMatch = adversarialTokens.match(TESTED_CONTEXT_TOKENS_PATTERN);
    const tokenElapsedMs = Date.now() - start;
    expect(tokenElapsedMs).toBeLessThan(1500);
    expect(tokenMatch).toBeNull();

    const adversarialEmbedding = "9.".repeat(50_000) + " norm";
    const embeddingStart = Date.now();
    const embeddingMatch = adversarialEmbedding.match(EMBEDDING_EVIDENCE_PATTERN);
    const embeddingElapsedMs = Date.now() - embeddingStart;
    expect(embeddingElapsedMs).toBeLessThan(1500);
    expect(embeddingMatch).toBeNull();
  });
});
