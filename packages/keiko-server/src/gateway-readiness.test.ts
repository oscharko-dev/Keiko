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
    ],
    capabilities: [createDefaultChatCapability(modelId)],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
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
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
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
    .mockResolvedValueOnce(jsonResponse(chatPayload("keiko-ready")))
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
    .mockResolvedValueOnce(jsonResponse(chatPayload('{"status":"json-ok"}'))) as typeof fetch;
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
    });
    expect(report.probes.map((probe) => [probe.name, probe.status])).toEqual([
      ["chat", "passed"],
      ["streaming", "passed"],
      ["tool_calling", "passed"],
      ["json_schema", "passed"],
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("llm-gateway.internal");
    for (let index = 0; index < 4; index += 1) {
      const body = requestBodyAt(fetchImpl, index);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("max_tokens");
    }
    deps.store.close();
  });

  it("marks a single unsupported feature as partial without mutating the model config", async () => {
    const config = gatewayConfig("qwen3-coder-test");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatPayload("keiko-ready")))
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
      .mockResolvedValueOnce(jsonResponse(chatPayload("keiko-ready")))
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
});
