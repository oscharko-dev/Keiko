import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { GatewayRequest, GatewayStreamChunk, ModelProviderConfig } from "./types.js";
import type { ModelGatewayLogEvent } from "./observability.js";

const CONTENT = [
  "Contact: +49 30 12345678",
  "Account: DE89 3704 0044 0532 0130 00",
  "```python",
  "from mcp.server.models import InitializationOptions",
  'password = "customer-owned-example"',
  "```",
].join("\n");
const CONFIG: ModelProviderConfig = {
  modelId: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-provider-credential-2026",
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayRequest = {
  modelId: CONFIG.modelId,
  messages: [{ role: "user", content: "Quote the attached document." }],
};

afterEach(() => vi.unstubAllEnvs());

function adapter(response: Response, events: ModelGatewayLogEvent[] = []): OpenAiAdapter {
  return new OpenAiAdapter({
    requestId: "fixture-request",
    costClass: "low",
    fetchImpl: () => Promise.resolve(response),
    log: { write: (event): void => void events.push(event) },
  });
}

function bufferedResponse(content: string): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function streamedResponse(parts: readonly string[]): Response {
  const lines = parts.map(
    (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  );
  return new Response(lines.join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("provider content preservation", () => {
  it("preserves complete customer answers and records only the selected policy", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const events: ModelGatewayLogEvent[] = [];
    const result = await adapter(bufferedResponse(CONTENT + CONFIG.apiKey), events).call(
      REQUEST,
      CONFIG,
    );
    expect(result.content).toBe(CONTENT + "[REDACTED]");
    expect(events.find((event) => event.op === "chat.request.dispatch")?.extra).toMatchObject({
      contentRedactionEnabled: false,
    });
    expect(JSON.stringify(events)).not.toContain("customer-owned-example");
    expect(JSON.stringify(events)).not.toContain(CONFIG.apiKey);
  });

  it("preserves streamed and terminal answers while protecting split provider credentials", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const text = CONTENT + CONFIG.apiKey;
    const parts = Array.from(text);
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapter(streamedResponse(parts)).callStream(REQUEST, CONFIG)) {
      chunks.push(chunk);
    }
    const streamed = chunks
      .flatMap((chunk) => (chunk.type === "delta" ? [chunk.token] : []))
      .join("");
    const terminal = chunks.find((chunk) => chunk.type === "done");
    expect(streamed).toBe(CONTENT + "[REDACTED]");
    expect(terminal?.type === "done" && terminal.response.content).toBe(streamed);
  });

  it("keeps the default provider response protection", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", undefined);
    const result = await adapter(bufferedResponse(CONTENT)).call(REQUEST, CONFIG);
    expect(result.content).not.toContain("+49 30 12345678");
    expect(result.content).not.toContain("customer-owned-example");
  });

  it("preserves structured customer fields while removing configured credentials", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const content = JSON.stringify({
      phone: "+49 30 12345678",
      password: "customer-owned-example",
      provider: CONFIG.apiKey,
    });
    const result = await adapter(bufferedResponse(content)).call(
      { ...REQUEST, responseFormat: { type: "json_schema", schema: { type: "object" } } },
      CONFIG,
    );
    expect(result.structuredOutput).toEqual({
      phone: "+49 30 12345678",
      password: "customer-owned-example",
      provider: "[REDACTED]",
    });
  });
});
