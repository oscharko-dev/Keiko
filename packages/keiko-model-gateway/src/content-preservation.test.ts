// #4098: a Chat answer keeps authorized content only when its caller asks for it explicitly
// (`contentRedaction: "preserve"`, set by Chat under the deployment opt-out alone). The gateway never
// reads the deployment environment itself, so every other surface keeps the default projection.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import { createScriptedGatewayClock } from "./replay.js";
import type {
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";
import type { ModelGatewayLogEvent } from "./observability.js";

const CONTENT = [
  "Contact: +49 30 12345678",
  "Account: DE89 3704 0044 0532 0130 00",
  "```python",
  "from mcp.server.models import InitializationOptions",
  'password = "customer-owned-example"',
  "```",
].join("\n");
const ISSUER_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const CONFIG: ModelProviderConfig = {
  modelId: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-provider-credential-2026",
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayCallRequest = {
  modelId: CONFIG.modelId,
  messages: [{ role: "user", content: "Quote the attached document." }],
};
const PRESERVE: GatewayCallRequest = { ...REQUEST, contentRedaction: "preserve" };

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

function dispatchPolicy(events: readonly ModelGatewayLogEvent[]): unknown {
  return events.find((event) => event.op === "chat.request.dispatch")?.extra
    ?.contentRedactionEnabled;
}

describe("provider content preservation", () => {
  it("preserves a Chat answer that asks for it and records only the selected policy", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const result = await adapter(
      bufferedResponse(CONTENT + CONFIG.apiKey + " " + ISSUER_TOKEN),
      events,
    ).call(PRESERVE, CONFIG);
    expect(result.content).toBe(CONTENT + "[REDACTED] [REDACTED]");
    expect(dispatchPolicy(events)).toBe(false);
    expect(JSON.stringify(events)).not.toContain("customer-owned-example");
    expect(JSON.stringify(events)).not.toContain(CONFIG.apiKey);
  });

  it("preserves streamed and terminal answers while protecting split provider credentials", async () => {
    const text = CONTENT + CONFIG.apiKey;
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapter(streamedResponse(Array.from(text))).callStream(
      PRESERVE,
      CONFIG,
    )) {
      chunks.push(chunk);
    }
    const streamed = chunks
      .flatMap((chunk) => (chunk.type === "delta" ? [chunk.token] : []))
      .join("");
    const terminal = chunks.find((chunk) => chunk.type === "done");
    expect(streamed).toBe(CONTENT + "[REDACTED]");
    expect(terminal?.type === "done" && terminal.response.content).toBe(streamed);
  });

  it("keeps the default projection for every call that does not ask, whatever the environment", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const events: ModelGatewayLogEvent[] = [];
    const result = await adapter(bufferedResponse(CONTENT), events).call(REQUEST, CONFIG);
    expect(result.content).not.toContain("+49 30 12345678");
    expect(result.content).not.toContain("customer-owned-example");
    expect(dispatchPolicy(events)).toBe(true);
  });

  it("preserves structured customer fields while removing configured credentials", async () => {
    const content = JSON.stringify({
      phone: "+49 30 12345678",
      password: "customer-owned-example",
      provider: CONFIG.apiKey,
    });
    const result = await adapter(bufferedResponse(content)).call(
      { ...PRESERVE, responseFormat: { type: "json_schema", schema: { type: "object" } } },
      CONFIG,
    );
    expect(result.structuredOutput).toEqual({
      phone: "+49 30 12345678",
      password: "customer-owned-example",
      provider: "[REDACTED]",
    });
  });
});

const CAPABILITY: ModelCapability = {
  id: CONFIG.modelId,
  kind: "chat",
  contextWindow: 64_000,
  maxOutputTokens: 4_096,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: false,
  costClass: "medium",
  latencyClass: "standard",
  throughputHint: "fixture",
  preferredUseCases: [],
  knownLimitations: [],
};

const GATEWAY_CONFIG: GatewayConfig = {
  capabilities: [CAPABILITY],
  providers: [CONFIG],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
};

const ANSWER: NormalizedResponse = {
  modelId: CONFIG.modelId,
  content: "answer",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: { requestId: "x", promptTokens: 3, completionTokens: 2, latencyMs: 1, costClass: "low" },
};

function capturingAdapter(seen: GatewayRequest[]): ProviderAdapter {
  return {
    call: (request): Promise<NormalizedResponse> => {
      seen.push(request);
      return Promise.resolve(ANSWER);
    },
    callStream: async function* (request): AsyncGenerator<GatewayStreamChunk> {
      seen.push(request);
      await Promise.resolve();
      yield { type: "delta", token: "answer" };
      yield { type: "done", response: ANSWER };
    },
  };
}

describe("Gateway content policy delivery (#4098)", () => {
  it("hands the explicit Chat preservation to the provider adapter, buffered and streamed", async () => {
    const seen: GatewayRequest[] = [];
    const gateway = new Gateway(GATEWAY_CONFIG, {
      adapter: capturingAdapter(seen),
      clock: createScriptedGatewayClock(),
    });
    await gateway.chat(PRESERVE);
    const streamed: GatewayStreamChunk[] = [];
    for await (const chunk of gateway.chatStream(PRESERVE)) streamed.push(chunk);
    expect(streamed.at(-1)?.type).toBe("done");
    await gateway.chat(REQUEST);
    expect(seen.map((request) => (request as GatewayCallRequest).contentRedaction)).toEqual([
      "preserve",
      "preserve",
      undefined,
    ]);
  });
});
