import type { ModelGatewayLogEvent } from "./observability.js";
import { describe, expect, it, vi } from "vitest";
import { Gateway } from "./gateway.js";
import { createDefaultChatCapability } from "./capabilities.js";
import type {
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
  ProviderAdapter,
  StreamReadBounds,
} from "./types.js";
import {
  GATEWAY_SILENCE_FLOOR_MS,
  providerRequestBudgetMs,
  streamRequestBudgetMs,
} from "./resilience.js";

const config: GatewayConfig = {
  providers: [
    {
      modelId: "fixture",
      baseUrl: "https://fixture.example/v1",
      apiKey: "fixture",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    },
  ],
  capabilities: [
    {
      ...createDefaultChatCapability("fixture"),
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsImageInput: true,
    },
  ],
  circuitBreaker: { failureThreshold: 1, cooldownMs: 1000, halfOpenProbes: 1 },
};
const request: GatewayRequest = {
  modelId: "fixture",
  messages: [{ role: "user", content: "hello" }],
};
const response: NormalizedResponse = {
  modelId: "fixture",
  content: "answer",
  toolCalls: [],
  structuredOutput: null,
  finishReason: "stop",
  usage: {
    requestId: "fixture",
    promptTokens: 1,
    completionTokens: 1,
    latencyMs: 1,
    costClass: "low",
  },
};

async function call(gateway: Gateway, streaming: boolean, input: GatewayRequest): Promise<void> {
  if (streaming) {
    for await (const chunk of gateway.chatStream(input)) expect(chunk).toBeDefined();
  } else await gateway.chat(input);
}

describe("complete gateway admission regressions", () => {
  it.each([false, true])(
    "keeps an unspecified answer limit absent, streaming=%s",
    async (streaming) => {
      const adapterCall = vi.fn<ProviderAdapter["call"]>(() => Promise.resolve(response));
      const gateway = new Gateway(config, { adapter: { call: adapterCall } });
      await call(gateway, streaming, request);
      expect(adapterCall.mock.calls[0]?.[0]).not.toHaveProperty("maxOutputTokens");
    },
  );

  it.each([false, true])(
    "admits a realistic image without tokenizing its base64, streaming=%s",
    async (streaming) => {
      const adapterCall = vi.fn<ProviderAdapter["call"]>(() => Promise.resolve(response));
      const gateway = new Gateway(config, { adapter: { call: adapterCall } });
      await call(gateway, streaming, {
        ...request,
        maxOutputTokens: 8000,
        messages: [
          {
            role: "user",
            content: "describe",
            contentParts: [
              { type: "text", text: "describe" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${Buffer.alloc(1_048_576).toString("base64")}`,
                },
              },
            ],
          },
        ],
      });
      expect(adapterCall).toHaveBeenCalledOnce();
    },
  );
});

it.each([false, true])(
  "checks the open circuit before token-counter traffic, streaming=%s",
  async (streaming) => {
    const { TransportError } = await import("@oscharko-dev/keiko-security/errors/gateway");
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ total_tokens: 1 })),
    );
    const gateway = new Gateway(
      { ...config, providers: config.providers.map((p) => ({ ...p, tokenCounter: "litellm" })) },
      {
        fetchImpl,
        adapter: {
          call: (): Promise<NormalizedResponse> => Promise.reject(new TransportError("fixture")),
        },
      },
    );
    await expect(call(gateway, streaming, request)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(call(gateway, streaming, request)).rejects.toMatchObject({
      code: "GATEWAY_CIRCUIT_OPEN",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "charges counting latency to the attempt budget, streaming=%s",
  async (streaming) => {
    const { GATEWAY_BUFFERED_BUDGET_FLOOR_MS } = await import("./resilience.js");
    let now = 0;
    const adapterCall = vi.fn<ProviderAdapter["call"]>(() => Promise.resolve(response));
    const providers = config.providers.map((p) => ({ ...p, tokenCounter: "litellm" as const }));
    const gateway = new Gateway(
      { ...config, providers },
      {
        clock: {
          now: (): number => now,
          sleep: (ms): Promise<void> => {
            now += ms;
            return Promise.resolve();
          },
        },
        fetchImpl: (): Promise<Response> => {
          now += 4_000;
          return Promise.resolve(Response.json({ total_tokens: 1 }));
        },
        adapter: { call: adapterCall },
      },
    );
    await call(gateway, streaming, request);
    const total = GATEWAY_BUFFERED_BUDGET_FLOOR_MS;
    expect(adapterCall.mock.calls[0]?.[1].timeoutMs).toBe(total - 4_000);
  },
);

it.each([false, true])(
  "charges counting latency to native stream bounds, streaming=%s",
  async (streaming) => {
    let now = 0;
    const bounds: (StreamReadBounds | undefined)[] = [];
    const providers = config.providers.map((p) => ({ ...p, tokenCounter: "litellm" as const }));
    const adapterCall = vi.fn<ProviderAdapter["call"]>(() => Promise.resolve(response));
    const gateway = new Gateway(
      { ...config, providers },
      {
        clock: { now: (): number => now, sleep: (): Promise<void> => Promise.resolve() },
        fetchImpl: (): Promise<Response> => {
          now += 4_000;
          return Promise.resolve(Response.json({ total_tokens: 1 }));
        },
        adapter: {
          call: adapterCall,
          callStream: async function* (
            _input,
            _provider,
            readBounds,
          ): AsyncGenerator<GatewayStreamChunk> {
            bounds.push(readBounds);
            yield { type: "done", response: await Promise.resolve(response) };
          },
        },
      },
    );
    await call(gateway, streaming, request);
    expect(adapterCall).not.toHaveBeenCalled();
    const provider = providers[0];
    if (provider === undefined) throw new TypeError("fixture must configure a provider");
    const total = streaming ? streamRequestBudgetMs(provider) : providerRequestBudgetMs(provider);
    expect(bounds).toEqual([{ budgetMs: total - 4_000, silenceMs: GATEWAY_SILENCE_FLOOR_MS }]);
  },
);

const smallVisionRequest: GatewayRequest = {
  ...request,
  maxOutputTokens: 1024,
  messages: [
    {
      role: "user",
      content: "describe",
      contentParts: [
        { type: "text", text: "describe" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6fcAAAAASUVORK5CYII=",
          },
        },
      ],
    },
  ],
};

describe.each([false, true])("8k vision admission, streaming=%s", (streaming) => {
  it.each([undefined, 0, 100])("admits an image with reported count %s", async (reported) => {
    const events: ModelGatewayLogEvent[] = [];
    const adapterCall = vi.fn<ProviderAdapter["call"]>(() => Promise.resolve(response));
    const gateway = new Gateway(
      {
        ...config,
        capabilities:
          config.capabilities?.map((entry) => ({
            ...entry,
            contextWindow: 8192,
            maxOutputTokens: 1024,
          })) ?? [],
        providers: config.providers.map((entry) => ({
          ...entry,
          ...(reported === undefined ? {} : { tokenCounter: "litellm" as const }),
        })),
      },
      {
        log: {
          write: (event): void => {
            events.push(event);
          },
        },
        adapter: {
          call: adapterCall,
          callStream: async function* (input, provider): AsyncGenerator<GatewayStreamChunk> {
            yield { type: "done", response: await adapterCall(input, provider) };
          },
        },
        fetchImpl: (): Promise<Response> =>
          Promise.resolve(
            Response.json({ total_tokens: reported, tokenizer_type: "openai_tokenizer" }),
          ),
      },
    );
    await call(gateway, streaming, smallVisionRequest);
    expect(adapterCall).toHaveBeenCalledOnce();
    const admission = events.find((event) => event.op === "gateway.prompt.admission");
    if (reported === 100)
      expect(admission?.extra).toMatchObject({
        promptTokens: 100,
        counterSource: "gateway-reported",
      });
    else {
      expect(admission?.extra?.promptTokens).toBeGreaterThan(100);
      expect(admission?.extra?.promptTokens).toBeLessThan(6912);
    }
  });
});
