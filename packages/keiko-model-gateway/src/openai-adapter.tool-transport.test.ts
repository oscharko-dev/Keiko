import { describe, expect, it } from "vitest";
import { openCodeGatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import { GatewayToolCatalogError } from "./toolCatalogBridge.js";
import { Gateway } from "./gateway.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { GatewayRequest, GatewayStreamChunk, ModelProviderConfig } from "./types.js";

const NOW = Date.parse("2026-10-07T00:00:00Z");
const PROVIDER: ModelProviderConfig = {
  modelId: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-key",
  timeoutMs: 30_000,
  maxRetries: 1,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayRequest = {
  modelId: PROVIDER.modelId,
  messages: [{ role: "user", content: "Find the fixture file." }],
  toolCatalog: openCodeGatewayCatalogAdvertisement(NOW),
};
const PRIVATE_ARGUMENT = "private-synthetic-argument-canary";
const RAW_CALL = `<channel>\n<tool_call>keiko_workspace_discover{query:<|">${PRIVATE_ARGUMENT}<|">}<tool_call>`;
const NATIVE_RAW_CALL = `<|tool_call>call:keiko_workspace_discover{query:<|"|>${PRIVATE_ARGUMENT}<|"|>}<tool_call|>`;

function response(content: string, nativeCall = false): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content,
            ...(nativeCall
              ? {
                  tool_calls: [
                    {
                      id: "native-fixture",
                      type: "function",
                      function: {
                        name: "keiko_workspace_discover",
                        arguments: '{"query":"fixture","maxResults":10}',
                      },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: nativeCall ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 7 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function streamResponse(content: string): Response {
  const parts = [content.slice(0, 17), content.slice(17, 32), content.slice(32)];
  const data = parts.map((part) => ({ choices: [{ delta: { content: part } }] }));
  data.push({ choices: [{ delta: { content: "" } }] });
  return new Response(
    data.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":7}}\n\n' +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function adapter(
  content: string,
  streamed = false,
): {
  readonly value: OpenAiAdapter;
  readonly events: ModelGatewayLogEvent[];
} {
  const events: ModelGatewayLogEvent[] = [];
  return {
    value: new OpenAiAdapter({
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(streamed ? streamResponse(content) : response(content)),
      now: (): number => NOW,
      requestId: "transport-fixture",
      costClass: "low",
      log: { write: (event): void => void events.push(event) },
    }),
    events,
  };
}

async function drain(stream: AsyncIterable<GatewayStreamChunk>): Promise<GatewayStreamChunk[]> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("native tool-call transport", () => {
  it("binds a genuine native call even when the answer discusses the serialized format", async () => {
    const value = new OpenAiAdapter({
      fetchImpl: (): Promise<Response> => Promise.resolve(response(RAW_CALL, true)),
      now: (): number => NOW,
      requestId: "native-fixture",
      costClass: "low",
    });
    await expect(value.call(REQUEST, PROVIDER)).resolves.toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ id: "native-fixture", name: "keiko_workspace_discover" }],
    });
  });

  it.each([RAW_CALL, NATIVE_RAW_CALL])(
    "rejects a serialized invocation instead of succeeding",
    async (text) => {
      const { value, events } = adapter(`I will search now.\n${text}`);
      const failure: unknown = await value.call(REQUEST, PROVIDER).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GatewayToolCatalogError);
      expect(failure).toMatchObject({
        reason: "invalid-arguments",
        retryable: true,
        repair: { offeredAlias: "keiko_workspace_discover", transport: "assistant-text" },
        partialUsage: { promptTokens: 30, completionTokens: 7 },
      });
      expect(events.find((event) => event.op === "gateway.tool-catalog.rejected")).toMatchObject({
        extra: { phase: "response", reason: "invalid-arguments", catalogReason: "invalid-shape" },
      });
      expect(JSON.stringify(events)).not.toContain(PRIVATE_ARGUMENT);
      expect(JSON.stringify(failure)).not.toContain(PRIVATE_ARGUMENT);
    },
  );

  it("never emits a successful terminal answer for a fragmented text invocation", async () => {
    const { value, events } = adapter(`I will search now.\n${RAW_CALL}`, true);
    const chunks: GatewayStreamChunk[] = [];
    const failure: unknown = await (async (): Promise<void> => {
      for await (const chunk of value.callStream(REQUEST, PROVIDER)) chunks.push(chunk);
    })().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayToolCatalogError);
    expect(chunks.some((chunk) => chunk.type === "done")).toBe(false);
    expect(events.find((event) => event.op === "chat.response.streamed")?.extra).toMatchObject({
      outcome: "failed",
    });
  });

  it.each([
    `Here is the format: \`${RAW_CALL}\`.`,
    `An example:\n\`\`\`text\n${RAW_CALL}\n\`\`\``,
    `An example:\n~~~text\n${NATIVE_RAW_CALL}\n~~~`,
    "Use keiko_workspace_discover to find files.",
    "<channel><tool_call>unoffered_fixture{query:example}",
  ])("preserves literal examples and ordinary explanations", async (text) => {
    await expect(adapter(text).value.call(REQUEST, PROVIDER)).resolves.toMatchObject({
      content: text,
    });
  });

  it("preserves serialized text when no tool was advertised", async () => {
    await expect(
      adapter(RAW_CALL).value.call({ ...REQUEST, toolCatalog: undefined }, PROVIDER),
    ).resolves.toMatchObject({ content: RAW_CALL });
  });

  it("steers a bounded native-call correction without quoting the rejected arguments", async () => {
    const bodies: string[] = [];
    const events: ModelGatewayLogEvent[] = [];
    const gateway = new Gateway(
      {
        providers: [PROVIDER],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
      },
      {
        clock: { now: (): number => NOW, sleep: (): Promise<void> => Promise.resolve() },
        random: (): number => 0,
        fetchImpl: (_url, init): Promise<Response> => {
          if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body.");
          bodies.push(init.body);
          return Promise.resolve(response(bodies.length === 1 ? RAW_CALL : "corrected"));
        },
        log: { write: (event): void => void events.push(event) },
      },
    );
    const chunks = await drain(gateway.chatStream(REQUEST));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("native function tool_calls");
    expect(bodies[1]).not.toContain(PRIVATE_ARGUMENT);
    expect(chunks.at(-1)).toMatchObject({ type: "done", response: { content: "corrected" } });
    expect(events.some((event) => event.op === "gateway.tool-catalog.repair")).toBe(true);
  });
});
